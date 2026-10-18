// Capture UI screenshots (mobile/desktop, light/dark) for visual review.
//   node tools/screenshots.mjs OUT_DIR [sample.pdf]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from '@playwright/test';
import { routeCdn } from './cdn-routes.mjs';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [outDir, sample] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let file = path.join(repo, decodeURIComponent(url.pathname));
  if (url.pathname === '/') file = path.join(repo, 'index.html');
  if (!file.startsWith(repo) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  const type = file.endsWith('.html') ? 'text/html' : 'text/javascript';
  res.writeHead(200, { 'content-type': type });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();

const variants = [
  { name: 'mobile-light', ...devices['iPhone 13'], colorScheme: 'light' },
  { name: 'mobile-dark', ...devices['iPhone 13'], colorScheme: 'dark' },
  { name: 'desktop-light', viewport: { width: 1280, height: 860 }, colorScheme: 'light' },
  { name: 'desktop-dark', viewport: { width: 1280, height: 860 }, colorScheme: 'dark' },
];
for (const { name, ...opts } of variants) {
  delete opts.defaultBrowserType;
  const context = await browser.newContext(opts);
  await routeCdn(context);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error(name, 'pageerror:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error(name, 'console:', m.text()); });
  await page.goto(base);
  await page.waitForSelector('body[data-app="ready"]');
  await page.screenshot({ path: path.join(outDir, `${name}-1-idle.png`), fullPage: true });
  await page.click('#advanced summary');
  await page.screenshot({ path: path.join(outDir, `${name}-2-advanced.png`), fullPage: true });
  await page.click('#advanced summary');
  if (sample) {
    await page.setInputFiles('#compress-input', sample);
    await page.click('#compress-btn');
    await page.waitForSelector('body[data-compress="done"], body[data-compress="unchanged"], body[data-compress="error"]', { timeout: 120000 });
    await page.screenshot({ path: path.join(outDir, `${name}-3-result.png`), fullPage: true });
    await page.click('#tab-combine');
    await page.setInputFiles('#combine-input', [sample, sample]);
    await page.waitForSelector('body[data-combine="ready"]');
    await page.screenshot({ path: path.join(outDir, `${name}-4-combine.png`), fullPage: true });
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (overflow) console.error(name, 'horizontal overflow!');
  await context.close();
}
await browser.close();
server.close();
console.log('saved to', outDir);
