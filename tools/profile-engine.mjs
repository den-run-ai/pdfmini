// CPU-profile PDFMini.compress on one file and print the hottest functions.
//   node tools/profile-engine.mjs file.pdf [--level balanced] [--top 25]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { routeCdn } from './cdn-routes.mjs';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const file = args[0];
const level = args.includes('--level') ? args[args.indexOf('--level') + 1] : 'balanced';
const top = args.includes('--top') ? Number(args[args.indexOf('--top') + 1]) : 25;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__in__') { res.writeHead(200); fs.createReadStream(file).pipe(res); return; }
  const f = path.join(repo, decodeURIComponent(url.pathname));
  if (!f.startsWith(repo) || !fs.existsSync(f)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'text/javascript' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch();
const context = await browser.newContext();
await routeCdn(context);
const page = await context.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/tests/harness.html`);
const cdp = await context.newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
await cdp.send('Profiler.start');
const ms = await page.evaluate(async (level) => {
  const buf = await (await fetch('/__in__')).arrayBuffer();
  const t0 = performance.now();
  await window.PDFMini.compress(buf, { level });
  return performance.now() - t0;
}, level);
const { profile } = await cdp.send('Profiler.stop');
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
const dt = profile.timeDeltas;
profile.samples.forEach((id, i) => {
  const n = byId.get(id);
  const key = `${n.callFrame.functionName || '(anon)'} ${path.basename(n.callFrame.url || '')}:${n.callFrame.lineNumber + 1}`;
  self.set(key, (self.get(key) || 0) + (dt[i] || 0) / 1000);
});
console.log(`compress took ${ms.toFixed(0)} ms (main thread profile)`);
for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${v.toFixed(1).padStart(8)} ms  ${k}`);
await browser.close();
server.close();
