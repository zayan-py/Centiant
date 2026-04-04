const { launchBrowser, login } = require('./common');

async function validate(username, password) {
    const { browser, context } = await launchBrowser();
    const page = await context.newPage();

    try {
        if (!await login(page, username, password)) return;

        console.log("STATUS:Login success! Scraping profile name...");
        // Scrape name from My Path
        await page.goto('https://app.century.tech/learn/my-path', { waitUntil: 'networkidle' });
        const name = await page.evaluate(() => {
            const titleEl = document.querySelector('.cds-widget__title--centred');
            if (titleEl) {
                // Look only at the direct text node before the <div> or <button>
                const text = titleEl.childNodes[0]?.textContent || "";
                return text.replace("'s Recommended Path", "").trim();
            }
            return "Student";
        });

        // Also scrape names of due assignments as a bonus
        console.log("STATUS:Finalizing initialization...");
        await page.goto('https://app.century.tech/learn/assignments/due', { waitUntil: 'networkidle' });
        const assignments = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('.due-assignments-list__body a'));
            return items.map(a => a.querySelector('.due-assignments-item__title')?.innerText || 'Untitled');
        });

        console.log(JSON.stringify({ success: true, name: name, assignments: assignments }));
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
