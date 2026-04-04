const { chromium } = require('playwright');
require('dotenv').config();

async function launchBrowser() {
    const isHeadless = process.env.HEADLESS !== 'false';
    const browser = await chromium.launch({
        headless: isHeadless,
        args: isHeadless ? [] : ['--start-maximized']
    });
    const context = await browser.newContext({ 
        viewport: isHeadless ? { width: 1280, height: 720 } : null 
    });
    return { browser, context };
}

async function login(page, username, password) {
    console.log("STATUS:Connecting to Century website...");
    await page.goto('https://app.century.tech/login/', { waitUntil: 'networkidle' });
    
    console.log("STATUS:Authenticating session...");
    await page.fill('input[name="username"]', username);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');

    try {
        await page.waitForURL('**/learn/**', { timeout: 15000 });
        console.log("STATUS:Authentication successful!");
        return true;
    } catch (e) {
        if (page.url().includes('/learn/')) return true;
        
        const errorMsg = await page.evaluate(() => {
            return document.querySelector('[data-testid="login-form-error"]')?.innerText.trim();
        }).catch(() => null);
        
        if (errorMsg) {
            console.log(JSON.stringify({ success: false, error: errorMsg }));
            return false;
        }
        console.log("STATUS:Authentication timed out.");
        return false;
    }
}

module.exports = { launchBrowser, login };
