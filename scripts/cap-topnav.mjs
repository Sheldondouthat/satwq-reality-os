// Reality OS top-nav verification capture (file:// mirror of deployed dist).
import puppeteer from 'puppeteer';

const [url, out] = process.argv.slice(2);
const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: '/opt/meta-chromium/chrome',
  args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080 });
await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
// file:// has no APIs: force-hide the boot/loading chrome to expose the UI.
await page.evaluate(() => {
  for (const sel of ['#satwq-boot', '#loading-screen'])
    document.querySelectorAll(sel).forEach((el) => { el.style.display = 'none'; });
});
await new Promise((r) => setTimeout(r, 2500));
const probe = await page.evaluate(() => {
  const icons = [...document.querySelectorAll('.material-symbols-outlined')];
  const raw = icons.filter((el) => {
    const r = el.getBoundingClientRect();
    // ligature failed -> element renders its text at full text width
    return r.width > 60;
  }).map((el) => el.textContent.trim());
  return {
    iconCount: icons.length,
    rawTextIcons: raw,
    fontsStatus: document.fonts.status,
    checkRadar: document.fonts.check('40px "Material Symbols Outlined"', 'radar'),
    checkCloseFs: document.fonts.check('40px "Material Symbols Outlined"', 'close_fullscreen'),
  };
});
console.log(JSON.stringify(probe, null, 1));
await page.screenshot({ path: out });
await browser.close();
console.log('saved', out);
