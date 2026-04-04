const { launchBrowser, login } = require('./common');
const fs = require('fs');
const path = require('path');
const Brain = require('./brain');

(async () => {
    // 1. Load config from .env (required)
    const config = {
        username: process.env.CENTURY_USERNAME || "",
        password: process.env.CENTURY_PASSWORD || "",
        openai_api_key: process.env.OPENAI_API_KEY || ""
    };

    if (config.openai_api_key) {
        console.log(`[Config] Using API Key ending in: ...${config.openai_api_key.slice(-4)}`);
    } else {
        console.log('[Config] WARNING: No OpenAI API Key found in .env!');
    }

    // 2. Launch Browser
    const { browser, context } = await launchBrowser();
    const isHeadless = process.env.HEADLESS !== 'false';

    // --- STEALTH: TIME WARP OVERCLOCKER ---
    // This script hijacks the browser's internal clock and timers to fool Century's servers.
    // 1. Speeds up Date.now() and performance.now() by 10x.
    // 2. Intercepts setInterval and setTimeout to speed up the heartbeat frequency.
    // 3. Ensures 'msSinceLastPing' is calculated correctly based on the warped time.
    await context.addInitScript(() => {
        const SPEED_X = 10; // 10x Speed: 1 minute real = 10 minutes Century
        const startTime = Date.now();
        const startPerf = performance.now();

        // 1. Warp Date and Performance
        const origDateNow = Date.now;
        Date.now = function () {
            return startTime + (origDateNow.call(Date) - startTime) * SPEED_X;
        };
        const origPerfNow = performance.now;
        performance.now = function () {
            return startPerf + (origPerfNow.call(performance) - startPerf) * SPEED_X;
        };

        // 2. Warp Timers (Forces more frequent Heartbeats)
        const origSetTimeout = window.setTimeout;
        window.setTimeout = function (fn, delay, ...args) {
            return origSetTimeout.call(window, fn, delay / SPEED_X, ...args);
        };
        const origSetInterval = window.setInterval;
        window.setInterval = function (fn, delay, ...args) {
            return origSetInterval.call(window, fn, delay / SPEED_X, ...args);
        };

        // 3. Intercept Fetch to maintain consistency
        const originalFetch = window.fetch;
        window.fetch = function (...args) {
            const url = args[0];
            if (typeof url === 'string' && (url.includes('pings/focus') || url.includes('pings'))) {
                try {
                    const options = args[1];
                    if (options && options.body) {
                        const body = JSON.parse(options.body);
                        if (body.msSinceLastPing) {
                            // The server might cap msSinceLastPing, but since we've speed up the 
                            // frequency of pings, we'll send many more of them.
                        }
                    }
                } catch (e) { }
            }
            return originalFetch.apply(this, args);
        };
        console.log(`[TimeWarp] Active: 1s real = ${SPEED_X}s spoofed.`);
    });

    // TAB 1: Dashboard GUI
    const guiPage = await context.newPage();
    const guiFilePath = path.join(__dirname, 'gui', 'index.html').replace(/\\/g, '/');
    const guiUrl = `file:///${guiFilePath}`;
    console.log(`Loading Dashboard from: ${guiUrl}`);
    await guiPage.goto(guiUrl);

    // TAB 2: Century Tech (Initially Login)
    const centuryPage = await context.newPage();

    // Communication & State
    let resolveUrl = null;
    let resolveAnswer = null;
    let lastSolvedFingerprint = '';
    let sameQuestionAttempts = 0;
    let questionStartTime = Date.now();
    let hasAttemptedSolve = false;
    let isMatchingQuestion = false;
    let lastLoggedNugget = '';
    let nuggetContext = ''
    let nuggetQueue = [];
    let totalNuggetsInQueue = 0;
    let completedNuggets = 0;
    let allScores = [];
    let isSolverRunning = false;
    let lastActivityTime = Date.now();   // Stale page watchdog
    let sessionStartTime = Date.now();   // For session report

    // Support Bot input: If a nugget URL is passed via process.argv[2]
    const initialNugget = process.argv[2];
    if (initialNugget) {
        console.log(`[Bot] Targets received. Populating queue...`);
        const targets = initialNugget.split(',');
        for (const t of targets) {
            const trimmedT = t.trim();
            if (!trimmedT) continue;
            const fullUrl = trimmedT.startsWith('http') ? trimmedT : `https://app.century.tech${trimmedT.startsWith('/') ? '' : '/'}${trimmedT}`;
            nuggetQueue.push(fullUrl);
        }
        totalNuggetsInQueue = nuggetQueue.length;
        completedNuggets = 0;
        isSolverRunning = true;
    }

    console.log("STATUS:Connecting to Century website...");
    let isTerminating = false;

    // --- INTERACTIVE COMMANDS ---
    process.stdin.on('data', async (data) => {
        const cmd = data.toString().trim().toUpperCase();
        if (cmd === 'SKIP') {
            console.log('[Remote] Received SKIP command');
            const idkBtn = await centuryPage.$('button:has-text("I don\'t know"), button:has-text("I Don\'t Know"), [data-testid="idk-button"], button:has-text("skip")');
            if (idkBtn) await safeClick(idkBtn);
        } else if (cmd === 'TERMINATE') {
            console.log('[Remote] Received TERMINATE command. Shutting down...');
            isTerminating = true;
            await browser.close().catch(() => { });
            process.exit(0);
        }
    });

    // --- HEARTBEAT & TIME STATS ---
    setInterval(() => {
        if (!isSolverRunning || isTerminating) return;
        const totalElapsed = Math.round((Date.now() - sessionStartTime) / 1000);
        const questionElapsed = Math.round((Date.now() - questionStartTime) / 1000);
        const spoofedTotal = totalElapsed * 10; // Match the SPEED_X in addInitScript
        console.log(`STATUS: TIME|total=${totalElapsed}|spoofed=${spoofedTotal}|q=${questionElapsed}`);
    }, 10000);
    // Bot auto-login
    if (config.username && config.password) {
        await login(centuryPage, config.username, config.password);
    }

    // If we have an initial nugget, jump to it immediately after login
    if (nuggetQueue.length > 0) {
        console.log("STATUS:Jumping to requested nugget...");
        const nextTarget = nuggetQueue[0];
        nuggetQueue.shift(); // Remove from queue
        await centuryPage.goto(nextTarget, { waitUntil: 'load' }).catch(() => { });
        console.log("STATUS:Arrived at nugget page. Scanning...");
    } else {
        // GUI MODE STARTUP: Landing flow
        console.log('Logging in to Century...');
        await updateGuiStatus('LOGGING IN...');

        // Only attempt navigation to due page if not already there (auto-login might have put us in /learn/)
        const currentUrl = centuryPage.url();
        if (!currentUrl.includes('/learn/assignments/due')) {
            await updateGuiStatus('AUTO-SCRAPING ASSIGNMENTS...');
            await centuryPage.goto('https://app.century.tech/learn/assignments/due').catch(() => { });
        }

        await updateGuiStatus('READY - Auto-fetching tasks...');
        // Automatically trigger the fetch button in the GUI
        await guiPage.evaluate(() => {
            const btn = document.getElementById('fetch-btn');
            if (btn) btn.click();
        });
        await updateGuiStatus('READY - Check Assignments Panel');
    }

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


    // Helper: Hybrid Click — handles React synthetic events + raw browser events
    const safeClick = async (locator) => {
        if (!locator) return;
        try {
            // 1. Try React-friendly synthetic click first
            const clicked = await locator.evaluate(el => {
                if (el) { el.click(); return true; }
                return false;
            });
            if (!clicked) return;

            // 2. Dispatch native mouse event as fallback for non-React listeners
            await locator.evaluate(el => {
                el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            });
        } catch (e) {
            // 3. Final Playwright force-click fallback
            await locator.click({ force: true, timeout: 2000 }).catch(() => { });
        }
    };

    // Helper: Global Forceful Slide-Skip (Recursive Shadow DOM search)
    const forceNextSlide = async (page) => {
        const allFrames = [page, ...page.frames()];
        const results = await Promise.all(allFrames.map(frame =>
            frame.evaluate(() => {
                const findElementAnywhere = (root, selector) => {
                    const el = root.querySelector(selector);
                    if (el) return el;
                    const hosts = root.querySelectorAll('*');
                    for (const host of hosts) {
                        if (host.shadowRoot) {
                            const found = findElementAnywhere(host.shadowRoot, selector);
                            if (found) return found;
                        }
                    }
                    return null;
                };

                const btn = findElementAnywhere(document, '[data-testid="button-next-slide"]') ||
                    findElementAnywhere(document, '[data-testid="button-next-question"]') ||
                    findElementAnywhere(document, '.btn-icon--nextIcon') ||
                    findElementAnywhere(document, 'button[aria-label="Next slide"]') ||
                    findElementAnywhere(document, 'button[aria-label="Next"]');

                if (btn) {
                    console.log("[JS-Context] Found slide button, executing click.");
                    btn.click();
                    return true;
                }
                return false;
            }).catch(() => false)
        ));
        return results.some(r => r === true);
    };

    // Helper: Deduplicated score logger
    const logScore = async (acc, timeStr = null) => {
        if (acc !== null && !isNaN(acc) && lastLoggedNugget !== nuggetContext) {
            console.log(`[Stats] Accuracy Recorded: ${acc}%${timeStr ? ` | Time Recorded: ${timeStr}` : ''}`);
            // BOT SYNC: Output special progress token
            console.log(`PROGRESS: SCORE:${acc}${timeStr ? `|TIME:${timeStr}` : ''}`);
            allScores.push(acc);
            fs.appendFileSync(scoresPath, `${acc}\n`);
            lastLoggedNugget = nuggetContext;
            lastActivityTime = Date.now(); // Activity: nugget finished
            await updateGuiStats();
        }
    };

    // Helper: Deep text normalization (collapses whitespace/newlines)
    const cleanText = (str) => (str || '').replace(/\s+/g, ' ').trim().toLowerCase();

    // Helper: Alphanumeric-only version for aggressive fuzzy matching (strips Unicode/formulas)
    const alphaNum = (str) => cleanText(str).replace(/[^\x20-\x7E]/g, '').replace(/[^a-z0-9]/g, '');

    const executeSequentialDrag = async (frame, pairings) => {
        // Guard: already submitted? 
        const isSubmitted = await frame.$('.rc-prompt-answer-list--submitted, .matching-submitted-pairs, .assessment-slide--submitted').then(el => !!el).catch(() => false);
        if (isSubmitted) {
            console.log('[SeqDrag] Board already submitted — skipping');
            return 0;
        }

        let successCount = 0;

        // ── Layout A: Label-Pair-List (image-based targets / Matching v2) ─────
        const labelPairRows = frame.locator('.rc-label-pair-list__item');
        const lpCount = await labelPairRows.count().catch(() => 0);
        if (lpCount > 0) {
            console.log(`[SeqDrag] Layout A: Matching v2 detected — Processing ${lpCount} image/card targets...`);
            const pairKeys = Object.keys(pairings);
            const availableSources = []; // Track sources already dragged (prevents cross-row swapping)
            for (let i = 0; i < lpCount; i++) {
                try {
                    const targetName = `Card ${i + 1}`;
                    const cardKey = pairKeys.find(k => {
                        const cleanK = cleanText(k);
                        const cleanT = cleanText(targetName);
                        return cleanK === cleanT || cleanK === `${i + 1}` || cleanK === `[target card ${i + 1}]` || cleanK.endsWith(` ${i + 1}`);
                    });

                    if (!cardKey) {
                        console.log(`[SeqDrag] No pairing provided for ${targetName} — skipping`);
                        continue;
                    }

                    const expectedSource = pairings[cardKey] ? cleanText(pairings[cardKey]) : null;
                    if (!expectedSource) continue;

                    const targetRow = labelPairRows.nth(i);
                    const dropZone = targetRow.locator('.click-select-drop, .rc-label-pair-base__field--empty, [class*="drop"]').first();

                    // Skip if already CORRECT (not just filled)
                    const currentText = cleanText(await dropZone.innerText().catch(() => ''));
                    // Strict text check + check if it actually contains a draggable (to be double sure)
                    const hasDraggable = await dropZone.locator('[draggable="true"]').count().catch(() => 0) > 0;
                    if (hasDraggable && currentText === expectedSource) {
                        console.log(`[SeqDrag] Card ${i + 1} already correct ("${expectedSource}") — skipping`);
                        availableSources.push(expectedSource); // Mark as used
                        successCount++;
                        continue;
                    }

                    // 1. First attempt: Find source in the "Additional Answers" dock (available pool)
                    // Skip any source already claimed by a prior row
                    const dockDraggables = await frame.locator('.draggable-label-container [draggable="true"]').all();
                    let sourceEl = null;
                    for (const d of dockDraggables) {
                        const txt = cleanText(await d.innerText().catch(() => ''));
                        if (availableSources.includes(txt)) continue; // Already used
                        const matches = txt === expectedSource || txt.includes(expectedSource) || expectedSource.includes(txt)
                            || (alphaNum(txt) && alphaNum(txt) === alphaNum(expectedSource)); // Unicode fallback
                        if (matches) {
                            const isVis = await d.isVisible().catch(() => false);
                            if (isVis) { sourceEl = d; break; }
                        }
                    }

                    // 2. Fallback: Any draggable element with matching text (not placed in a target card)
                    if (!sourceEl) {
                        const allDraggables = await frame.locator('[draggable="true"]').all();
                        for (const d of allDraggables) {
                            const txt = cleanText(await d.innerText().catch(() => ''));
                            if (availableSources.includes(txt)) continue; // Already used
                            const isPlaced = await d.evaluate(el => !!el.closest('.rc-label-pair-list__item')).catch(() => false);
                            if (isPlaced) continue;
                            const matches = txt === expectedSource || txt.includes(expectedSource) || expectedSource.includes(txt)
                                || (alphaNum(txt) && alphaNum(txt) === alphaNum(expectedSource)); // Unicode fallback
                            if (matches) { sourceEl = d; break; }
                        }
                    }

                    if (sourceEl) {
                        console.log(`[SeqDrag] Card ${i + 1}: Dragging "${expectedSource}"`);
                        await dropZone.scrollIntoViewIfNeeded().catch(() => { });
                        await sourceEl.dragTo(dropZone, { force: true, noWaitAfter: true, timeout: 1500 });
                        await frame.waitForTimeout(150); // Minimal settle time for DOM update
                        availableSources.push(expectedSource); // Mark as used
                        successCount++;
                    } else {
                        console.log(`[SeqDrag] Card ${i + 1}: Could not find source "${expectedSource}"`);
                    }
                } catch (e) { console.log(`[SeqDrag] Layout A Row ${i} Error:`, e.message); }
            }

            let filledCount = 0;
            for (let i = 0; i < lpCount; i++) {
                const filled = await labelPairRows.nth(i).locator('.click-select-drop, .rc-label-pair-base__field--empty, [class*="drop"]').first()
                    .locator('[draggable="true"]').count().catch(() => 0) > 0;
                if (filled) filledCount++;
            }
            return filledCount;
        }

        // ── Layout B: Standard matching rows (v1 & v2 variations) ─────────
        const rows = frame.locator('.prompt-answer-list__item, .rc-prompt-answer-pair');
        const rowCount = await rows.count().catch(() => 0);

        if (rowCount > 0) {
            console.log(`[SeqDrag] Found ${rowCount} rows — processing sequentially...`);
            const availableSources = []; // Track sources already dragged (prevents cross-row swapping)
            for (let i = 0; i < rowCount; i++) {
                try {
                    const row = rows.nth(i);

                    // 1. Read label text
                    const labelText = cleanText(
                        await row.locator('.rc-prompt-answer-pair__field').first()
                            .innerText().catch(() => '')
                    );

                    if (i === 0) console.log(`[SeqDrag] Row 0 Target Identified as: "${labelText}"`);

                    // 2. Fuzzy match pairing (Aggressive: strip symbols/arrows for comparison)
                    const pairingKey = Object.keys(pairings).find(k => {
                        const cleanK = cleanText(k).replace(/[^a-z0-9]/g, '');
                        const cleanL = labelText.replace(/[^a-z0-9]/g, '');
                        return cleanK.length > 0 && cleanL.length > 0 &&
                            (cleanK.includes(cleanL) || cleanL.includes(cleanK) || cleanK === cleanL);
                    });

                    const expectedSource = pairingKey ? cleanText(pairings[pairingKey]) : null;
                    if (!expectedSource) {
                        console.log(`[SeqDrag] Row ${i}: No pairing found for "${labelText}" (Mismatch?)`);
                        continue;
                    }

                    // 3. Check if already CORRECT (not just filled)
                    const answerSlot = row.locator('.rc-prompt-answer-pair__field').nth(1);
                    const currentText = cleanText(await answerSlot.innerText().catch(() => ''));
                    // Strict text check + check if it actually contains a draggable
                    const hasDraggable = await answerSlot.locator('[draggable="true"]').count().catch(() => 0) > 0;
                    if (hasDraggable && currentText === expectedSource) {
                        console.log(`[SeqDrag] Row ${i} already correct ("${expectedSource}") — skipping`);
                        availableSources.push(expectedSource); // Mark as used
                        continue;
                    }

                    // 4. Find source: First attempt in the "Additional Answers" dock
                    // Skip any source already claimed by a prior row
                    const dockDraggables = await frame.locator('.draggable-label-container [draggable="true"]').all();
                    let sourceEl = null;
                    for (const src of dockDraggables) {
                        const txt = cleanText(await src.innerText().catch(() => ''));
                        if (availableSources.includes(txt)) continue; // Already used
                        const matches = txt === expectedSource || txt.includes(expectedSource) || expectedSource.includes(txt)
                            || (alphaNum(txt) && alphaNum(txt) === alphaNum(expectedSource)); // Unicode fallback
                        if (matches) {
                            const isVis = await src.isVisible().catch(() => false);
                            if (isVis) { sourceEl = src; break; }
                        }
                    }

                    // Fallback: Any draggable element with matching text (not placed in a target slot)
                    if (!sourceEl) {
                        const allSources = await frame.locator('[draggable="true"]').all();
                        for (const src of allSources) {
                            const txt = cleanText(await src.innerText().catch(() => ''));
                            if (availableSources.includes(txt)) continue; // Already used
                            const isPlaced = await src.evaluate(el => {
                                const field = el.closest('.rc-prompt-answer-pair__field');
                                if (!field) return false;
                                const fields = [...field.parentElement.querySelectorAll('.rc-prompt-answer-pair__field')];
                                return fields.indexOf(field) === 1;
                            }).catch(() => false);
                            if (isPlaced) continue;
                            const matches = txt === expectedSource || txt.includes(expectedSource) || expectedSource.includes(txt)
                                || (alphaNum(txt) && alphaNum(txt) === alphaNum(expectedSource)); // Unicode fallback
                            if (matches) { sourceEl = src; break; }
                        }
                    }

                    if (sourceEl) {
                        console.log(`[SeqDrag] Row ${i}: Dragging "${expectedSource}" to "${labelText}"`);
                        // Scroll to target first to ensure it's in the interactive area
                        await answerSlot.scrollIntoViewIfNeeded().catch(() => { });
                        await sourceEl.dragTo(answerSlot, { force: true, noWaitAfter: true, timeout: 1500 });
                        await frame.waitForTimeout(150); // Minimal settle time for DOM update
                        availableSources.push(expectedSource); // Mark as used
                    } else {
                        console.log(`[SeqDrag] Row ${i}: Could not find source "${expectedSource}" anywhere`);
                    }
                } catch (e) { console.log(`[SeqDrag] Layout B Row ${i} Error:`, e.message); }
            }

            let filledCount = 0;
            for (let i = 0; i < rowCount; i++) {
                const isFilledInUi = await rows.nth(i).locator('.rc-prompt-answer-pair__field').nth(1).evaluate(slot => {
                    const draggable = slot.querySelector('[draggable="true"]');
                    return draggable && (draggable.innerText.trim().length > 0 || !!draggable.querySelector('img'));
                }).catch(() => false);
                if (isFilledInUi) filledCount++;
            }
            return filledCount;
        }

        return 0;
    };


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
                        const link = item.querySelector('a[data-testid="nugget-link"], a[data-testid="smart-nugget-link"]');
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
            totalNuggetsInQueue = nuggetQueue.length;
            completedNuggets = 0;
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

    // 5. Execution Flow handled in startup block above

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

        const turboToggle = document.getElementById('turbo-toggle');
        const hint = document.getElementById('turbo-hint');

        if (turboToggle && hint) {
            // Initialize display state for Turbo Mode (since we set 'checked' in HTML)
            if (turboToggle.checked) {
                hint.innerText = "MAX TURBO. Absolute maximum software speed.";
                hint.style.color = "#ff4d4d";
            }

            turboToggle.onchange = () => {
                const isMax = turboToggle.checked;
                hint.innerText = isMax
                    ? "MAX TURBO. Absolute maximum software speed."
                    : "Standard speed. Reliable and human-like.";
                hint.style.color = isMax ? "#ff4d4d" : "#888";
            };
        }
    });

    // No longer waiting for a single URL to start - the loop handles queue transitions.
    if (!initialNugget) {
        isSolverRunning = false; // Becomes true when an assignment or nugget is started
    }



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

    const getTurboMultiplier = async () => {
        const isTurbo = await guiPage.evaluate(() => document.getElementById('turbo-toggle')?.checked || false);
        return isTurbo ? 0.01 : 1.0;
    };

    const getDelay = async (type) => {
        const multiplier = await getTurboMultiplier();
        switch (type) {
            case 'thinking': return Math.max(1, Math.floor(200 * multiplier));
            case 'feedback': return Math.max(1, Math.floor(500 * multiplier));
            case 'nav': return Math.max(1, Math.floor(300 * multiplier));
            default: return Math.max(1, Math.floor(300 * multiplier));
        }
    };

    // Session Summary & Auto-Terminate
    const terminateSession = async () => {
        const elapsed = Math.round((Date.now() - sessionStartTime) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        const avgAcc = allScores.length > 0
            ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length)
            : 0;

        const report = `✅ SESSION COMPLETE\n${allScores.length} nuggets | Avg Accuracy: ${avgAcc}% | Time: ${mins}m ${secs}s`;
        console.log(`\n[Session] ${report}`);
        await updateGuiStatus(report);

        // Show report in GUI
        await guiPage.evaluate((msg) => {
            const el = document.getElementById('question-text');
            if (el) el.innerText = msg;
        }, report).catch(() => { });

        await centuryPage.waitForTimeout(3000);
        await browser.close();
        process.exit(0);
    };

    // Navigate to Next Nugget in Queue
    const navigateToNextNugget = async () => {
        if (nuggetQueue.length === 0) {
            console.log('[Queue] No more nuggets in queue. Terminating session...');
            await terminateSession();
            return false;
        }

        completedNuggets++;
        const nextUrl = nuggetQueue.shift();
        console.log(`[Queue] Moving to next nugget (${completedNuggets}/${totalNuggetsInQueue}). ${nuggetQueue.length} remaining.`);
        // BOT SYNC: Output special progress token
        console.log(`PROGRESS: NEXT_NUGGET:${completedNuggets}/${totalNuggetsInQueue}`);
        await updateGuiStats();
        await updateGuiStatus(`LOADING NUGGET ${completedNuggets}/${totalNuggetsInQueue}...`);

        // Reset state for the new nugget
        lastSolvedFingerprint = '';
        questionStartTime = Date.now();
        hasAttemptedSolve = false;
        sameQuestionAttempts = 0;

        // Feature 6: Auto-retry navigation up to 3 times
        let navSuccess = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                await centuryPage.goto(nextUrl, { waitUntil: 'load', timeout: 60000 });
                navSuccess = true;
                break;
            } catch (e) {
                console.warn(`[Queue] Navigation attempt ${attempt}/3 failed: ${e.message}`);
                if (attempt < 3) {
                    await centuryPage.waitForTimeout(5000);
                }
            }
        }

        if (!navSuccess) {
            console.error('[Queue] All 3 navigation attempts failed. Skipping nugget.');
            return nuggetQueue.length > 0 ? navigateToNextNugget() : false;
        }

        lastSolvedFingerprint = '';
        nuggetContext = '';
        sameQuestionAttempts = 0;
        questionStartTime = Date.now();
        lastActivityTime = Date.now();
        await centuryPage.waitForTimeout(Math.floor(1500 * await getTurboMultiplier()));
        return true;
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

    // Robust Time/Duration Extraction
    const getNuggetDuration = async (frame) => {
        try {
            // Century usually has stats like "Time taken: 05:22" or "Time taken: 2m 15s"
            const potentialTimeEls = await frame.$$('.cds-stat-value__value, [data-testid*="time"], .rc-results__stat-value, .rc-results__score-value');
            for (const el of potentialTimeEls) {
                const text = (await el.innerText()).trim();
                // Look for patterns: 05:22 or 2m 15s or 1 minute
                if (text.match(/^\d+:\d+$/) || text.match(/\d+m\s*\d+s/) || text.match(/\d+\s*min/)) {
                    const contextText = await frame.evaluate(e => {
                        let p = e.parentElement;
                        let combined = (p ? (p.innerText || '') : '').toLowerCase();
                        if (p && p.parentElement) combined += ' ' + (p.parentElement.innerText || '').toLowerCase();
                        return combined;
                    }, el);

                    if (contextText.includes('time') || contextText.includes('took') || contextText.includes('duration')) {
                        return text;
                    }
                }
            }
        } catch (e) { }
        return null;
    };

    let firstLoop = true;
    while (true) {
        if (!isSolverRunning && nuggetQueue.length === 0) {
            await centuryPage.waitForTimeout(1000);
            continue;
        }

        if (firstLoop) {
            if (isTerminating) break;
            console.log("STATUS:Engine active. Detecting question...");
            firstLoop = false;
        }

        let currentFrame = centuryPage;
        let found = false;
        try {
            let options = [];
            let optionElements = [];
            let imageBase64 = null;

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

            found = await scan(centuryPage);
            if (!found) {
                for (const f of centuryPage.frames()) {
                    const fFound = await scan(f);
                    if (fFound) { found = fFound; currentFrame = f; break; }
                }
            }

            if (!found) {
                // If no question found, check for blue "Next" arrows (Slideshows) or results screens
                console.log("STATUS:Engine active. No question visible, checking for navigation...");

                // === PRIMARY SKIP: Results/End Screens (Forceful Dispatch) ===
                // Includes "Next Question", "Next Nugget", and Slideshow arrows
                if (await forceNextSlide(centuryPage)) {
                    console.log("[Flow] Force-Skip: Navigation triggered via Global Dispatcher.");

                    // Termination watchdog: if this skip leads to lesson end and queue is empty
                    if (nuggetQueue.length === 0) {
                        const isEnd = await centuryPage.evaluate(() => {
                            const txt = (document.body.innerText || '').toLowerCase();
                            return txt.includes('thank you') || txt.includes('completion');
                        });
                        if (isEnd) {
                            console.log('[Complete] Force-Skip reached lesson end. Terminating queue.');
                            await terminateSession();
                            break;
                        }
                    }
                    await centuryPage.waitForTimeout(500);
                    continue;
                }

                // Final wait before retry if absolutely nothing found
                await centuryPage.waitForTimeout(1000);
                continue;
            }

            // If we found something, update activity
            lastActivityTime = Date.now();
            // We only reset questionStartTime in the fingerprint check below if it's new
            console.log(`STATUS:Question identified. Thinking...`);

            // --- REDUNDANCY: Feature 3 — Stale Page Watchdog ---
            // If no meaningful progress in 2 minutes while solver is running, reload
            if (isSolverRunning && (Date.now() - lastActivityTime) > 120000) {
                console.warn('[Watchdog] No activity for 2 minutes. Reloading page...');
                lastActivityTime = Date.now();
                await centuryPage.reload({ waitUntil: 'load' }).catch(() => { });
                await centuryPage.waitForTimeout(3000);
                continue;
            }

            // --- REDUNDANCY: Feature 1 — Stuck Question Hard Timeout (1.5m / 90s) ---
            const timeOnQuestion = Date.now() - questionStartTime;
            if (isSolverRunning && timeOnQuestion > 90000) {
                console.warn(`[Timeout] Stuck on question for ${Math.round(timeOnQuestion / 1000)}s. Pressing I Don't Know...`);
                // Use broad IDK selector
                const idkBtn = await currentFrame.$('button:has-text("I don\'t know"), button:has-text("I Don\'t Know"), [data-testid="idk-button"], button:has-text("skip")').catch(() => null);
                if (idkBtn && await idkBtn.isVisible()) {
                    await safeClick(idkBtn);
                    await centuryPage.waitForTimeout(1500);
                } else {
                    // If no IDK button, try to force a reload as a last resort
                    console.warn('[Timeout] No IDK button found. Reloading...');
                    await centuryPage.reload().catch(() => { });
                }
                lastSolvedFingerprint = '';
                sameQuestionAttempts = 0;
                questionStartTime = Date.now();
                lastActivityTime = Date.now();
                hasAttemptedSolve = false;
                continue;
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


            // --- PRIORITY 1: Immediate Question/Nugget Navigation ---
            // If a "Next Question" or "Next Nugget" button is visible, we click it immediately.
            const urgentNextBtn = await currentFrame.$([
                'button[data-testid="button-next-question"]',
                'button:has-text("Next Question")',
                'button:has-text("NEXT QUESTION")',
                'button:has-text("Next Nugget")',
                'button:has-text("NEXT NUGGET")',
                '.rc-results button.btn--primary',
                '.rc-results button.btn--secondary',
                'button:has-text("Continue")'
            ].join(', '));

            if (urgentNextBtn && await urgentNextBtn.isVisible()) {
                const btnText = (await urgentNextBtn.innerText().catch(() => '')).toLowerCase();

                // IGNORE dashboard/sidebar links like "My Path"
                const cleanBtnText = cleanText(btnText);
                if (cleanBtnText.includes('my path') || cleanBtnText.includes('dashboard') || cleanBtnText.includes('back to') || cleanBtnText === 'path') {
                    // Do nothing, proceed to standard scan
                } else {
                    console.log(`[Flow] Urgent Navigation detected ("${btnText.split('\n')[0]}") - clicking...`);

                    if (btnText.includes('next nugget')) {
                        // Try to log score before jumping
                        let acc = await getNuggetScore(currentFrame);
                        if (!acc) acc = await getNuggetScore(centuryPage);
                        await logScore(acc);

                        if (nuggetQueue.length > 0) {
                            console.log('[Flow] Next Nugget button detected. Jumping queue...');
                            if (await navigateToNextNugget()) continue;
                        } else {
                            // IF QUEUE IS EMPTY: Stop here and let the results detection handle termination
                            console.log('[Flow] Next Nugget detected but queue is empty. Stopping navigation.');
                            continue;
                        }
                    }

                    // Brute force click via JS evaluation for maximum reliability
                    await urgentNextBtn.evaluate(el => el.click()).catch(() => { });
                    await safeClick(urgentNextBtn);

                    lastSolvedFingerprint = '';
                    sameQuestionAttempts = 0;
                    await centuryPage.waitForTimeout(100); // Minimal settle
                    continue;
                }
            }

            // Scraper Logic: Passive background scraping when on assignment lists
            if (centuryPage.url().includes('/assignments/')) {
                try {
                    const items = await centuryPage.$$('.rc-nugget-list__item');
                    if (items.length > 0) {
                        for (const item of items) {
                            const link = await item.$('a[data-testid="nugget-link"], a[data-testid="smart-nugget-link"]');
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
                    found.fullText.toLowerCase().includes('thank you') ||
                    found.fullText.toLowerCase().includes('completing') ||
                    found.fullText.toLowerCase().includes('diagnostic') ||
                    !!hasFeedbackRef;

                if (isFeedback) {
                    await updateGuiStatus('FEEDBACK DETECTED');
                    hasAttemptedSolve = true; // Mark as solved since we've seen feedback

                    // 1. Prioritize score logging BEFORE overlay dismissal
                    let acc = await getNuggetScore(currentFrame);
                    if (!acc) acc = await getNuggetScore(centuryPage); // Fallback to main page

                    await logScore(acc);
                    if (acc !== null && !isNaN(acc)) {
                        await updateGuiStatus('NUGGET COMPLETE!');
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
                    }

                    const nextBtn = await currentFrame.$('button:has-text("Next Nugget"), button:has-text("NEXT NUGGET"), button:has-text("Next Question"), button:has-text("NEXT QUESTION"), button:has-text("Next"), button:has-text("NEXT"), button:has-text("View results"), button:has-text("Continue"), [data-testid="next-button"], [data-testid="button-next-question"]');
                    if (nextBtn && await nextBtn.isVisible()) {
                        const btnText = (await nextBtn.innerText().catch(() => '')).toLowerCase();
                        const isNuggetEnd = btnText.includes('next nugget') ||
                            found.fullText.includes('100%') ||
                            found.fullText.includes('Completion') ||
                            found.fullText.includes('Thank you for completing the diagnostic');

                        if (isNuggetEnd) {
                            if (nuggetQueue.length > 0) {
                                if (await navigateToNextNugget()) continue;
                            } else {
                                // FINAL FEEDBACK SCREEN - All nuggets done
                                console.log('[Complete] All nuggets finished. Triggering session report.');
                                await terminateSession();
                                break;
                            }
                        }

                        await safeClick(nextBtn);
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

                        const buffer = await centuryPage.screenshot({ scale: 'css' });
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
                    const timeSpentOnQuestion = (Date.now() - questionStartTime) / 1000;

                    // If we've already tried to solve this exact fingerprint once, don't ask the AI again. 
                    // This prevents infinite matching loops.
                    if (hasAttemptedSolve) {
                        if (sameQuestionAttempts % 20 === 0) console.log(`[Flow] Waiting for manual input or Next button (Attempt ${sameQuestionAttempts})...`);
                        await centuryPage.waitForTimeout(1000);
                        continue;
                    }

                    // Log only every 10 attempts to reduce noise, unless time is high
                    if (sameQuestionAttempts % 10 === 0 || timeSpentOnQuestion > 5) {
                        console.log(`[Flow] Same question detected (Attempt ${sameQuestionAttempts}, ${timeSpentOnQuestion.toFixed(1)}s elapsed)`);
                    }

                    // Scaled threshold: High Turbo needs more attempts due to loop speed
                    const turboLevel = await guiPage.evaluate(() => parseInt(document.getElementById('turbo-slider')?.value || '1'));
                    const baseThreshold = hasAttemptedSolve ? 30 : 15;
                    const threshold = baseThreshold * (turboLevel / 2);
                    const hardTimeout = isMatchingQuestion ? 180 : 60; // 3 mins matching, 60s standard (reduced from 90s)

                    if (sameQuestionAttempts > 5 && sameQuestionAttempts % 5 === 0) {
                        console.log(`[Flow] Persistent Fingerprint Detect (${sameQuestionAttempts} attempts). Hard Refreshing...`);
                        await centuryPage.reload().catch(() => { });
                        await centuryPage.waitForTimeout(3000);
                        continue;
                    }

                    if (sameQuestionAttempts > threshold || timeSpentOnQuestion > hardTimeout) {
                        console.log(`[Flow] STUCK DETECTED (${sameQuestionAttempts} attempts, ${timeSpentOnQuestion.toFixed(1)}s). Attempting to skip...`);
                        await updateGuiStatus('STUCK - SKIPPING...');

                        const idkBtn = await currentFrame.$('button:has-text("I don\'t know"), button:has-text("I Don\'t Know"), [data-testid="idk-button"]');
                        if (idkBtn && await idkBtn.isVisible()) {
                            await safeClick(idkBtn);
                            sameQuestionAttempts = 0;
                            questionStartTime = Date.now();
                            hasAttemptedSolve = false;
                            lastSolvedFingerprint = ''; // Reset to prevent loop
                            continue;
                        }
                    }

                    const nextBtn = await currentFrame.$('[data-testid="button-next-question"], button.btn--secondary:has-text("Next Question")');
                    if (nextBtn && await nextBtn.isVisible()) {
                        await safeClick(nextBtn);
                        continue;
                    }

                    await centuryPage.waitForTimeout(await getDelay('nav'));
                    continue;
                } else {
                    sameQuestionAttempts = 0; // New question, reset counter
                    questionStartTime = Date.now(); // START TIMER for new question
                    lastActivityTime = Date.now(); // Reset stale watchdog
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
                    // One-shot solve: don't call AI again if we already have for this question
                    if (hasAttemptedSolve && currentFingerprint === lastSolvedFingerprint) {
                        await centuryPage.waitForTimeout(1000);
                        continue;
                    }

                    console.log(`STATUS:Solving ${isMatching ? 'Matching' : 'MCQ'}...`);
                    await updateGuiStatus('AI THINKING...');
                    await centuryPage.waitForTimeout(await getDelay('thinking'));

                    if (isMatching) {
                        // 1. Fast DOM scrape: extract all target labels and source texts
                        // Use textContent (not innerText) to match what the RegExp locator sees
                        let targetTexts = await currentFrame.evaluate(() => {
                            return [...document.querySelectorAll('.rc-prompt-answer-pair, .rc-label-pair-list__item')].map(row => {
                                const field = row.querySelector('.rc-prompt-answer-pair__field, .rc-label-pair-list__item-label');
                                return field ? (field.innerText || '').trim() : '';
                            }).filter(Boolean);
                        });
                        targetTexts = targetTexts.map(cleanText);

                        let sourceTexts = await currentFrame.evaluate(() => {
                            // Find the "Additional Answers" dock — try all known class names
                            const dock = document.querySelector(
                                '.rc-matching-additional-list, .rc-additional-answers, .draggable-label-container, .rc-learning-nugget__additional-answers'
                            );
                            const scope = dock || document;
                            const blacklist = ['additional answers', 'drag and drop', 'prompt', 'answer', 'target'];

                            return [...scope.querySelectorAll('[draggable="true"], .draggable-label-item, .rc-matching-answer-draggable')].map(el => {
                                // Skip items that are visibility:hidden (already placed in a target slot)
                                const wrapper = el.closest('[style*="visibility"]') || el;
                                const vis = window.getComputedStyle(wrapper).visibility;
                                if (vis === 'hidden') return '';

                                const txt = (el.innerText || '').trim();
                                if (!txt || blacklist.includes(txt.toLowerCase())) return '';
                                return txt;
                            }).filter(Boolean);
                        });
                        sourceTexts = sourceTexts.map(cleanText);

                        // Fallback: Label Pair List layout (Matching v2 / Labelling)
                        if (targetTexts.length === 0) {
                            targetTexts = await currentFrame.evaluate(() => {
                                return [...document.querySelectorAll('.rc-label-pair-list__item')].map((item, i) => {
                                    // Positional key is best for labelling tasks to avoid confusion with placed text
                                    return `Card ${i + 1}`;
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

                        // Fallback: Broader source selectors for any draggable content
                        if (sourceTexts.length === 0) {
                            sourceTexts = await currentFrame.evaluate(() => {
                                const seen = new Set();
                                const draggables = document.querySelectorAll('[draggable="true"], .draggable-label-item, .matching-additional-list__item, [class*="draggable"], .co-drag-drop-source, .rc-label-pair-base__field');
                                return [...draggables].map(el => {
                                    const txt = (el.innerText || el.textContent || '').trim();
                                    // Skip common boilerplate or header text
                                    const blacklist = ['additional answers', 'drag and drop', 'prompt', 'answer', 'target'];
                                    if (txt && !seen.has(txt) && !blacklist.includes(txt.toLowerCase())) {
                                        seen.add(txt);
                                        return txt;
                                    }
                                    return '';
                                }).filter(Boolean);
                            });
                            sourceTexts = sourceTexts.map(cleanText);
                        }

                        // Optimized Skip Detection: Only skip if we have absolutely no clues
                        const draggablesCount = await currentFrame.locator('[draggable="true"]').count().catch(() => 0);
                        if (isMatching && draggablesCount === 0 && sourceTexts.length === 0) {
                            console.log(`[Matching] No draggables found. Skipping...`);
                            const idkBtn = await currentFrame.$('button:has-text("I don\'t know"), [data-testid="button-skip"], button:has-text("skip"), button:has-text("Skip")');
                            if (idkBtn) {
                                await safeClick(idkBtn, 'I Don\'t Know');
                                await centuryPage.waitForTimeout(2000);
                                lastSolvedFingerprint = currentFingerprint;
                                sameQuestionAttempts = 0;
                                continue;
                            }
                        }

                        if (targetTexts.length > 0 && sourceTexts.length > 0) {
                            const turboLevel = await guiPage.evaluate(() => parseInt(document.getElementById('turbo-slider')?.value || '1'));
                            const brainModel = turboLevel > 10 ? 'gpt-4o-mini' : 'gpt-4o';

                            let pairs = await Brain.solveMatching(targetTexts, sourceTexts, config.openai_api_key, nuggetContext, imageBase64, brainModel);
                            await centuryPage.waitForTimeout(1500); // Optimized cooldown

                            if (pairs === "rate_limit" || (typeof pairs === 'string' && pairs.includes('429'))) {
                                console.log('[Matching] Rate limit hit. Backing off 10s...');
                                await updateGuiStatus('RATE LIMITED (10s)...');
                                await centuryPage.waitForTimeout(10000);
                                continue;
                            }
                            if (pairs) {
                                hasAttemptedSolve = true;
                                // Clean all keys and values in pairings
                                const cleanPairs = {};
                                for (const [k, v] of Object.entries(pairs)) {
                                    cleanPairs[cleanText(k)] = cleanText(v);
                                }
                                pairs = cleanPairs;

                                // DEDUP: If the AI assigned the same source to multiple targets,
                                // reassign duplicates to any unused sources from the dock
                                const usedSources = new Set();
                                const duplicateTargets = [];
                                for (const [target, source] of Object.entries(pairs)) {
                                    if (usedSources.has(source)) {
                                        duplicateTargets.push(target);
                                    } else {
                                        usedSources.add(source);
                                    }
                                }
                                if (duplicateTargets.length > 0) {
                                    // Find unused sources from the scraped source list
                                    const unusedSources = sourceTexts.filter(s => !usedSources.has(s));
                                    console.log(`[Matching] AI returned ${duplicateTargets.length} duplicate source(s). Rebalancing with unused: [${unusedSources.join(', ')}]`);
                                    for (let di = 0; di < duplicateTargets.length && di < unusedSources.length; di++) {
                                        console.log(`[Matching] Reassigning "${duplicateTargets[di]}" → "${unusedSources[di]}" (was duplicate)`);
                                        pairs[duplicateTargets[di]] = unusedSources[di];
                                    }
                                }

                                const totalPairs = Object.keys(pairs).length;
                                // Determine expected target count from the UI
                                const expectedTargetCount = await currentFrame.evaluate(() => {
                                    const layoutA = document.querySelectorAll('.rc-label-pair-list__item').length;
                                    const layoutB = document.querySelectorAll('.prompt-answer-list__item, .rc-prompt-answer-pair').length;
                                    return Math.max(layoutA, layoutB, 0);
                                });

                                console.log(`[Matching] Processing ${totalPairs} pairs sequentially... (Expected Targets: ${expectedTargetCount})`);

                                // 2. Sequential drag — one row at a time
                                const filledCount = await executeSequentialDrag(currentFrame, pairs);



                                // 3. Robust HTML-based result check
                                // We are done if we've filled at least as many as the AI told us AND at least as many as are on screen
                                if (filledCount >= totalPairs && filledCount >= expectedTargetCount) {
                                    console.log(`[Matching] ✓ ${filledCount} rows filled — submitting`);
                                    const submitBtn = await currentFrame.$('button.btn--secondary:has-text("SUBMIT ANSWER"), button.btn--secondary:has-text("Submit Answer"), [data-testid="button-submit"], button:has-text("SUBMIT ANSWER"), button:has-text("Submit Answer")');
                                    if (submitBtn) await safeClick(submitBtn);
                                    lastSolvedFingerprint = currentFingerprint; continue;
                                } else {
                                    console.log(`[Matching] ✗ Only ${filledCount}/${totalPairs} rows filled — retrying next loop`);
                                    sameQuestionAttempts++;
                                    if (sameQuestionAttempts >= 3) {
                                        console.log('[Matching] Persistent failure. Refreshing...');
                                        await updateGuiStatus('REFRESHING (GLITCH)...');
                                        await centuryPage.reload();
                                        lastSolvedFingerprint = '';
                                        sameQuestionAttempts = 0;
                                        await centuryPage.waitForTimeout(5000);
                                    }
                                    continue; // RETRY! Don't drop through to slide-skipping
                                }
                            }
                        }
                    } else {
                        let hasGuppy = !!(await currentFrame.$('.guppy, .guppy_elt, [id*="guppy"]'));
                        const turboLevel = await guiPage.evaluate(() => parseInt(document.getElementById('turbo-slider')?.value || '1'));
                        const brainModel = turboLevel > 10 ? 'gpt-4o-mini' : 'gpt-4o';

                        response = await Brain.solve(found.text, options, config.openai_api_key, nuggetContext, imageBase64, hasGuppy, brainModel);
                        if (response) {
                            console.log("STATUS:Answering question...");
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
                            await safeClick(optionElements[idx]);
                            const submitBtn = await currentFrame.$('button.btn--secondary:has-text("SUBMIT ANSWER"), button.btn--secondary:has-text("Submit Answer"), [data-testid="button-submit"], button:has-text("SUBMIT ANSWER"), button:has-text("Submit Answer")');
                            if (submitBtn) await safeClick(submitBtn);
                        }
                    } else {
                        // TEXT ANSWER HANDLING
                        console.log(`[Text Mode] Response: "${response.value}"`);

                        // BRIDGE: If text response matches an MCQ option precisely, use index click
                        const textMatchIdx = options.findIndex(opt =>
                            opt === response.value ||
                            opt.toLowerCase() === response.value.toLowerCase() ||
                            opt.replace(/\D/g, '') === response.value.replace(/\D/g, '') // match digit strings like "4" to " 4 "
                        );

                        if (textMatchIdx !== -1 && optionElements[textMatchIdx]) {
                            console.log(`[Text Mode] Value "${response.value}" matches Option ${textMatchIdx + 1}. Clicking...`);
                            await safeClick(optionElements[textMatchIdx]);
                            const submitBtn = await currentFrame.$('button.btn--secondary:has-text("SUBMIT ANSWER"), button.btn--secondary:has-text("Submit Answer"), [data-testid="button-submit"], button:has-text("SUBMIT ANSWER"), button:has-text("Submit Answer")');
                            if (submitBtn) await safeClick(submitBtn);
                        }
                        // 1. Try Standard Inputs
                        else if (await currentFrame.$('input[type="text"], input[type="number"], textarea')) {
                            const ti = await currentFrame.$('input[type="text"], input[type="number"], textarea');
                            if (ti && await ti.isVisible()) {
                                await ti.fill(response.value);
                                const submitBtn = await currentFrame.$('button.btn--secondary:has-text("SUBMIT ANSWER"), button.btn--secondary:has-text("Submit Answer"), [data-testid="button-submit"], button:has-text("SUBMIT ANSWER"), button:has-text("Submit Answer")');
                                if (submitBtn) await safeClick(submitBtn);
                            }
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
                                    await safeClick(dropdown);

                                    // Try exact match first
                                    const option = currentFrame.getByText(response.value, { exact: true }).first();
                                    if (await option.isVisible()) {
                                        await safeClick(option);
                                    } else {
                                        // Case-insensitive fallback
                                        const optionCi = currentFrame.getByText(response.value, { exact: false }).first();
                                        if (await optionCi.isVisible()) await safeClick(optionCi);
                                    }
                                }
                                const submitBtn = await currentFrame.$('button.btn--secondary:has-text("SUBMIT ANSWER"), button.btn--secondary:has-text("Submit Answer"), [data-testid="button-submit"], button:has-text("SUBMIT ANSWER"), button:has-text("Submit Answer")');
                                if (submitBtn) await safeClick(submitBtn);
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
                                await safeClick(guppy);
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
                                // Scoped search inside question container using frame locator
                                const textElement = currentFrame.getByText(response.value, { exact: false }).first();
                                if (await textElement.isVisible()) {
                                    await safeClick(textElement);
                                    await centuryPage.waitForTimeout(500);
                                    const submitBtn = await currentFrame.$('button.btn--secondary:has-text("SUBMIT ANSWER"), button.btn--secondary:has-text("Submit Answer"), [data-testid="button-submit"], button:has-text("SUBMIT ANSWER"), button:has-text("Submit Answer")');
                                    if (submitBtn) await safeClick(submitBtn);
                                } else {
                                    // Extreme fallback: any text match in frame
                                    const broadMatch = currentFrame.getByText(response.value, { exact: false }).first();
                                    const isVis = await broadMatch.isVisible().catch(() => false);
                                    if (isVis) {
                                        await safeClick(broadMatch);
                                        const submitBtn = await currentFrame.$('button.btn--secondary:has-text("SUBMIT ANSWER"), button.btn--secondary:has-text("Submit Answer"), [data-testid="button-submit"], button:has-text("SUBMIT ANSWER"), button:has-text("Submit Answer")');
                                        if (submitBtn) await safeClick(submitBtn);
                                    } else {
                                        console.log('[Fallback] Text element not visible even in broad search.');
                                    }
                                }
                            } catch (e) {
                                console.log('[Fallback] Failed to find/click text element:', e.message);
                            }
                        }
                    }
                }

                const cont = await currentFrame.$('button.btn--secondary:has-text("NEXT QUESTION"), button.btn--secondary:has-text("Next Question"), button.btn--secondary:has-text("CONTINUE"), [data-testid="button-next-question"]');
                if (cont) {
                    console.log("STATUS:Moving to next question...");
                    await cont.evaluate(el => el.click()).catch(() => { });
                }
            } else {
                // NOT FOUND: Skips & Results
                const skip = true; // High-speed default for bot
                const btn = await centuryPage.$('button.btn--primary:has-text("START"), button.btn--primary:has-text("CONTINUE"), button.btn--secondary:has-text("NEXT"), button.btn--primary:has-text("DONE"), button:has-text("Continue")');

                if (skip && btn && await btn.isVisible()) {
                    const q = await centuryPage.$('.rc-learning-question, .multi-question__question, .rc-multiple-choice-question');
                    if (!q || !(await q.isVisible())) {
                        console.log("STATUS:Skipping educational lesson...");
                        await updateGuiStatus('SKIPPING LESSON...');
                        // Direct JS Injection Click
                        await btn.evaluate(el => el.click()).catch(() => { });
                        lastSolvedFingerprint = '';
                        await centuryPage.waitForTimeout(100);
                        await centuryPage.waitForTimeout(50); // Minimized from 100
                        continue;
                    }
                }
                else {
                    // Check for Results/Next Nugget
                    const resSelector = [
                        'h2:has-text("Results")',
                        '.rc-results__score',
                        '.rc-results__header',
                        '.rc-results__title',
                        '[class*="results"]',
                        'button:has-text("Next Nugget")',
                        'button:has-text("View results")',
                        ':has-text("Thank you for completing")',
                        ':has-text("completing the diagnostic")'
                    ].join(', ');

                    let res = await centuryPage.$(resSelector);
                    let resFrame = centuryPage;

                    // Results might be in an iframe
                    if (!res) {
                        for (const f of centuryPage.frames()) {
                            const fRes = await f.$(resSelector).catch(() => null);
                            if (fRes && await fRes.isVisible()) {
                                res = fRes;
                                resFrame = f;
                                break;
                            }
                        }
                    }

                    if (res && await res.isVisible()) {
                        const resText = (await res.innerText().catch(() => '')).toLowerCase();
                        if (resText.includes('view results')) {
                            await safeClick(res);
                            await centuryPage.waitForTimeout(Math.floor(2000 * await getTurboMultiplier()));
                        }

                        // Log accuracy and duration
                        let scoreVal = await getNuggetScore(resFrame);
                        if (scoreVal === null) scoreVal = await getNuggetScore(centuryPage);

                        let timeVal = await getNuggetDuration(resFrame);
                        if (timeVal === null) timeVal = await getNuggetDuration(centuryPage);

                        await logScore(scoreVal, timeVal);

                        // JUMP ON SCORE OR THANK YOU SCREEN
                        const isThankYou = resText.includes('thank you') || resText.includes('completing');

                        if ((scoreVal !== null && !isNaN(scoreVal)) || isThankYou) {
                            if (nuggetQueue.length > 0) {
                                console.log('[Flow] Results screen detected. Jumping to next nugget...');
                                if (await navigateToNextNugget()) continue;
                            } else {
                                console.log('[Complete] All nuggets in queue finished. Triggering session report and termination.');
                                await updateGuiStatus('🎉 ASSIGNMENT COMPLETE!');
                                isSolverRunning = false;
                                await centuryPage.waitForTimeout(Math.floor(3000 * await getTurboMultiplier()));
                                await terminateSession();
                                break;
                            }
                        }
                    }
                }

            }
        } catch (e) {
            console.log('Loop Error:', e.message);
        }


        await centuryPage.waitForTimeout(10);
    }
})();
