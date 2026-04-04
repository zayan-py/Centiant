const { launchBrowser, login } = require('./common');

async function scrape(username, password, mode, targetUrl = null) {
    const { browser, context } = await launchBrowser();
    const page = await context.newPage();

    try {
        if (!await login(page, username, password)) return;

        if (mode === 'assignments') {
            console.log("STATUS:Scanning for due assignments...");
            await page.goto('https://app.century.tech/learn/assignments/due', { waitUntil: 'networkidle' });
            const assignments = await page.evaluate(() => {
                const items = Array.from(document.querySelectorAll('.due-assignments-list__body a'));
                return items.map(a => {
                    return {
                        title: a.querySelector('.due-assignments-item__title')?.innerText || 'Untitled',
                        subject: a.querySelector('[class*="rc-subject-label"]')?.innerText || 'General',
                        count: a.querySelector('[data-testid="completion-count-label"]')?.innerText || '',
                        url: a.href
                    };
                });
            });
            console.log(JSON.stringify({ success: true, assignments }));
        } else if (mode === 'nuggets' && targetUrl) {
            console.log("STATUS:Navigating to assignment nuggets...");
            const fullUrl = targetUrl.startsWith('http') ? targetUrl : `https://app.century.tech${targetUrl.startsWith('/') ? '' : '/'}${targetUrl}`;
            await page.goto(fullUrl, { waitUntil: 'networkidle' });

            // Wait for nugget list to load
            console.log("STATUS:Waiting for content to load...");
            await page.waitForSelector('.rc-nugget-list__item', { timeout: 10000 }).catch(() => { });

            console.log("STATUS:Scraping nuggets...");

            const nuggets = await page.evaluate(() => {
                const items = Array.from(document.querySelectorAll('.rc-nugget-list__item'));
                const queue = [];
                items.forEach(item => {
                    const link = item.querySelector('a[data-testid="nugget-link"], a[data-testid="smart-nugget-link"]');
                    const titleEl = item.querySelector('[data-testid="nugget-title"]');
                    const scoreRing = item.querySelector('.rc-percentage-ring--score');
                    const completionRing = item.querySelector('.rc-percentage-ring--completion');

                    if (link && titleEl) {
                        let completionScore = 0;
                        if (completionRing) completionScore = parseInt(completionRing.getAttribute('data-score') || '0');
                        else if (scoreRing) completionScore = parseInt(scoreRing.getAttribute('data-score') || '0');

                        if (completionScore < 80) {
                            queue.push({
                                title: titleEl.innerText.trim(),
                                url: link.href,
                                completion: completionScore
                            });
                        }
                    }
                });
                return queue;
            });
            console.log(JSON.stringify({ success: true, nuggets }));
        }
    } catch (e) {
        console.log(JSON.stringify({ success: false, error: e.message }));
    } finally {
        await browser.close();
    }
}

const args = process.argv.slice(2);
// Usage: node scraper.js username password assignments
// Usage: node scraper.js username password nuggets url
if (args.length >= 3) {
    (async () => {
        try {
            await scrape(args[0], args[1], args[2], args[3]);
        } catch (err) {
            console.log(JSON.stringify({ success: false, error: err.message }));
        }
    })();
} else {
    console.log(JSON.stringify({ success: false, error: "Missing arguments" }));
}
