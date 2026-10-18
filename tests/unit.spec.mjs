// Pure-JS unit tests (no browser): the JPEG encoder.
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { test, expect } from '@playwright/test';
import { JpegImage } from 'pdfjs-dist/image_decoders/pdf.image_decoders.mjs';
import { photoPixels } from './fixtures.mjs';

const jpeg = createRequire(import.meta.url)('../js/jpeg.js');

function decode(bytes, w, h) {
  const img = new JpegImage();
  img.parse(bytes);
  return { img, rgb: img.getData({ width: w, height: h, forceRGB: true }) };
}

function psnr(rgba, rgb, gray) {
  let se = 0;
  const n = rgba.length / 4;
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    if (gray) {
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      se += (y - rgb[i * 3]) ** 2;
    } else {
      se += (r - rgb[i * 3]) ** 2 + (g - rgb[i * 3 + 1]) ** 2 + (b - rgb[i * 3 + 2]) ** 2;
    }
  }
  const mse = se / (n * (gray ? 1 : 3));
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
}

test.describe('JPEG encoder', () => {
  const w = 320, h = 240;
  const px = photoPixels(w, h, 11);

  test('produces decodable color JPEGs with good fidelity', () => {
    const out = jpeg.encode(px, w, h, { quality: 75 });
    expect([out[0], out[1]]).toEqual([0xff, 0xd8]);
    expect([out[out.length - 2], out[out.length - 1]]).toEqual([0xff, 0xd9]);
    const { img, rgb } = decode(out, w, h);
    expect([img.width, img.height, img.numComponents]).toEqual([w, h, 3]);
    expect(psnr(px, rgb, false)).toBeGreaterThan(30);
  });

  test('grayscale output is a true 1-channel JPEG', () => {
    const out = jpeg.encode(px, w, h, { quality: 75, gray: true });
    const { img, rgb } = decode(out, w, h);
    expect(img.numComponents).toBe(1);
    expect(psnr(px, rgb, true)).toBeGreaterThan(30);
    expect(out.length).toBeLessThan(jpeg.encode(px, w, h, { quality: 75 }).length);
  });

  test('size grows with quality', () => {
    const sizes = [40, 60, 75, 90].map((q) => jpeg.encode(px, w, h, { quality: q }).length);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
  });

  test('handles sizes that are not multiples of the block size', () => {
    for (const [sw, sh] of [[1, 1], [7, 5], [17, 9], [16, 16], [33, 65]]) {
      const p = photoPixels(sw, sh, sw * 31 + sh);
      for (const opts of [{}, { subsample: 1 }, { gray: true }]) {
        const out = jpeg.encode(p, sw, sh, { quality: 80, ...opts });
        const { img } = decode(out, sw, sh);
        expect([img.width, img.height]).toEqual([sw, sh]);
      }
    }
  });

  test('is deterministic', () => {
    const a = jpeg.encode(px, w, h, { quality: 72 });
    const b = jpeg.encode(px, w, h, { quality: 72 });
    expect(crypto.createHash('sha256').update(a).digest('hex')).toBe(crypto.createHash('sha256').update(b).digest('hex'));
  });

  test('rejects invalid input', () => {
    expect(() => jpeg.encode(px, 0, 10)).toThrow();
    expect(() => jpeg.encode(new Uint8Array(10), 10, 10)).toThrow();
  });
});

test.describe('pinned libraries', () => {
  test('CDN URLs, integrity hashes and CSP match node_modules', async () => {
    const fs = await import('node:fs');
    const { PINNED, version, integrity } = await import('../tools/sri.mjs');
    const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const engine = fs.readFileSync(new URL('../js/engine.js', import.meta.url), 'utf8');
    const libVersion = version('pdf-lib');
    const jsVersion = version('pdfjs-dist');
    const [, libFile] = PINNED[0];
    // pdf-lib <script> tag with SRI.
    expect(html).toContain(`src="https://cdn.jsdelivr.net/npm/pdf-lib@${libVersion}/${libFile}" integrity="${integrity('pdf-lib', libFile)}"`);
    // PDF.js version and module hashes in the engine.
    expect(engine).toContain(`const PDFJS_VERSION = '${jsVersion}';`);
    for (const [pkg, file] of PINNED.slice(1)) expect(engine).toContain(`['${file}', '${integrity(pkg, file)}']`);
    // The Content-Security-Policy allows exactly these package paths.
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
    expect(csp).toContain(`https://cdn.jsdelivr.net/npm/pdf-lib@${libVersion}/`);
    expect(csp.match(/pdfjs-dist@([\d.]+)\//g).every((m) => m === `pdfjs-dist@${jsVersion}/`)).toBe(true);
  });
});
