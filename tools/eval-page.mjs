// Evaluate an async function body against the engine harness with local files.
//   node tools/eval-page.mjs script.js file.pdf ...
// The script body receives `files` (array of {name, bytes: ArrayBuffer}) and
// may return any JSON-serializable value, which is printed.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { routeCdn } from './cdn-routes.mjs';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [scriptFile, ...files] = process.argv.slice(2);
const body = fs.readFileSync(scriptFile, 'utf8');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/__in__/')) {
    const f = files[Number(url.pathname.slice(8))];
    res.writeHead(200, { 'content-type': 'application/pdf' });
    fs.createReadStream(f).pipe(res);
    return;
  }
  const file = path.join(repo, decodeURIComponent(url.pathname));
  if (!file.startsWith(repo) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'text/javascript' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch();
const context = await browser.newContext();
await routeCdn(context);
const page = await context.newPage();
page.on('console', (m) => console.log('[page]', m.text()));
page.on('pageerror', (e) => console.error('pageerror:', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/tests/harness.html`);
const out = await page.evaluate(async ({ body, names }) => {
  const files = [];
  for (let i = 0; i < names.length; i++) {
    files.push({ name: names[i], bytes: await (await fetch('/__in__/' + i)).arrayBuffer() });
  }
  const fn = new Function('files', `return (async () => { ${body} })();`);
  return fn(files);
}, { body, names: files.map((f) => path.basename(f)) });
console.log(JSON.stringify(out, null, 2));
await browser.close();
server.close();
