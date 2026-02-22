require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const Brain = require('./brain');

(async () => {
    // 1. Load config
    // Prioritize .env variables, then fallback to config.json
    let config = {
        username: process.env.CENTURY_USERNAME || "",
        password: process.env.CENTURY_PASSWORD || "",
        openai_api_key: process.env.OPENAI_API_KEY || ""
    };

    const configPath = path.join(__dirname, 'config.json');
    if (fs.existsSync(configPath)) {
        try {
            const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            // Only use config.json values if they aren't already set by .env
            if (!config.username && fileConfig.username) config.username = fileConfig.username;
            if (!config.password && fileConfig.password) config.password = fileConfig.password;
            if (!config.openai_api_key && fileConfig.openai_api_key) config.openai_api_key = fileConfig.openai_api_key;

            console.log('Loaded credentials (using .env with config.json fallback)');
        } catch (e) {
            console.log('Error reading config.json, using .env defaults.');
        }
    }

    if (config.openai_api_key) {
        console.log(`[Config] Using API Key ending in: ...${config.openai_api_key.slice(-4)}`);
    } else {
        console.log('[Config] WARNING: No OpenAI API Key found!');
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
    let lastSolvedFingerprint = '';
    let sameQuestionAttempts = 0;
    let questionStartTime = Date.now();
    let hasAttemptedSolve = false;
    let isMatchingQuestion = false;
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
                        const scoreRing = item.querySelector('.rc-percentage-ring--score');
                        const completionRing = item.querySelector('.rc-percentage-ring--completion');

                        if (link && titleEl) {
                            let completionScore = 0;

                            // Get COMPLETION percentage (not score)
                            if (completionRing) completionScore = parseInt(completionRing.getAttribute('data-score') || '0');
                            else if (scoreRing) completionScore = parseInt(scoreRing.getAttribute('data-score') || '0');

                            if (completionScore < 80) {
                                queue.push({
                                    url: link.href,
                                    title: titleEl.innerText.trim(),
                                    completion: completionScore
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
        await updateGuiStatus('READY - Auto-fetching tasks...');
        // Automatically trigger the fetch button in the GUI
        await guiPage.evaluate(() => {
            const btn = document.getElementById('fetch-btn');
            if (btn) btn.click();
        });
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

        const slider = document.getElementById('turbo-slider');
        const display = document.getElementById('turbo-level-display');
        const hint = document.getElementById('turbo-hint');

        if (slider && display && hint) {
            slider.oninput = () => {
                const val = parseInt(slider.value);
                display.innerText = val + 'x';

                if (val === 1) hint.innerText = "Standard speed. Reliable and human-like.";
                else if (val < 5) hint.innerText = "Fast. Good for clearing assignments quickly.";
                else if (val < 10) hint.innerText = "Hyper. Starting to push browser limits.";
                else if (val < 15) hint.innerText = "Sonic. May cause minor UI glitches.";
                else if (val < 20) hint.innerText = "Extreme. Zero-delay execution.";
                else hint.innerText = "MAX TURBO. Absolute maximum software speed.";
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

    // Helper: Batch Drag using Playwright locator.dragTo() for speed
    const executeBatchDrag = async (frame, pairings) => {
        let successCount = 0;
        for (const [targetText, sourceText] of Object.entries(pairings)) {
            try {
                const source = frame.locator('.draggable-label-item', { hasText: sourceText }).first();
                const targetRow = frame.locator('.rc-prompt-answer-pair', { hasText: targetText }).first();
                const dropZone = targetRow.locator('.rc-prompt-answer-pair__field').nth(1);

                // Skip if source not visible (already placed)
                if (!(await source.isVisible({ timeout: 500 }).catch(() => false))) {
                    console.log(`[BatchDrag] Source "${sourceText}" not found/visible, skipping`);
                    continue;
                }

                // Skip if drop zone already filled
                const isFilled = await dropZone.evaluate(el => {
                    const content = el.querySelector('.matching-answer-draggable__content');
                    if (!content) return false;
                    return (content.textContent?.trim().length > 0) || !!content.querySelector('p');
                }).catch(() => false);

                if (isFilled) {
                    console.log(`[BatchDrag] "${targetText}" already filled, skipping`);
                    successCount++;
                    continue;
                }

                console.log(`[BatchDrag] Dragging "${sourceText}" → "${targetText}"`);
                await source.dragTo(dropZone, { force: true });
                successCount++;
            } catch (e) {
                console.log(`[BatchDrag] Failed "${sourceText}" → "${targetText}":`, e.message);
            }
        }
        return successCount;
    };

    // 6. Main Interaction Loop



    await guiPage.exposeFunction('forceRefreshState', () => {
        lastSolvedFingerprint = '';
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
        const turboLevel = await guiPage.evaluate(() => parseInt(document.getElementById('turbo-slider')?.value || '1'));

        // Matching questions no longer need forced slow delays (using locator.dragTo)

        const multiplier = Math.pow(10, -(turboLevel - 1) / 6);

        switch (type) {
            case 'thinking': return Math.max(1, Math.floor(1500 * multiplier));
            case 'feedback': return Math.max(1, Math.floor(3000 * multiplier));
            case 'nav': return Math.max(1, Math.floor(1000 * multiplier));
            default: return Math.max(1, Math.floor(1000 * multiplier));
        }
    };

    const getTurboMultiplier = async () => {
        const turboLevel = await guiPage.evaluate(() => parseInt(document.getElementById('turbo-slider')?.value || '1'));
        // Matching questions now use batch dragTo, no throttle needed
        return Math.pow(10, -(turboLevel - 1) / 6);
    };

    // Navigate to Next Nugget in Queue
    const navigateToNextNugget = async () => {
        if (nuggetQueue.length === 0) {
            console.log('[Queue] No more nuggets in queue.');
            await updateGuiStatus('ALL NUGGETS COMPLETE!');
            isSolverRunning = false;
            return false;
        }

        const nextUrl = nuggetQueue.shift();
        console.log(`[Queue] Moving to next nugget. ${nuggetQueue.length} remaining.`);
        await updateGuiStats();
        await updateGuiStatus('LOADING NEXT NUGGET...');

        try {
            await centuryPage.goto(nextUrl, { waitUntil: 'load', timeout: 60000 });
            lastSolvedFingerprint = '';
            nuggetContext = '';
            sameQuestionAttempts = 0;
            await centuryPage.waitForTimeout(Math.floor(1500 * await getTurboMultiplier()));
            return true;
        } catch (e) {
            console.error('[Queue] Failed to navigate:', e.message);
            return false;
        }
    };

    // Robust Score Extraction
    const getNuggetScore = async (frame) => {
        let acc = null;

        // Priority 1: Look for explicit score value attribute
        const scoreValueEl = await frame.$('[data-score-value]');
        if (scoreValueEl) {
            acc = parseInt(await scoreValueEl.getAttribute('data-score-value') || '0');
            if (!isNaN(acc)) return acc;
        }

        // Priority 2: Score ring with data-score
        const scoreRing = await frame.$('.rc-percentage-ring--score[data-score]');
        if (scoreRing) {
            acc = parseInt(await scoreRing.getAttribute('data-score') || '0');
            if (!isNaN(acc)) return acc;
        }

        // Priority 3: Text search for "Score" or "Accuracy" (NOT "Completion")
        const potentialScores = await frame.$$('.cds-stat-value__value, [data-testid="nugget-score-value"], .rc-results__score, .rc-learning-nugget__score, .rc-results__score-title');
        for (const el of potentialScores) {
            const text = (await el.innerText()).trim();
            if (text.includes('%')) {
                const val = parseInt(text.replace(/\D/g, ''));
                if (!isNaN(val)) {
                    const parentText = await frame.evaluate(e => {
                        let parent = e.parentElement;
                        let combined = '';
                        for (let i = 0; i < 3 && parent; i++) {
                            combined += parent.innerText || '';
                            parent = parent.parentElement;
                        }
                        return combined.toLowerCase();
                    }, el);

                    // CRITICAL: Only match "Score" or "Accuracy", NOT "Completion"
                    if (parentText.match(/\b(score|accuracy|correct|result)\b/) && !parentText.includes('completion')) {
                        return val;
                    }
                }
            }
        }
        return null;
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
            let currentFrame = centuryPage;
            let options = [];
            let optionElements = [];
            let imageBase64 = null;

            // 1. Initial Checks
            const spinner = await centuryPage.$('.loading-spinner');
            if (spinner && await spinner.isVisible()) {
                await updateGuiStatus('WAITING FOR LOAD...');
                await centuryPage.waitForSelector('.loading-spinner', { state: 'hidden', timeout: 30000 }).catch(() => null);
            }

            // 2. Context Detection
            try {
                const titleEl = await centuryPage.$('.page-header-context h1, h1.nugget-title, .learning-nugget-header-title, [class*="nugget-title"]');
                if (titleEl && await titleEl.isVisible()) {
                    const title = (await titleEl.innerText()).trim();
                    if (title && title !== nuggetContext) {
                        nuggetContext = title;
                        console.log(`[Context] Nugget: ${nuggetContext}`);
                    }
                } else if (!nuggetContext) {
                    // Fallback to URL if title is missing
                    const urlPart = centuryPage.url().split('/').pop();
                    if (urlPart && urlPart.length > 10) {
                        nuggetContext = `Nugget_${urlPart.slice(0, 8)}`;
                    }
                }
            } catch (ignore) { }

            // 3. Scan for active question
            const scan = async (frame) => {
                const candidates = await frame.$$('.rc-multiple-choice-question, .rc-learning-nugget__question-container, .multi-question__question, .rc-learning-question');
                for (const c of candidates) {
                    if (await c.isVisible()) {
                        const isActive = await frame.evaluate(el => {
                            const rect = el.getBoundingClientRect();
                            const vh = window.innerHeight;
                            const vw = window.innerWidth;
                            return Math.abs((rect.left + rect.width / 2) - vw / 2) < vw * 0.4 &&
                                Math.abs((rect.top + rect.height / 2) - vh / 2) < vh * 0.5 &&
                                rect.height > 20;
                        }, c);
                        if (isActive) {
                            const header = await c.$('.rc-multiple-choice-question__question, .rc-learning-nugget__question-container, h2, h3, .question-text');
                            const t = header ? (await header.innerText()).trim() : (await c.innerText()).trim();
                            const full = (await c.innerText()).trim();
                            if (t.length > 3) return { el: c, text: t, fullText: full };
                        }
                    }
                }
                return null;
            };

            let found = await scan(centuryPage);
            if (!found) {
                for (const f of centuryPage.frames()) {
                    found = await scan(f);
                    if (found) { currentFrame = f; break; }
                }
            }

            // Scraper Logic: Passive background scraping when on assignment lists
            if (centuryPage.url().includes('/assignments/')) {
                try {
                    const items = await centuryPage.$$('.rc-nugget-list__item');
                    if (items.length > 0) {
                        for (const item of items) {
                            const link = await item.$('a[data-testid="nugget-link"]');
                            const completionRing = await item.$('.rc-percentage-ring--completion');
                            const scoreRing = await item.$('.rc-percentage-ring--score');

                            if (link) {
                                const href = await link.getAttribute('href');
                                let completionScore = 100;
                                if (completionRing) {
                                    completionScore = parseInt(await completionRing.getAttribute('data-score') || '0');
                                } else if (scoreRing) {
                                    completionScore = parseInt(await scoreRing.getAttribute('data-score') || '0');
                                }

                                if (completionScore < 80) {
                                    const fullUrl = 'https://app.century.tech' + href;
                                    if (!nuggetQueue.includes(fullUrl)) {
                                        nuggetQueue.push(fullUrl);
                                        await updateGuiStats();
                                    }
                                }
                            }
                        }
                        await updateGuiStats();
                    }
                } catch (e) { console.log('[Scraper] Error:', e.message); }
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
                    found.fullText.includes('Feedback') ||
                    !!hasFeedbackRef;

                if (isFeedback) {
                    await updateGuiStatus('FEEDBACK DETECTED');

                    // 1. Prioritize score logging BEFORE overlay dismissal
                    let acc = await getNuggetScore(currentFrame);
                    if (!acc) acc = await getNuggetScore(centuryPage); // Fallback to main page

                    if (acc !== null && !isNaN(acc)) {
                        if (lastLoggedNugget !== nuggetContext) {
                            console.log(`[Stats] Accuracy Recorded: ${acc}%`);
                            allScores.push(acc);
                            fs.appendFileSync(scoresPath, `${acc}\n`);
                            lastLoggedNugget = nuggetContext;
                            await updateGuiStats();
                            await updateGuiStatus('NUGGET COMPLETE!');
                        }

                        // JUMP ON SCORE
                        if (nuggetQueue.length > 0) {
                            console.log('[Flow] Score captured. Jumping to next nugget...');
                            if (await navigateToNextNugget()) continue;
                        }
                    }

                    // 2. Dismiss common overlays ONLY if we haven't already logged a score/jumped
                    const overlays = await currentFrame.$$('.rc-modal, .cds-modal, .rc-answer-feedback__popup, h2:has-text("submitted"), h1:has-text("submitted")');
                    if (overlays.length > 0 && !acc) {
                        console.log('[Feedback] Dismissing submitted/feedback overlay...');
                        await centuryPage.mouse.click(10, 10);
                        await centuryPage.waitForTimeout(Math.floor(500 * await getTurboMultiplier()));
                    }

                    const nextBtn = await currentFrame.$('button:has-text("Next Nugget"), button:has-text("NEXT NUGGET"), button:has-text("Next Question"), button:has-text("NEXT QUESTION"), button:has-text("Next"), button:has-text("NEXT"), button:has-text("View results"), button:has-text("Continue"), [data-testid="next-button"], [data-testid="button-next-question"]');
                    if (nextBtn && await nextBtn.isVisible()) {
                        const btnText = (await nextBtn.innerText().catch(() => '')).toLowerCase();
                        const isNuggetEnd = btnText.includes('next nugget') ||
                            found.fullText.includes('100%') ||
                            found.fullText.includes('Completion');

                        if (isNuggetEnd) {
                            if (nuggetQueue.length > 0) {
                                if (await navigateToNextNugget()) continue;
                            } else {
                                // FINAL FEEDBACK SCREEN - All nuggets done
                                console.log('[Complete] All nuggets finished. Stopping solver.');
                                await updateGuiStatus('🎉 ASSIGNMENT COMPLETE! All nuggets finished.');
                                isSolverRunning = false;
                                await centuryPage.waitForTimeout(2000);
                                await centuryPage.goto('https://app.century.tech/learn/assignments/due').catch(() => { });
                                continue; // Return to top of loop to wait in idle state
                            }
                        }

                        await safeClick(nextBtn, 'Next Button');
                        await centuryPage.waitForTimeout(await getDelay('nav'));
                    }
                    continue;
                }

                await updateGuiStatus('QUESTION DETECTED');

                // Image Detection
                imageBase64 = null;
                const hasImage = await currentFrame.$('img:not([alt="icon"]), svg.diagram, .question-image');
                if (hasImage) {
                    try {
                        // Priority: Label Board -> Question Container -> Body
                        const labelBoard = await currentFrame.$('[data-testid="labelling-question-board"], .rc-label-pair-list');
                        const container = labelBoard || await currentFrame.$('.rc-learning-nugget__question-container, .multi-question__question') || currentFrame.locator('body');

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
                optionElements = [];
                options = [];

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

                const currentFingerprint = found.text + options.join('|');

                if (currentFingerprint === lastSolvedFingerprint) {
                    sameQuestionAttempts++;
                    const timeSpentOnQuestion = (Date.now() - questionStartTime) / 1000; // in seconds

                    // Log only every 10 attempts to reduce noise, unless time is high
                    if (sameQuestionAttempts % 10 === 0 || timeSpentOnQuestion > 5) {
                        console.log(`[Flow] Same question detected (Attempt ${sameQuestionAttempts}, ${timeSpentOnQuestion.toFixed(1)}s elapsed)`);
                    }

                    // Scaled threshold: High Turbo needs more attempts due to loop speed
                    const turboLevel = await guiPage.evaluate(() => parseInt(document.getElementById('turbo-slider')?.value || '1'));
                    const baseThreshold = hasAttemptedSolve ? 30 : 15;
                    const threshold = baseThreshold * (turboLevel / 2);
                    const hardTimeout = isMatchingQuestion ? 180 : 60; // 3 mins matching, 60s standard (reduced from 90s)

                    if (sameQuestionAttempts > threshold || timeSpentOnQuestion > hardTimeout) {
                        console.log(`[Flow] STUCK DETECTED (${sameQuestionAttempts} attempts, ${timeSpentOnQuestion.toFixed(1)}s). Attempting to skip...`);
                        await updateGuiStatus('STUCK - SKIPPING...');

                        const idkBtn = await currentFrame.$('button:has-text("I don\'t know"), button:has-text("I Don\'t Know"), [data-testid="idk-button"]');
                        if (idkBtn && await idkBtn.isVisible()) {
                            await safeClick(idkBtn, "I Don't Know Button");
                            await centuryPage.waitForTimeout(await getDelay('nav'));
                            sameQuestionAttempts = 0;
                            questionStartTime = Date.now();
                            hasAttemptedSolve = false;
                            lastSolvedFingerprint = ''; // Reset to prevent loop
                            continue;
                        }
                    }

                    const nextBtn = await currentFrame.$('[data-testid="button-next-question"], button.btn--secondary:has-text("Next Question")');
                    if (nextBtn && await nextBtn.isVisible()) {
                        await safeClick(nextBtn, 'Immediate Next Button');
                        await centuryPage.waitForTimeout(1000); // 1s cooldown even in Turbo
                        continue;
                    }

                    await centuryPage.waitForTimeout(await getDelay('nav'));
                    continue;
                } else {
                    sameQuestionAttempts = 0; // New question, reset counter
                    questionStartTime = Date.now();
                    hasAttemptedSolve = false;
                    isMatchingQuestion = false; // Reset matching flag
                }

                // Matching Detection
                const isMatchingText = found.text.match(/Match|Drag|Sort|Convert/i);
                const hasHeaders = await currentFrame.$(':has-text("Prompt")') && await currentFrame.$(':has-text("Answer")');
                const hasMatchingBoard = await currentFrame.$('.alternative-board-matching, [data-testid="matching-question-board"], .rc-prompt-answer-list');
                const hasLabelPairs = await currentFrame.$('.rc-label-pair-list, [data-testid="labelling-question-board"]');
                const targets = await currentFrame.$$('.match-target, .matching-target, [data-testid="match-target"], .prompt-answer-list__item, [data-testid="prompt-answer-pair-field"], .rc-label-pair-list__item');
                const sources = await currentFrame.$$('.match-source, [draggable="true"], .draggable-label-item, .matching-additional-list__item, .rc-label-pair-base__field');
                let isMatching = !!hasMatchingBoard || !!hasLabelPairs || (targets.length > 0 && sources.length > 0) || (isMatchingText && hasHeaders);
                if (isMatching) isMatchingQuestion = true;

                await pushQuestionToGui(found.text, options);

                const isAutoSolve = await guiPage.evaluate(() => document.getElementById('auto-solve')?.checked || false);
                let response = null;

                if (isAutoSolve) {
                    await updateGuiStatus('AI THINKING...');
                    await centuryPage.waitForTimeout(await getDelay('thinking'));

                    if (isMatching) {
                        // 1. Fast DOM scrape: extract all target labels and source texts
                        let targetTexts = await currentFrame.evaluate(() => {
                            return [...document.querySelectorAll('.rc-prompt-answer-pair')].map(row => {
                                const fields = row.querySelectorAll('.rc-prompt-answer-pair__field');
                                return fields[0]?.innerText?.trim() || '';
                            }).filter(Boolean);
                        });

                        let sourceTexts = await currentFrame.evaluate(() => {
                            return [...document.querySelectorAll('.draggable-label-item[draggable="true"]')].map(el => {
                                return el.innerText?.trim() || '';
                            }).filter(Boolean);
                        });

                        // Fallback: Label Pair List layout
                        if (targetTexts.length === 0) {
                            targetTexts = await currentFrame.evaluate(() => {
                                return [...document.querySelectorAll('.rc-label-pair-list__item')].map((item, i) => {
                                    return item.innerText?.trim() || `[Target Card ${i + 1}]`;
                                });
                            });
                        }

                        // Fallback: Generic matching layout
                        if (targetTexts.length === 0) {
                            targetTexts = await currentFrame.evaluate(() => {
                                return [...document.querySelectorAll('.match-target, div[class*="target"]')].map((el, i) => {
                                    return el.innerText?.trim() || `[Target ${i + 1}]`;
                                }).filter(Boolean);
                            });
                        }

                        // Fallback: Broader source selectors
                        if (sourceTexts.length === 0) {
                            sourceTexts = await currentFrame.evaluate(() => {
                                const seen = new Set();
                                return [...document.querySelectorAll('[draggable="true"], .draggable-label-item, .matching-additional-list__item, div[class*="draggable"], .co-drag-drop-source')].map(el => {
                                    const txt = el.innerText?.trim() || '';
                                    if (txt && !seen.has(txt)) { seen.add(txt); return txt; }
                                    return '';
                                }).filter(Boolean);
                            });
                        }

                        if (targetTexts.length > 0 && sourceTexts.length > 0) {
                            const turboLevel = await guiPage.evaluate(() => parseInt(document.getElementById('turbo-slider')?.value || '1'));
                            const brainModel = turboLevel > 10 ? 'gpt-4o-mini' : 'gpt-4o';

                            const pairs = await Brain.solveMatching(targetTexts, sourceTexts, config.openai_api_key, nuggetContext, imageBase64, brainModel);
                            if (pairs) {
                                console.log(`[Matching] Batch processing ${Object.keys(pairs).length} pairs...`);

                                // 2. Execute all drags in one fast batch
                                const filled = await executeBatchDrag(currentFrame, pairs);

                                // 3. Instant DOM verification
                                const allFilled = await currentFrame.evaluate(() => {
                                    const rows = document.querySelectorAll('.rc-prompt-answer-pair');
                                    if (rows.length === 0) return true; // Non-standard layout, trust the drag
                                    return [...rows].every(row => {
                                        const dropZone = row.querySelectorAll('.rc-prompt-answer-pair__field')[1];
                                        if (!dropZone) return true;
                                        const content = dropZone.querySelector('.matching-answer-draggable__content');
                                        return content && (content.textContent?.trim().length > 0 || !!content.querySelector('p'));
                                    });
                                });

                                if (allFilled) {
                                    console.log(`[Matching] ✓ All ${filled} pairs verified`);
                                } else {
                                    console.log(`[Matching] ⚠ Some pairs may need retry, running second pass...`);
                                    await executeBatchDrag(currentFrame, pairs);
                                }

                                const submitBtn = await currentFrame.$('button.btn--secondary:has-text("SUBMIT ANSWER"), button.btn--secondary:has-text("Submit Answer"), [data-testid="button-submit"], button:has-text("SUBMIT ANSWER"), button:has-text("Submit Answer")');
                                if (submitBtn) await safeClick(submitBtn, 'Submit');
                                lastSolvedFingerprint = currentFingerprint; continue;
                            }
                        }
                    } else {
                        let hasGuppy = !!(await currentFrame.$('.guppy, .guppy_elt, [id*="guppy"]'));
                        const turboLevel = await guiPage.evaluate(() => parseInt(document.getElementById('turbo-slider')?.value || '1'));
                        const brainModel = turboLevel > 10 ? 'gpt-4o-mini' : 'gpt-4o';

                        response = await Brain.solve(found.text, options, config.openai_api_key, nuggetContext, imageBase64, hasGuppy, brainModel);
                        if (response) {
                            await updateGuiStatus('AI SOLVED');
                            lastSolvedFingerprint = currentFingerprint;
                            hasAttemptedSolve = true;
                        }
                    }
                } else {
                    response = await new Promise(resolve => { resolveAnswer = resolve; });
                    lastSolvedFingerprint = currentFingerprint;
                }

                if (response) {
                    if (response.type === 'index') {
                        const idx = response.value - 1;
                        if (optionElements[idx]) {
                            await safeClick(optionElements[idx], `Option ${idx + 1}`);
                            await centuryPage.waitForTimeout(Math.floor(500 * await getTurboMultiplier()));
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
                        // 1.5. Try Dropdowns / Selects
                        else if (await currentFrame.$('select, .rc-dropdown, .rc-dropdown__toggle, [data-testid="dropdown-trigger"], [role="combobox"], .rc-select')) {
                            const dropdown = await currentFrame.$('select, .rc-dropdown, .rc-dropdown__toggle, [data-testid="dropdown-trigger"], [role="combobox"], .rc-select');
                            if (dropdown && await dropdown.isVisible()) {
                                console.log('[Text Mode] Dropdown detected. Attempting interaction...');
                                const tagName = await dropdown.evaluate(el => el.tagName.toLowerCase());

                                if (tagName === 'select') {
                                    // Standard <select>
                                    await dropdown.selectOption({ label: response.value }).catch(() => dropdown.selectOption({ value: response.value })).catch(() => { });
                                } else {
                                    // Custom Dropdown (click to open, then select)
                                    await safeClick(dropdown, 'Dropdown Trigger');
                                    await centuryPage.waitForTimeout(Math.floor(500 * await getTurboMultiplier()));

                                    // Try exact match first
                                    const option = currentFrame.getByText(response.value, { exact: true }).first();
                                    if (await option.isVisible()) {
                                        await option.click();
                                    } else {
                                        // Case-insensitive fallback
                                        const optionCi = currentFrame.getByText(response.value, { exact: false }).first();
                                        if (await optionCi.isVisible()) await optionCi.click();
                                    }
                                }
                                await centuryPage.waitForTimeout(Math.floor(500 * await getTurboMultiplier()));
                                const submitBtn = await currentFrame.$('button.btn--secondary:has-text("SUBMIT ANSWER"), button.btn--secondary:has-text("Submit Answer"), [data-testid="button-submit"], button:has-text("SUBMIT ANSWER"), button:has-text("Submit Answer")');
                                if (submitBtn) await safeClick(submitBtn, 'Submit');
                            }
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
                                await centuryPage.waitForTimeout(Math.floor(500 * await getTurboMultiplier())); // Init delay
                                await guppy.focus().catch(() => { });
                                await guppy.evaluate(el => el.focus()).catch(() => { }); // Dual focus strategy
                                await centuryPage.keyboard.type(response.value, { delay: 50 });
                                await centuryPage.keyboard.press('Enter');
                                const submitBtn = await currentFrame.$('button.btn--secondary:has-text("SUBMIT ANSWER"), button.btn--secondary:has-text("Submit Answer"), [data-testid="button-submit"], button:has-text("SUBMIT ANSWER"), button:has-text("Submit Answer")');
                                if (submitBtn) await safeClick(submitBtn, 'Submit');
                            }
                        }
                        // 3. FALLBACK: CLICK BY TEXT
                        else {
                            console.log('[Fallback] No inputs found. Attempting to click element by text...');
                            try {
                                const textElement = currentFrame.getByText(response.value, { exact: false }).first();
                                if (await textElement.isVisible()) {
                                    await textElement.click();
                                    await centuryPage.waitForTimeout(Math.floor(500 * await getTurboMultiplier()));
                                    const submitBtn = await currentFrame.$('button.btn--secondary:has-text("SUBMIT ANSWER"), button.btn--secondary:has-text("Submit Answer"), [data-testid="button-submit"], button:has-text("SUBMIT ANSWER"), button:has-text("Submit Answer")');
                                    if (submitBtn) await safeClick(submitBtn, 'Submit via Fallback');
                                } else {
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
                // NOT FOUND: Skips & Results
                const skip = await guiPage.evaluate(() => document.getElementById('skip-lessons')?.checked || false);
                const btn = await centuryPage.$('button.btn--primary:has-text("START"), button.btn--primary:has-text("CONTINUE"), button.btn--secondary:has-text("NEXT"), button.btn--primary:has-text("DONE")');

                if (skip && btn && await btn.isVisible()) {
                    const q = await centuryPage.$('.rc-learning-question, .multi-question__question');
                    if (!q || !(await q.isVisible())) {
                        await updateGuiStatus('SKIPPING LESSON...');
                        await safeClick(btn, 'Skip'); lastSolvedFingerprint = '';
                    }
                } else {
                    // Check for Results/Next Nugget
                    const res = await centuryPage.$('h2:has-text("Results"), .rc-results__score, [class*="results"], button:has-text("Next Nugget"), button:has-text("View results")');
                    if (res && await res.isVisible()) {
                        const btnText = (await res.innerText().catch(() => '')).toLowerCase();
                        if (btnText.includes('view results')) {
                            await safeClick(res, 'View Results');
                            await centuryPage.waitForTimeout(Math.floor(2000 * await getTurboMultiplier()));
                        }

                        // Log accuracy
                        const scoreVal = await getNuggetScore(centuryPage);
                        if (scoreVal !== null && !isNaN(scoreVal)) {
                            if (lastLoggedNugget !== nuggetContext) {
                                allScores.push(scoreVal);
                                fs.appendFileSync(scoresPath, `${scoreVal}\n`);
                                console.log(`[Stats] Logged Score: ${scoreVal}%`);
                                lastLoggedNugget = nuggetContext;
                                await updateGuiStats();
                            }

                            // JUMP ON SCORE
                            if (nuggetQueue.length > 0) {
                                console.log('[Flow] Results screen detected. Jumping to next nugget...');
                                if (await navigateToNextNugget()) continue;
                            } else {
                                console.log('[Complete] Assignment finished.');
                                await updateGuiStatus('🎉 ASSIGNMENT COMPLETE!');
                                isSolverRunning = false;
                                await centuryPage.waitForTimeout(Math.floor(3000 * await getTurboMultiplier()));
                                await centuryPage.goto('https://app.century.tech/learn/assignments/due').catch(() => { });
                            }
                        }
                    }
                }

                // FINAL FALLBACK: Start the queue only if we are strictly on the assignment page
                const url = centuryPage.url();
                if (!found && nuggetQueue.length > 0 && url.includes('/assignments/due')) {
                    console.log('[Flow] On assignment page with pending queue. Starting first nugget...');
                    await navigateToNextNugget();
                }
            }
        } catch (e) {
            console.log('Loop Error:', e.message);
        }
        await centuryPage.waitForTimeout(100);
    }
})();
