const { chromium } = require('playwright');
require('dotenv').config();

async function validate(username, password) {
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

            if (page.url().includes('/learn/')) {
                // If login successful, scrape names of due assignments as a bonus
                await page.goto('https://app.century.tech/learn/assignments/due', { waitUntil: 'networkidle' });
                const assignments = await page.evaluate(() => {
                    const items = Array.from(document.querySelectorAll('.due-assignments-list__body a'));
                    return items.map(a => {
                        const title = a.querySelector('.due-assignments-item__title')?.innerText || 'Untitled';
                        return title;
                    });
                });

                console.log(JSON.stringify({ success: true, assignments: assignments }));
            } else {
                const errorMsg = await page.evaluate(() => {
                    return document.querySelector('[data-testid="login-form-error"]')?.innerText.trim() || "Invalid credentials";
                });
                console.log(JSON.stringify({ success: false, error: errorMsg }));
            }
        } catch (e) {
            console.log(JSON.stringify({ success: false, error: "Authentication timed out or failed" }));
        }
    } catch (e) {
        console.log(JSON.stringify({ success: false, error: e.message }));
    } finally {
        await browser.close();
    }
}

const args = process.argv.slice(2);
if (args.length >= 2) {
    (async () => {
        try {
            await validate(args[0], args[1]);
        } catch (err) {
            console.log(JSON.stringify({ success: false, error: err.message }));
        }
    })();
} else {
    console.log(JSON.stringify({ success: false, error: "Missing arguments" }));
}
