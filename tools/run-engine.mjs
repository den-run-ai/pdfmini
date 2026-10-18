// Run the pdfmini engine on local PDFs in headless Chromium.
//
//   node tools/run-engine.mjs [--level balanced] [--mode images|rasterize]
//        [--dpi N] [--quality N] [--gray] [--out DIR] [--json] file.pdf ...
//
// Writes <out>/<name>.pdf for each input and prints size/time stats.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { routeCdn } from './cdn-routes.mjs';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const opts = { level: 'balanced', mode: 'images', out: null, files: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--level') opts.level = argv[++i];
    else if (a === '--mode') opts.mode = argv[++i];
    else if (a === '--dpi') opts.dpi = Number(argv[++i]);
    else if (a === '--quality') opts.quality = Number(argv[++i]);
    else if (a === '--gray') opts.grayscale = true;
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--json') opts.json = true;
    else opts.files.push(a);
  }
  return opts;
}

/** Start a static server for the repo plus /__in__/ (inputs) and /__out__/ (results). */
function startServer(inputs, outDir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/__in__/')) {
        const file = inputs.get(decodeURIComponent(url.pathname.slice(8)));
        if (!file) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'content-type': 'application/pdf' });
        fs.createReadStream(file).pipe(res);
        return;
      }
      if (url.pathname.startsWith('/__out__/') && req.method === 'POST') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          if (outDir) fs.writeFileSync(path.join(outDir, path.basename(decodeURIComponent(url.pathname.slice(9)))), Buffer.concat(chunks));
          res.writeHead(204).end();
        });
        return;
      }
      const file = path.join(repo, decodeURIComponent(url.pathname));
      if (!file.startsWith(repo) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
      const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

export async function runEngine(files, options, outDir) {
  const inputs = new Map(files.map((f) => [path.basename(f), path.resolve(f)]));
  if (outDir) fs.mkdirSync(outDir, { recursive: true });
  const server = await startServer(inputs, outDir);
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const context = await browser.newContext();
  await routeCdn(context);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('pageerror:', e.message));
  await page.goto(`${base}/tests/harness.html`);
  const results = [];
  try {
    for (const name of inputs.keys()) {
      const r = await page.evaluate(async ({ name, options }) => {
        const buf = await (await fetch('/__in__/' + encodeURIComponent(name))).arrayBuffer();
        const t0 = performance.now();
        try {
          const res = await window.PDFMini.compress(buf, options);
          const ms = performance.now() - t0;
          await fetch('/__out__/' + encodeURIComponent(name), { method: 'POST', body: res.bytes });
          return { name, ok: true, improved: res.improved, input: buf.byteLength, output: res.bytes.length, ms, stats: res.stats };
        } catch (e) {
          return { name, ok: false, error: `${e.name}: ${e.message}`, code: e.code };
        }
      }, { name, options });
      results.push(r);
    }
  } finally {
    await browser.close();
    server.close();
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  const { files, out, json, ...options } = opts;
  const results = await runEngine(files, options, out);
  if (json) console.log(JSON.stringify(results, null, 2));
  else {
    for (const r of results) {
      if (!r.ok) { console.log(`${r.name}: ERROR ${r.error}`); continue; }
      const pct = ((1 - r.output / r.input) * 100).toFixed(1);
      console.log(`${r.name}: ${(r.input / 1e6).toFixed(2)} MB -> ${(r.output / 1e6).toFixed(2)} MB (${pct}% smaller${r.improved ? '' : ', kept original'}) in ${(r.ms / 1000).toFixed(1)}s  ${JSON.stringify(r.stats.recompressed !== undefined ? { imgs: r.stats.images, re: r.stats.recompressed, kept: r.stats.kept, err: r.stats.rendererError } : {})}`);
    }
  }
}
