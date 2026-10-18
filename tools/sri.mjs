// Print the versions and Subresource Integrity hashes of the CDN files the app
// pins, computed from node_modules. Use when updating pdf-lib or pdfjs-dist:
// update package.json, run `npm install`, then copy these values into
// index.html (script tag and Content-Security-Policy) and js/engine.js.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const nodeModules = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules');

export const PINNED = [
  ['pdf-lib', 'dist/pdf-lib.min.js'],
  ['pdfjs-dist', 'legacy/build/pdf.min.mjs'],
  ['pdfjs-dist', 'legacy/build/pdf.worker.min.mjs'],
];

export function version(pkg) {
  return JSON.parse(fs.readFileSync(path.join(nodeModules, pkg, 'package.json'), 'utf8')).version;
}

export function integrity(pkg, file) {
  const bytes = fs.readFileSync(path.join(nodeModules, pkg, file));
  return `sha384-${crypto.createHash('sha384').update(bytes).digest('base64')}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [pkg, file] of PINNED) {
    console.log(`https://cdn.jsdelivr.net/npm/${pkg}@${version(pkg)}/${file}\n  ${integrity(pkg, file)}`);
  }
}
