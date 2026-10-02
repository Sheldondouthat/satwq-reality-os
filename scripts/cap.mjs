// Screenshot helper: run from ~/workspace/gods-eye-view so puppeteer resolves.
import puppeteer from 'puppeteer';

(async () => {
  const [url, out, w, h] = process.argv.slice(2);
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/opt/meta-chromium/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: +w || 1280, height: +h || 900 });
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
  // Report font status for the verdict log.
  const status = await page.evaluate(() => {
    const out = { fonts: document.fonts.status, checks: {} };
    for (const el of document.querySelectorAll('.ms')) {
      const cs = getComputedStyle(el);
      out.checks[el.textContent] = {
        w: Math.round(el.getBoundingClientRect().width),
        family: cs.fontFamily.slice(0, 8),
      };
    }
    return out;
  });
  console.log(JSON.stringify({ count: Object.keys(status.checks).length,
    zeroWidth: Object.entries(status.checks).filter(([, v]) => v.w === 0).map(([k]) => k) }));
  await page.screenshot({ path: out });
  await browser.close();
  console.log('saved', out);
})();
