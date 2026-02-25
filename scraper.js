const { chromium } = require('playwright');
require('dotenv').config();

async function scrape(username, password, mode, targetUrl = null) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        await page.goto('https://app.century.tech/login/', { waitUntil: 'networkidle' });
        await page.fill('input[name="username"]', username);
        await page.fill('input[name="password"]', password);
        await page.click('button[type="submit"]');

        // Wait for navigation or error
        try {
            await Promise.race([
                page.waitForURL('**/learn/**', { timeout: 15000 }),
                page.waitForSelector('[data-testid="login-form-error"]', { timeout: 15000 })
            ]);

            if (!page.url().includes('/learn/')) {
                const errorMsg = await page.evaluate(() => {
                    return document.querySelector('[data-testid="login-form-error"]')?.innerText.trim() || "Login failed";
                });
                console.log(JSON.stringify({ success: false, error: errorMsg }));
                return;
            }
        } catch (e) {
            console.log(JSON.stringify({ success: false, error: "Authentication timed out" }));
            return;
        }

        if (mode === 'assignments') {
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
            await page.goto(targetUrl, { waitUntil: 'networkidle' });

            // Wait for nugget list to load
            await page.waitForSelector('.rc-nugget-list__item', { timeout: 10000 }).catch(() => { });

            const nuggets = await page.evaluate(() => {
                const items = Array.from(document.querySelectorAll('.rc-nugget-list__item'));
                return items.map(item => {
                    const link = item.querySelector('a[data-testid="nugget-link"], a[data-testid="smart-nugget-link"]');
                    const titleEl = item.querySelector('[data-testid="nugget-title"]');
                    if (link && titleEl) {
                        return {
                            title: titleEl.innerText.trim(),
                            url: link.href
                        };
                    }
                    return null;
                }).filter(n => n !== null);
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
