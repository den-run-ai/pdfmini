// Serve the CDN-hosted libraries (pdf-lib, pdfjs-dist) from node_modules so
// tests and calibration run offline against the exact pinned versions.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const nodeModules = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules');
const CDN = /^https:\/\/cdn\.jsdelivr\.net\/npm\/(pdf-lib|pdfjs-dist)@([^/]+)\/([^?#]*)/;
const TYPES = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};

function installedVersion(pkg) {
  return JSON.parse(fs.readFileSync(path.join(nodeModules, pkg, 'package.json'), 'utf8')).version;
}

/** Route CDN requests of a Playwright BrowserContext to local files. */
export async function routeCdn(context) {
  const versions = { 'pdf-lib': installedVersion('pdf-lib'), 'pdfjs-dist': installedVersion('pdfjs-dist') };
  await context.route(CDN, async (route) => {
    const [, pkg, version, file] = route.request().url().match(CDN);
    if (versions[pkg] !== version) {
      throw new Error(`index/engine requests ${pkg}@${version} but node_modules has ${versions[pkg]}`);
    }
    const local = path.join(nodeModules, pkg, file);
    if (!local.startsWith(path.join(nodeModules, pkg)) || !fs.existsSync(local)) {
      await route.fulfill({ status: 404, body: 'not found' });
      return;
    }
    await route.fulfill({
      status: 200,
      body: fs.readFileSync(local),
      headers: {
        'content-type': TYPES[path.extname(local)] || 'application/octet-stream',
        'access-control-allow-origin': '*',
      },
    });
  });
}
