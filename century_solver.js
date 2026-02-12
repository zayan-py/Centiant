const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const Brain = require('./brain');

(async () => {
    // 1. Load config
    let config = { username: "", password: "" };
    const configPath = path.join(__dirname, 'config.json');
    if (fs.existsSync(configPath)) {
        try {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            console.log('Loaded credentials from config.json');
        } catch (e) {
            console.log('Error reading config.json, using defaults.');
        }
    }

    // 2. Launch Browser with two tabs
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();

    // TAB 1: Dashboard GUI
    const guiPage = await context.newPage();
    const guiFilePath = path.join(__dirname, 'index.html').replace(/\\/g, '/');
    const guiUrl = `file:///${guiFilePath}`;
    console.log(`Loading Dashboard from: ${guiUrl}`);
    await guiPage.goto(guiUrl);

    // TAB 2: Century Tech (Initially Login)
    const centuryPage = await context.newPage();
    await centuryPage.goto('https://app.century.tech/login/');

    // 3. Setup Communication Functions
    // This allows the Dashboard JS to talk to this Node script
    let resolveUrl = null;
    let resolveAnswer = null;
    let lastSolvedQuestion = '';
    let lastLoggedNugget = '';
    let nuggetContext = '';
    let nuggetQueue = [];
    let allScores = [];
    let isSolverRunning = false;

    // 1b. Load Persistent Scores
    const scoresPath = path.join(__dirname, 'scores.csv');
    if (fs.existsSync(scoresPath)) {
        try {
            const data = fs.readFileSync(scoresPath, 'utf8').trim();
            if (data) {
                const lines = data.split('\n');
                allScores = lines.map(line => parseInt(line.trim())).filter(val => !isNaN(val));
                console.log(`[Stats] Loaded History: ${allScores.length} nuggets`);
            }
        } catch (e) {
            console.log('[Stats] Error reading scores.csv');
        }
    }

    // 4. GUI Helper functions
    const updateGuiStatus = async (status, isOnline = true) => {
        await guiPage.evaluate(({ s, online }) => {
            const statusEl = document.getElementById('status-text');
            if (statusEl) statusEl.innerText = s;
            const overlay = document.getElementById('offline-overlay');
            const pulse = document.getElementById('status-pulse');
            if (online) {
                if (overlay) overlay.style.display = 'none';
                if (pulse) pulse.className = 'pulse-ring online';
            } else {
                if (pulse) pulse.className = 'pulse-ring offline';
            }
        }, { s: status, online: isOnline });
    };

    const updateGuiStats = async () => {
        let displayAcc = '--';
        if (allScores.length > 0) {
            const sorted = [...allScores].sort((a, b) => a - b);
            const toRemove = Math.floor(sorted.length * 0.05);
            const filtered = sorted.slice(toRemove);
            const sum = filtered.reduce((a, b) => a + b, 0);
            displayAcc = Math.round(sum / filtered.length);
        }

        await guiPage.evaluate(({ queue, acc }) => {
            const qCount = document.getElementById('queue-count');
            const avgAcc = document.getElementById('avg-accuracy');
            if (qCount) qCount.innerText = queue;
            if (avgAcc) avgAcc.innerText = acc + '%';
        }, { queue: nuggetQueue.length, acc: displayAcc });
    };

    const navigateToNextNugget = async () => {
        if (nuggetQueue.length > 0) {
            const nextUrl = nuggetQueue.shift();
            await updateGuiStatus('LOADING NEXT NUGGET...');

            // Update GUI Queue List visually
            await guiPage.evaluate(() => {
                const list = document.getElementById('queue-list-items');
                if (list && list.children.length > 0) {
                    list.children[0].remove();
                    if (list.children.length > 0) list.children[0].className = 'active';
                }
            });

            await updateGuiStats();
            await centuryPage.goto(nextUrl, { timeout: 60000 });
            lastSolvedQuestion = ''; nuggetContext = '';
            return true;
        }
        return false;
    };

    await guiPage.exposeFunction('startSolver', (url) => {
        nuggetQueue.push(url);
        isSolverRunning = true;
        updateGuiStats();
    });

    await guiPage.exposeFunction('submitAnswerIndex', (index) => {
        if (resolveAnswer) resolveAnswer({ type: 'index', value: index });
    });

    await guiPage.exposeFunction('submitTextAnswer', (text) => {
        if (resolveAnswer) resolveAnswer({ type: 'text', value: text });
    });

    await guiPage.exposeFunction('fetchAssignments', async () => {
        try {
            // First check if we are already on the assignments page to avoid reload
            if (!centuryPage.url().includes('/assignments/due')) {
                await centuryPage.goto('https://app.century.tech/learn/assignments/due', { waitUntil: 'networkidle' });
            }
            const assignments = await centuryPage.evaluate(() => {
                const items = Array.from(document.querySelectorAll('.due-assignments-list__body a'));
                return items.map(a => {
                    const title = a.querySelector('.due-assignments-item__title')?.innerText || 'Untitled';
                    const subject = a.querySelector('[class*="rc-subject-label"]')?.innerText || 'General';
                    const count = a.querySelector('[data-testid="completion-count-label"]')?.innerText || '';
                    return { url: a.href, title, subject, count };
                });
            });
            return assignments;
        } catch (e) {
            console.log('[Scraper] Fetch Error:', e.message);
            return [];
        }
    });

    await guiPage.exposeFunction('startAssignmentFlow', async (assignmentUrl) => {
        try {
            console.log(`[Flow] Starting assignment: ${assignmentUrl}`);
            await updateGuiStatus('SCRAPING NUGGETS...');

            let nuggets = [];
            let attempts = 0;
            const maxAttempts = 3;

            while (attempts < maxAttempts) {
                attempts++;
                console.log(`[Scraper] Attempt ${attempts}/${maxAttempts} for ${assignmentUrl}`);

                if (centuryPage.url() !== assignmentUrl) {
                    await centuryPage.goto(assignmentUrl, { waitUntil: 'load', timeout: 60000 }).catch(() => { });
                }

                // Broad check: Is the page actually "white" (zero content)?
                const isBlank = await centuryPage.evaluate(() => {
                    const text = document.body.innerText.trim();
                    const hasApp = !!document.getElementById('app') || !!document.querySelector('.rc-app-container');
                    const hasElements = document.body.querySelectorAll('div, section, main, header').length > 5;
                    return text.length === 0 && !hasApp && !hasElements;
                });

                if (isBlank) {
                    console.log(`[Scraper] Page appears blank. Refreshing...`);
                    await centuryPage.reload({ waitUntil: 'load' }).catch(() => { });
                    await centuryPage.waitForTimeout(5000); // Allow JS to settle
                }

                nuggets = await centuryPage.evaluate(() => {
                    const items = Array.from(document.querySelectorAll('.rc-nugget-list__item'));
                    const queue = [];
                    items.forEach(item => {
                        const link = item.querySelector('a[data-testid="nugget-link"]');
                        const titleEl = item.querySelector('[data-testid="nugget-title"]');
                        const indicator = item.querySelector('[data-testid="nugget-completion-indicator"]');
                        const ring = item.querySelector('.rc-percentage-ring--completion, .rc-percentage-ring--score');

                        if (link && titleEl) {
                            let score = 0;
                            if (indicator) score = parseInt(indicator.getAttribute('data-score') || '0');
                            else if (ring) score = parseInt(ring.getAttribute('data-score') || '0');

                            if (score < 100) {
                                queue.push({
                                    url: link.href,
                                    title: titleEl.innerText.trim(),
                                    score: score
                                });
                            }
                        }
                    });
                    return queue;
                });

                // If we found nuggets, or if we have tried multiple times and still see nothing, decide what to do.
                // If nuggets > 0, we are good. 
                // If nuggets == 0, but we see the list structure, it might actually be complete.
                const listStructureFound = await centuryPage.$('.rc-nugget-list__list');
                if (nuggets.length > 0) {
                    console.log(`[Scraper] Found ${nuggets.length} nuggets.`);
                    break;
                }

                if (attempts < maxAttempts) {
                    console.log(`[Scraper] No nuggets found yet (Attempt ${attempts}). Waiting 5s before retry...`);
                    await centuryPage.waitForTimeout(5000);
                } else {
                    console.log(`[Scraper] No nuggets found after ${maxAttempts} attempts. Concluding assignment.`);
                }
            }

            nuggetQueue = nuggets.map(n => n.url);
            isSolverRunning = true;

            // Send queue details to GUI (titles)
            await guiPage.evaluate((qs) => {
                window.updateQueueDisplay(qs);
            }, nuggets);

            await updateGuiStats();
            if (nuggetQueue.length === 0) {
                await updateGuiStatus('ALL NUGGETS ALREADY COMPLETED!');
            } else {
                console.log(`[Flow] Assignment started. Queue size: ${nuggetQueue.length}`);
            }

        } catch (e) {
            console.error('[Flow] Error starting assignment:', e);
            await updateGuiStatus('ERROR SCRAPING NUGGETS');
        }
    });


    const pushQuestionToGui = async (questionText, options = []) => {
        await guiPage.evaluate(({ q, opts }) => {
            const qEl = document.getElementById('question-text');
            if (qEl) qEl.innerText = q;
            const container = document.getElementById('options-container');
            const textContainer = document.getElementById('text-answer-container');
            if (!container || !textContainer) return;

            container.innerHTML = '';

            if (opts.length > 0) {
                textContainer.style.display = 'none';
                container.style.display = 'grid';
                opts.forEach((opt, i) => {
                    const btn = document.createElement('button');
                    btn.className = 'option-btn';
                    btn.innerText = `${i + 1}: ${opt}`;
                    btn.onclick = () => window.submitAnswerIndex(i + 1);
                    container.appendChild(btn);
                });
            } else {
                container.style.display = 'none';
                textContainer.style.display = 'block';
            }
        }, { q: questionText, opts: options });
    };

    // 5. Execution Flow
    console.log('Logging in to Century...');
    await updateGuiStatus('LOGGING IN...');
    await centuryPage.fill('input[name="username"]', config.username || 'Zayan123');
    await centuryPage.fill('input[name="password"]', config.password || 'Zayan123');
    await centuryPage.click('button[type="submit"]');

    try {
        await centuryPage.waitForURL('**/learn/**', { timeout: 30000 });
        console.log('Logged in successfully.');
        await updateGuiStatus('AUTO-SCRAPING ASSIGNMENTS...');
        await centuryPage.goto('https://app.century.tech/learn/assignments/due');
        await updateGuiStatus('READY - Check Assignments Panel');
    } catch (e) {
        await updateGuiStatus('LOGIN ERROR - Check config.json');
    }

    // Wait for Dashboard URL Submission
    // Dashboard Interface Handling
    await guiPage.evaluate(() => {
        const fetchBtn = document.getElementById('fetch-btn');
        const list = document.getElementById('assignments-list');

        if (fetchBtn) {
            fetchBtn.onclick = async () => {
                fetchBtn.innerText = 'SCANNING...';
                fetchBtn.disabled = true;
                const tasks = await window.fetchAssignments();

                list.innerHTML = '';
                if (!tasks || tasks.length === 0) {
                    list.innerHTML = '<p class="empty-msg">No due assignments found! Nice job.</p>';
                } else {
                    tasks.forEach(t => {
                        const card = document.createElement('div');
                        card.className = 'assignment-card';
                        card.innerHTML = `
                            <div class="a-info">
                                <span class="a-subject ${t.subject.toLowerCase()}">${t.subject}</span>
                                <h4 class="a-title">${t.title}</h4>
                                <span class="a-count">${t.count}</span>
                            </div>
                            <button class="solve-btn">SOLVE</button>
                        `;
                        card.querySelector('.solve-btn').onclick = (e) => {
                            window.startAssignmentFlow(t.url);
                            e.target.innerText = 'LOADING...';
                            e.target.disabled = true;
                            e.target.style.opacity = '0.5';
                            // Reset others if needed, but for now simple lock
                        };
                        list.appendChild(card);
                    });
                }
                fetchBtn.innerText = 'FETCH DUE TASKS';
                fetchBtn.disabled = false;
            };
        }

        window.updateQueueDisplay = (queueItems) => {
            const queueList = document.getElementById('queue-list-items');
            if (!queueList) return;
            queueList.innerHTML = '';
            if (queueItems.length === 0) {
                queueList.innerHTML = '<li>No nuggets in queue</li>';
            } else {
                queueItems.forEach((item, index) => {
                    const li = document.createElement('li');
                    li.innerText = `${index + 1}. ${item.title}`;
                    li.className = index === 0 ? 'active' : '';
                    queueList.appendChild(li);
                });
            }
            const count = document.getElementById('queue-count');
            if (count) count.innerText = queueItems.length;
        };

        const submitBtn = document.getElementById('submit-text-answer');
        if (submitBtn) {
            submitBtn.onclick = () => {
                const text = document.getElementById('text-answer').value;
                window.submitTextAnswer(text);
            };
        }
    });

    // No longer waiting for a single URL to start - the loop handles queue transitions.
    isSolverRunning = false; // Becomes true when an assignment or nugget is started

    // Helper: Safe Click (Improved for robustness)
    const safeClick = async (element, description = 'Element') => {
        try {
            if (element) {
                await element.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => { });
                try {
                    await element.click({ timeout: 3000 });
                } catch (e) {
                    console.log(`[SafeClick] Normal click failed for ${description}, forcing...`);
                    try {
                        await element.click({ force: true, timeout: 3000 });
                    } catch (e2) {
                        console.log(`[SafeClick] Forced click failed, using evaluate(click)...`);
                        await element.evaluate(el => el.click()).catch(e3 => {
                            console.log(`[SafeClick] Evaluate failed: ${e3.message}`);
                        });
                    }
                }
            }
        } catch (e) {
            console.log(`[SafeClick] Failed to click ${description}: ${e.message}.`);
        }
    };

    // Helper: Safe Drag (For ElementHandle matching)
    const safeDrag = async (source, target) => {
        try {
            if (source && target) {
                // Ensure elements are in view
                await source.scrollIntoViewIfNeeded().catch(() => { });
                await target.scrollIntoViewIfNeeded().catch(() => { });

                const sBox = await source.boundingBox();
                const tBox = await target.boundingBox();

                if (sBox && tBox) {
                    // Move to source center
                    await centuryPage.mouse.move(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
                    await centuryPage.mouse.down();

                    // Wait for grasp to register
                    await centuryPage.waitForTimeout(200);

                    // Small jitter to trigger drag start
                    await centuryPage.mouse.move(sBox.x + sBox.width / 2 + 2, sBox.y + sBox.height / 2 + 2);
                    await centuryPage.waitForTimeout(100);

                    // Slow, deliberate drag to target
                    await centuryPage.mouse.move(tBox.x + tBox.width / 2, tBox.y + tBox.height / 2, { steps: 50 });

                    // Wait before release
                    await centuryPage.waitForTimeout(200);
                    await centuryPage.mouse.up();
                } else {
                    // Fallback to hover + click sequence if bounding box fails
                    await source.hover();
                    await centuryPage.mouse.down();
                    await centuryPage.waitForTimeout(200);
                    await target.hover();
                    await centuryPage.mouse.up();
                }
            }
        } catch (e) {
            console.log(`[SafeDrag] Error: ${e.message}`);
        }
    };

    // 6. Main Interaction Loop



    await guiPage.exposeFunction('forceRefreshState', () => {
        lastSolvedQuestion = '';
        console.log('State Cleared via Refresh');
    });

    await guiPage.evaluate(() => {
        const refreshBtn = document.getElementById('force-refresh');
        if (refreshBtn) {
            refreshBtn.onclick = async () => {
                refreshBtn.style.transform = 'rotate(180deg)';
                await window.forceRefreshState();
                setTimeout(() => refreshBtn.style.transform = 'rotate(0deg)', 300);
            };
        }
    });

    const getDelay = async (type) => {
        const isTurbo = await guiPage.evaluate(() => document.getElementById('turbo-mode')?.checked || false);
        if (isTurbo) return 100;
        switch (type) {
            case 'thinking': return 1500;
            case 'feedback': return 3000;
            case 'nav': return 1000;
            default: return 1000;
        }
    };

    while (true) {
        if (!isSolverRunning && nuggetQueue.length === 0) {
            // If not solving, just scan for assignments or wait
            if (centuryPage.url().includes('/assignments/due')) {
                // Scan for tasks maybe? For now just wait for input
            }
            await centuryPage.waitForTimeout(500);
            continue;
        }

        try {
            let found = null;
            let currentFrame = centuryPage;
            const spinner = await centuryPage.$('.loading-spinner');
            if (spinner && await spinner.isVisible()) {
                await updateGuiStatus('WAITING FOR LOAD...');
                await centuryPage.waitForSelector('.loading-spinner', { state: 'hidden', timeout: 30000 }).catch(() => null);
            }

            // 0. Queue Processing: If we have a queue and aren't in a nugget/question, go to next.
            if (nuggetQueue.length > 0 && !found) {
                const url = centuryPage.url();
                // If we aren't already on a nugget page or results page, navigate
                if (!url.includes('/nugget/') && !url.includes('/learn/course/')) {
                    const nextUrl = nuggetQueue.shift();
                    await updateGuiStats();
                    await updateGuiStatus('STARTING QUEUE...');
                    await centuryPage.goto(nextUrl, { timeout: 60000 });
                    lastSolvedQuestion = ''; nuggetContext = '';
                    continue;
                }
            }

            // Scraper Logic: Passive background scraping when on assignment lists
            if (centuryPage.url().includes('/assignments/')) {
                try {
                    const items = await centuryPage.$$('.rc-nugget-list__item');
                    if (items.length > 0) {
                        for (const item of items) {
                            const link = await item.$('a[data-testid="nugget-link"]');
                            const scoreRing = await item.$('.rc-percentage-ring--score, .rc-percentage-ring--completion');
                            if (link) {
                                const href = await link.getAttribute('href');
                                let score = 100;
                                if (scoreRing) {
                                    score = parseInt(await scoreRing.getAttribute('data-score') || '0');
                                }
                                if (score < 100) {
                                    const fullUrl = 'https://app.century.tech' + href;
                                    if (!nuggetQueue.includes(fullUrl)) nuggetQueue.push(fullUrl);
                                }
                            }
                        }
                        await updateGuiStats();
                    }
                } catch (e) { console.log('[Scraper] Error:', e.message); }
            }

            // Context Detection
            try {
                const titleEl = await centuryPage.$('.page-header-context h1, h1.nugget-title');
                if (titleEl) {
                    const title = (await titleEl.innerText()).trim();
                    if (title && title !== nuggetContext) {
                        nuggetContext = title;
                        console.log(`[Context] Nugget: ${nuggetContext}`);
                    }
                }
            } catch (ignore) { }

            // Scan for active question
            const scan = async (frame) => {
                const candidates = await frame.$$('.rc-multiple-choice-question, .rc-learning-nugget__question-container, .multi-question__question, .rc-learning-question');
                for (const c of candidates) {
                    if (await c.isVisible()) {
                        const isActive = await frame.evaluate(el => {
                            const rect = el.getBoundingClientRect();
                            const vh = window.innerHeight;
                            const vw = window.innerWidth;
                            // Check if element is roughly centered or main focus
                            return Math.abs((rect.left + rect.width / 2) - vw / 2) < vw * 0.4 &&
                                Math.abs((rect.top + rect.height / 2) - vh / 2) < vh * 0.5 &&
                                rect.height > 20;
                        }, c);
                        if (isActive) {
                            // Prefer the actual question text header if found
                            const header = await c.$('.rc-multiple-choice-question__question, .rc-learning-nugget__question-container, h2, h3, .question-text');
                            const t = header ? (await header.innerText()).trim() : (await c.innerText()).trim();
                            const full = (await c.innerText()).trim();
                            if (t.length > 3) return { el: c, text: t, fullText: full };
                        }
                    }
                }
                return null;
            };

            found = await scan(centuryPage);
            if (!found) {
                for (const f of centuryPage.frames()) {
                    found = await scan(f);
                    if (found) { currentFrame = f; break; }
                }
            }

            if (found) {
                // Feedback check: includes 100% completion or submission screens
                const hasFeedbackRef = await found.el.$('.rc-answer-feedback, .rc-multiple-choice-question__explanation, .rc-multiple-choice-question__response, [data-testid="question-response"], .rc-results__score, [class*="completion"]');
                const isFeedback = found.fullText.includes('Correct') ||
                    found.fullText.includes('Incorrect') ||
                    found.fullText.includes('VIEW RESULTS') ||
                    found.fullText.includes('submitted') ||
                    found.fullText.includes('100%') ||
                    found.fullText.includes('Completion') ||
                    !!hasFeedbackRef;

                if (isFeedback) {
                    await updateGuiStatus('FEEDBACK DETECTED');

                    // Accuracy extraction
                    const statsSelectors = ['.cds-stat-value__value', '[data-testid="nugget-score-value"]', '.rc-percentage-ring--score'];
                    let acc = null;
                    for (const sel of statsSelectors) {
                        const elements = await centuryPage.$$(sel);
                        for (const el of elements) {
                            const text = await el.innerText();
                            if (text.includes('%')) {
                                const val = parseInt(text.replace(/\D/g, ''));
                                const parentText = await centuryPage.evaluate(e => e.parentElement?.innerText || '', el);
                                if (parentText.toLowerCase().match(/score|accuracy|correct/)) {
                                    acc = val; break;
                                }
                            }
                        }
                        if (acc !== null) break;
                    }

                    if (acc !== null && !isNaN(acc) && lastLoggedNugget !== nuggetContext) {
                        console.log(`[Stats] Accuracy Recorded: ${acc}%`);
                        allScores.push(acc);
                        fs.appendFileSync(scoresPath, `${acc}\n`);
                        lastLoggedNugget = nuggetContext;
                        await updateGuiStats();
                        await updateGuiStatus('NUGGET COMPLETE!');
                        if (await navigateToNextNugget()) continue;
                    }

                    const nextBtn = await currentFrame.$('button:has-text("Next Nugget"), button:has-text("Next Question"), button:has-text("Next"), button:has-text("View results"), button:has-text("Continue"), [data-testid="next-button"], [data-testid="button-next-question"]');
                    if (nextBtn && await nextBtn.isVisible()) {
                        const btnText = await nextBtn.innerText().catch(() => '');
                        const isNuggetEnd = btnText.toLowerCase().includes('next nugget') ||
                            found.fullText.includes('100%') ||
                            found.fullText.includes('Completion');

                        if (isNuggetEnd) {
                            if (nuggetQueue.length > 0) {
                                if (await navigateToNextNugget()) continue;
                            } else {
                                await updateGuiStatus('ASSIGNMENT COMPLETE!');
                                await centuryPage.waitForTimeout(3000);
                                continue;
                            }
                        }

                        await safeClick(nextBtn, 'Next Button');
                        await centuryPage.waitForTimeout(await getDelay('feedback') / 5);
                    }
                    continue;
                }

                if (found.text === lastSolvedQuestion) {
                    // Even if text is same, if there's a next button, we should click it
                    const nextBtn = await currentFrame.$('[data-testid="button-next-question"], button.btn--secondary:has-text("Next Question")');
                    if (nextBtn && await nextBtn.isVisible()) {
                        await safeClick(nextBtn, 'Immediate Next Button');
                        await centuryPage.waitForTimeout(await getDelay('nav'));
                        continue;
                    }

                    await centuryPage.waitForTimeout(await getDelay('nav'));
                    continue;
                }

                await updateGuiStatus('QUESTION DETECTED');

                // Image Detection
                let imageBase64 = null;
                const hasImage = await currentFrame.$('img:not([alt="icon"]), svg.diagram, .question-image');
                if (hasImage) {
                    try {
                        const container = await currentFrame.$('.rc-learning-nugget__question-container, .multi-question__question') || currentFrame.locator('body');
                        const buffer = await container.screenshot({ scale: 'css' });
                        imageBase64 = buffer.toString('base64');
                        await updateGuiStatus('ANALYZING IMAGE...');
                    } catch (e) { console.log('[Vision] Failed'); }
                }

                // MCQ Detection - Precise & Scoped to Question
                const questionContainer = found.el;
                const optionSelector = [
                    '.rc-multiple-choice-question__answer',
                    '.rc-learning-nugget__answer',
                    '.multi-question__answer',
                    'label.multi-question__answer',
                    '.cds-list-item__content',
                    '[role="radio"]',
                    '[role="checkbox"]',
                    '.answer-option',
                    '.survey-question-radio__label'
                ].join(', ');

                // Scan for options ONLY inside the question container to avoid sidebar/menu noise
                const allPossibleOptions = await questionContainer.$$(optionSelector);
                const optionElements = [];
                const options = [];

                for (let i = 0; i < allPossibleOptions.length; i++) {
                    const opt = allPossibleOptions[i];
                    if (await opt.isVisible()) {
                        let text = (await opt.innerText()).trim();

                        // If no text, check for images or alt text
                        if (text.length === 0) {
                            const img = await opt.$('img');
                            if (img) {
                                const alt = await img.getAttribute('alt');
                                text = alt && alt.length > 5 ? `[Image: ${alt}]` : `[Image Option ${i + 1}]`;
                            }
                        }

                        // We allow options even with limited text if they are visible
                        if (text.length > 0 || await opt.$('img')) {
                            const finalTestText = text || `[Option ${i + 1}]`;
                            if (!options.includes(finalTestText)) {
                                options.push(finalTestText);
                                optionElements.push(opt);
                            }
                        }
                    }
                }

                if (options.length > 0) {
                    console.log(`[MCQ] Detected ${options.length} options: ${options.slice(0, 3).join(', ')}...`);
                }

                // Matching Detection
                const isMatchingText = found.text.match(/Match|Drag|Sort|Convert/i);
                const hasHeaders = await currentFrame.$(':has-text("Prompt")') && await currentFrame.$(':has-text("Answer")');
                const hasMatchingBoard = await currentFrame.$('.alternative-board-matching, [data-testid="matching-question-board"], .rc-prompt-answer-list');
                const targets = await currentFrame.$$('.match-target, .matching-target, [data-testid="match-target"], .prompt-answer-list__item, [data-testid="prompt-answer-pair-field"]');
                const sources = await currentFrame.$$('.match-source, [draggable="true"], .draggable-label-item, .matching-additional-list__item');
                let isMatching = !!hasMatchingBoard || (targets.length > 0 && sources.length > 0) || (isMatchingText && hasHeaders);

                await pushQuestionToGui(found.text, options);

                const isAutoSolve = await guiPage.evaluate(() => document.getElementById('auto-solve')?.checked || false);
                let response = null;

                if (isAutoSolve) {
                    await updateGuiStatus('AI THINKING...');
                    await centuryPage.waitForTimeout(await getDelay('thinking'));

                    if (isMatching) {
                        const targetTexts = []; const sourceTexts = [];
                        const targetElements = []; const sourceElements = [];

                        // Century-specific Prompt/Answer list extraction
                        const matchingRows = await currentFrame.$$('.prompt-answer-list__item, .rc-prompt-answer-pair');
                        if (matchingRows.length > 0) {
                            for (const row of matchingRows) {
                                const fields = await row.$$('.rc-prompt-answer-pair__field, [data-testid="prompt-answer-pair-field"]');
                                if (fields.length >= 2) {
                                    const pText = (await fields[0].innerText()).trim();
                                    if (pText) {
                                        targetTexts.push(pText);
                                        targetElements.push(fields[1]); // The drop destination (Answer field)
                                    }
                                }
                            }
                        }

                        // Fallback to general matching if rows failed or weren't enough
                        if (targetTexts.length === 0) {
                            const robustTargets = await currentFrame.$$('.match-target, div[class*="target"], div[class*="row"], tr');
                            for (let i = 0; i < robustTargets.length; i++) {
                                const el = robustTargets[i];
                                let s = (await el.innerText()).trim();
                                if (!s) {
                                    const img = await el.$('img');
                                    if (img) s = `[Target Image ${i + 1}]`;
                                }
                                if (s) {
                                    targetTexts.push(s);
                                    targetElements.push(el);
                                }
                            }
                        }

                        // Source (Draggable) extraction
                        const robustSources = await currentFrame.$$('[draggable="true"], .draggable-label-item, .matching-additional-list__item, div[class*="draggable"], .co-drag-drop-source');
                        for (let i = 0; i < robustSources.length; i++) {
                            const el = robustSources[i];
                            let txt = (await el.innerText()).trim();
                            if (!txt) {
                                const img = await el.$('img');
                                if (img) txt = `[Source Image ${i + 1}]`;
                            }
                            if (txt && !sourceTexts.includes(txt)) {
                                sourceTexts.push(txt);
                                sourceElements.push(el);
                            }
                        }

                        if (targetTexts.length > 0 && sourceTexts.length > 0) {
                            const pairs = await Brain.solveMatching(targetTexts, sourceTexts, config.openai_api_key, nuggetContext, imageBase64);
                            if (pairs) {
                                // Verification Loop: Retry up to 3 times
                                for (let attempt = 1; attempt <= 3; attempt++) {
                                    let allFilled = true;

                                    for (const [tText, sText] of Object.entries(pairs)) {
                                        try {
                                            // Robust normalization
                                            const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
                                            const tNorm = normalize(tText);
                                            const sNorm = normalize(sText);

                                            const sIdx = sourceTexts.findIndex(st => normalize(st) === sNorm);
                                            const tIdx = targetTexts.findIndex(tt => normalize(tt) === tNorm);

                                            if (sIdx !== -1 && tIdx !== -1) {
                                                const sEl = sourceElements[sIdx];
                                                const tEl = targetElements[tIdx];

                                                // Check if target is already filled (heuristic: has children or text changed)
                                                // For Century, filled targets usually contain the draggable element
                                                const isFilled = await tEl.evaluate(el => el.children.length > 0 || el.innerText.trim().length > 0);

                                                // If it's the first attempt OR it's a retry and the slot is empty
                                                if (attempt === 1 || !isFilled) {
                                                    if (attempt > 1) {
                                                        console.log(`[Matching] Verifying: Slot for "${tText}" is empty. Retrying drag...`);
                                                        allFilled = false;
                                                    }

                                                    if (await sEl.isVisible() && await tEl.isVisible()) {
                                                        await safeDrag(sEl, tEl);
                                                        await centuryPage.waitForTimeout(500);
                                                    }
                                                }
                                            } else {
                                                // Fallback to text matching
                                                const sLoc = currentFrame.getByText(sText, { exact: false }).first();
                                                const tLoc = currentFrame.getByText(tText, { exact: false }).first();
                                                if (await sLoc.isVisible() && await tLoc.isVisible()) {
                                                    await safeDrag(sLoc, tLoc);
                                                    await centuryPage.waitForTimeout(500);
                                                }
                                            }
                                        } catch (e) { console.log('[Matching] Drag Error:', e.message); }
                                    }

                                    // If we are verifying (attempt > 1) and everything is filled, break early
                                    if (attempt > 1 && allFilled) {
                                        console.log('[Matching] Verification successful: All slots filled.');
                                        break;
                                    }

                                    // Wait a bit before verification pass
                                    if (attempt < 3) await centuryPage.waitForTimeout(1000);
                                }

                                const submitBtn = await currentFrame.$('button.btn--secondary:has-text("SUBMIT ANSWER"), button.btn--secondary:has-text("Submit Answer"), [data-testid="button-submit"], button:has-text("SUBMIT ANSWER"), button:has-text("Submit Answer")');
                                if (submitBtn) await safeClick(submitBtn, 'Submit');
                                lastSolvedQuestion = found.text; continue;
                            }
                        }
                    } else {
                        let hasGuppy = !!(await currentFrame.$('.guppy, .guppy_elt, [id*="guppy"]'));
                        response = await Brain.solve(found.text, options, config.openai_api_key, nuggetContext, imageBase64, hasGuppy);
                        if (response) {
                            await updateGuiStatus('AI SOLVED');
                            lastSolvedQuestion = found.text;
                        }
                    }
                } else {
                    response = await new Promise(resolve => { resolveAnswer = resolve; });
                    lastSolvedQuestion = found.text;
                }

                if (response) {
                    if (response.type === 'index') {
                        const idx = response.value - 1;
                        if (optionElements[idx]) {
                            await safeClick(optionElements[idx], `Option ${idx + 1}`);
                            await centuryPage.waitForTimeout(500); // Wait for button to enable
                            const submitBtn = await currentFrame.$('button.btn--secondary:has-text("SUBMIT ANSWER"), button.btn--secondary:has-text("Submit Answer"), [data-testid="button-submit"], button:has-text("SUBMIT ANSWER"), button:has-text("Submit Answer")');
                            if (submitBtn) await safeClick(submitBtn, 'Submit');
                        }
                    } else {
                        // TEXT ANSWER HANDLING
                        console.log(`[Text Mode] Response: "${response.value}"`);

                        // 1. Try Standard Inputs
                        const ti = await currentFrame.$('input[type="text"], input[type="number"], textarea');
                        if (ti && await ti.isVisible()) {
                            await ti.fill(response.value);
                            const submitBtn = await currentFrame.$('button.btn--secondary:has-text("SUBMIT ANSWER"), button.btn--secondary:has-text("Submit Answer"), [data-testid="button-submit"], button:has-text("SUBMIT ANSWER"), button:has-text("Submit Answer")');
                            if (submitBtn) await safeClick(submitBtn, 'Submit');
                        }
                        // 2. Try Guppy Math
                        else if (await currentFrame.$('.guppy, .guppy_elt, [id*="guppy"]')) {
                            const guppies = await currentFrame.$$('.guppy, .guppy_elt, [id*="guppy"]');
                            let guppy = null;
                            for (const g of guppies) {
                                if (await g.isVisible()) { guppy = g; break; }
                            }
                            if (guppy) {
                                await safeClick(guppy, 'Guppy Math Input');
                                await centuryPage.waitForTimeout(500); // Init delay
                                await guppy.focus().catch(() => { });
                                await guppy.evaluate(el => el.focus()).catch(() => { }); // Dual focus strategy
                                await centuryPage.keyboard.type(response.value, { delay: 50 });
                                await centuryPage.keyboard.press('Enter');
                                const submitBtn = await currentFrame.$('button.btn--secondary:has-text("SUBMIT ANSWER"), button.btn--secondary:has-text("Submit Answer"), [data-testid="button-submit"], button:has-text("SUBMIT ANSWER"), button:has-text("Submit Answer")');
                                if (submitBtn) await safeClick(submitBtn, 'Submit');
                            }
                        }
                        // 3. FALLBACK: CLICK BY TEXT
                        // If no inputs found, maybe it's a clickable text option that wasn't detected as an option
                        else {
                            console.log('[Fallback] No inputs found. Attempting to click element by text...');
                            try {
                                const textElement = currentFrame.getByText(response.value, { exact: false }).first();
                                if (await textElement.isVisible()) {
                                    await textElement.click();
                                    await centuryPage.waitForTimeout(500);
                                    const submitBtn = await currentFrame.$('button.btn--secondary:has-text("SUBMIT ANSWER"), button.btn--secondary:has-text("Submit Answer"), [data-testid="button-submit"], button:has-text("SUBMIT ANSWER"), button:has-text("Submit Answer")');
                                    if (submitBtn) await safeClick(submitBtn, 'Submit via Fallback');
                                }
                                else {
                                    console.log('[Fallback] Text element not visible.');
                                }
                            } catch (e) {
                                console.log('[Fallback] Failed to find/click text element:', e.message);
                            }
                        }
                    }
                }

                await centuryPage.waitForTimeout(await getDelay('feedback'));
                const cont = await currentFrame.$('button.btn--secondary:has-text("NEXT QUESTION"), button.btn--secondary:has-text("Next Question"), button.btn--secondary:has-text("CONTINUE"), [data-testid="button-next-question"]');
                if (cont) await safeClick(cont, 'Continue');
                await centuryPage.waitForTimeout(await getDelay('nav'));
            } else {
                // Skips & Results
                const skip = await guiPage.evaluate(() => document.getElementById('skip-lessons')?.checked || false);
                const btn = await centuryPage.$('button.btn--primary:has-text("START"), button.btn--primary:has-text("CONTINUE"), button.btn--secondary:has-text("NEXT"), button.btn--primary:has-text("DONE")');
                if (skip && btn && await btn.isVisible()) {
                    const q = await centuryPage.$('.rc-learning-question, .multi-question__question');
                    if (!q || !(await q.isVisible())) {
                        await updateGuiStatus('SKIPPING LESSON...');
                        await safeClick(btn, 'Skip'); lastSolvedQuestion = '';
                    }
                } else {
                    // 3b. Check for Results/Next Nugget
                    const res = await centuryPage.$('h2:has-text("Results"), .rc-results__score, [class*="results"], button:has-text("Next Nugget"), button:has-text("View results")');
                    if (res && await res.isVisible()) {
                        const btnText = await res.innerText().catch(() => '');
                        // If it's a "View results" button, click it first to get to the actual results screen
                        if (btnText.includes('View results')) {
                            await safeClick(res, 'View Results');
                            await centuryPage.waitForTimeout(2000);
                        }

                        // 1. Log accuracy
                        const scoreEl = await centuryPage.$('.rc-results__score-title, .rc-results__score, [class*="score"]');
                        if (scoreEl) {
                            const scoreText = await scoreEl.innerText().catch(() => '');
                            const match = scoreText.match(/(\d+)%/);
                            if (match) {
                                const scoreVal = parseInt(match[1]);
                                allScores.push(scoreVal);
                                fs.appendFileSync(scoresPath, `${scoreVal}\n`);
                                console.log(`[Stats] Logged Score: ${scoreVal}%`);
                            }
                        }

                        if (nuggetQueue.length > 0) {
                            if (await navigateToNextNugget()) continue;
                        } else {
                            await updateGuiStatus('ASSIGNMENT COMPLETE!');
                        }
                    }
                }
            }
        } catch (e) { console.log('Loop Error:', e.message); }
        await centuryPage.waitForTimeout(100);
    }
})();
