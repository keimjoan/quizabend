// Erzeugt die PNG-Icons aus icon.svg (für Handys und Tablets, die kein SVG-Icon nehmen).
// Start: npm run icons  (braucht Playwright, siehe Tests)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SIZES = { 'icon-192.png': 192, 'icon-512.png': 512, 'apple-touch-icon.png': 180 };

(async () => {
  const svg = fs.readFileSync(path.join(ROOT, 'icon.svg'), 'utf8');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const [file, size] of Object.entries(SIZES)) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await page.screenshot({ path: path.join(ROOT, file) });
    console.log(`${file} (${size} × ${size})`);
  }
  await browser.close();
})();
