// Engine tests in real browsers (tests/harness.html loads only the engine).
import fs from 'node:fs';
import crypto from 'node:crypto';
import { test, expect, openHarness, compressInPage, imagesOf, pageSizes, textOf, contentStreams } from './helpers.mjs';
import { fixtureFiles, photoPixels } from './fixtures.mjs';

let F;
test.beforeAll(async () => { F = await fixtureFiles(); });
test.beforeEach(async ({ page }) => { await openHarness(page); });

test('keeps text and downsamples photos to the target resolution', async ({ page }) => {
  const input = fs.readFileSync(F.photo);
  const res = await compressInPage(page, F.photo, { level: 'balanced' });
  expect(res.ok).toBe(true);
  expect(res.improved).toBe(true);
  expect(res.bytes.length).toBeLessThan(input.length * 0.2);
  const dpi = res.stats.settings.dpi;
  for (const img of await imagesOf(res.bytes)) {
    expect(img.filter).toBe('/DCTDecode');
    // Drawn 4 x 3 inches, so the target is 4 * dpi pixels wide.
    expect(Math.abs(img.width - 4 * dpi)).toBeLessThanOrEqual(1);
    expect(Math.abs(img.height - 3 * dpi)).toBeLessThanOrEqual(1);
  }
  expect(await pageSizes(res.bytes)).toEqual(await pageSizes(input));
  expect(await contentStreams(res.bytes)).toEqual(await contentStreams(input));
  expect(await textOf(res.bytes)).toEqual(await textOf(input));
});

test('levels are ordered: light > balanced > strong in size', async ({ page }) => {
  const sizes = {};
  for (const level of ['light', 'balanced', 'strong']) {
    const res = await compressInPage(page, F.photo, { level });
    sizes[level] = res.bytes.length;
  }
  expect(sizes.light).toBeGreaterThan(sizes.balanced);
  expect(sizes.balanced).toBeGreaterThan(sizes.strong);
});

test('never returns a bigger file, and re-compressing is a no-op', async ({ page }) => {
  const text = await compressInPage(page, F.text, { level: 'strong' });
  expect(text.bytes.length).toBeLessThanOrEqual(fs.statSync(F.text).size);
  expect(await textOf(text.bytes)).toEqual(await textOf(fs.readFileSync(F.text)));

  const once = await compressInPage(page, F.photo, { level: 'balanced' });
  const tmp = `${F.photo}.once.pdf`;
  fs.writeFileSync(tmp, once.bytes);
  const twice = await compressInPage(page, tmp, { level: 'balanced' });
  expect(twice.improved).toBe(false);
  expect(Buffer.compare(twice.bytes, once.bytes)).toBe(0);
});

test('lossless images with alpha keep a matching soft mask', async ({ page }) => {
  const res = await compressInPage(page, F.pngAlpha, { level: 'balanced' });
  expect(res.improved).toBe(true);
  const imgs = await imagesOf(res.bytes);
  const base = imgs.find((i) => i.smask);
  const mask = imgs.find((i) => i.ref === base.smask);
  expect(base.width).toBeLessThan(1600);
  expect([mask.width, mask.height]).toEqual([base.width, base.height]);
  expect(mask.filter).toBe('/FlateDecode'); // alpha stays lossless
});

test('gray, CMYK and indexed images are handled', async ({ page }) => {
  const res = await compressInPage(page, F.mixedImages, { level: 'balanced' });
  expect(res.ok).toBe(true);
  expect(res.improved).toBe(true);
  const imgs = await imagesOf(res.bytes);
  const before = await imagesOf(fs.readFileSync(F.mixedImages));
  expect(imgs).toHaveLength(before.length); // images are replaced in place
  const gray = imgs.find((i) => i.colorSpace === '/DeviceGray');
  expect(gray && gray.filter).toBe('/DCTDecode');
  // The CMYK image needs PDF.js to decode; it must come out as RGB JPEG.
  expect(imgs.some((i) => i.colorSpace === '/DeviceCMYK')).toBe(false);
});

test('images inside form XObjects are sized by their real placement', async ({ page }) => {
  const res = await compressInPage(page, F.formXObject, { level: 'balanced' });
  const [img] = await imagesOf(res.bytes);
  // Form scales 1600x1200 by 0.25: drawn 400 x 300 pt = 5.56 x 4.17 in.
  const dpi = res.stats.settings.dpi;
  expect(Math.abs(img.width - Math.round(2000 * dpi / (2000 / (400 / 72))))).toBeLessThanOrEqual(1);
});

test('grayscale option converts images to 1-channel JPEG', async ({ page }) => {
  const res = await compressInPage(page, F.photo, { level: 'balanced', grayscale: true });
  for (const img of await imagesOf(res.bytes)) expect(img.colorSpace).toBe('/DeviceGray');
});

test('rasterize mode keeps page geometry, including rotation', async ({ page }) => {
  const res = await compressInPage(page, F.rotated, { level: 'balanced', mode: 'rasterize' });
  expect(res.ok).toBe(true);
  const sizes = await pageSizes(res.bytes);
  expect(sizes).toEqual([[792, 612, 0], [300, 500, 0]]);
  const imgs = await imagesOf(res.bytes);
  expect(imgs).toHaveLength(2);
  expect(imgs[0].width).toBe(Math.round(792 / 72 * res.stats.settings.dpi));
});

test('explains encrypted and non-PDF files', async ({ page }) => {
  const enc = await compressInPage(page, F.encrypted, {});
  expect(enc).toMatchObject({ ok: false, code: 'encrypted' });
  const encR = await compressInPage(page, F.encrypted, { mode: 'rasterize' });
  expect(encR).toMatchObject({ ok: false, code: 'encrypted' });
  const bad = await compressInPage(page, F.notPdf, {});
  expect(bad).toMatchObject({ ok: false, code: 'not-pdf' });
});

test('can be cancelled', async ({ page }) => {
  const b64 = fs.readFileSync(F.photo).toString('base64');
  const name = await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const ctrl = new AbortController();
    const p = window.PDFMini.compress(bytes, { signal: ctrl.signal, onProgress: () => ctrl.abort() });
    try { await p; return 'finished'; } catch (e) { return e.name; }
  }, b64);
  expect(name).toBe('AbortError');
});

test('combines files in order', async ({ page }) => {
  const files = [F.letter, F.a4, F.a5].map((f) => fs.readFileSync(f).toString('base64'));
  const b64 = await page.evaluate(async (files) => {
    const list = files.map((b, i) => ({ name: `f${i}.pdf`, bytes: Uint8Array.from(atob(b), (c) => c.charCodeAt(0)) }));
    const r = await window.PDFMini.combine(list);
    let s = '';
    for (let i = 0; i < r.bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, r.bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, files);
  const out = Buffer.from(b64, 'base64');
  expect(await pageSizes(out)).toEqual([[612, 792, 0], [595, 842, 0], [595, 842, 0], [420, 595, 0]]);
  expect(await textOf(out)).toEqual(['Letter page 1', 'A4 page 1', 'A4 page 2', 'A5 page 1']);
});

test('JPEG encoder output is byte-identical to Node in every browser', async ({ page }) => {
  const w = 256, h = 192;
  const px = Buffer.from(photoPixels(w, h, 42).buffer);
  const jpeg = (await import('node:module')).createRequire(import.meta.url)('../js/jpeg.js');
  const expected = crypto.createHash('sha256').update(jpeg.encode(new Uint8ClampedArray(px.buffer, px.byteOffset, px.length), w, h, { quality: 72 })).digest('hex');
  const actual = await page.evaluate(async ({ b64, w, h }) => {
    const px = Uint8ClampedArray.from(atob(b64), (c) => c.charCodeAt(0));
    const out = window.PDFMiniJPEG.encode(px, w, h, { quality: 72 });
    const digest = await crypto.subtle.digest('SHA-256', out);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }, { b64: px.toString('base64'), w, h });
  expect(actual).toBe(expected);
});

test('PDF/A-1 files are written without object streams', async ({ page }) => {
  const res = await compressInPage(page, F.pdfa1, { level: 'balanced' });
  expect(res.improved).toBe(true);
  expect(res.stats.pdfa).toBe(1);
  expect(res.bytes.includes(Buffer.from('/ObjStm'))).toBe(false);
  expect(res.bytes.subarray(0, 8).toString()).toBe('%PDF-1.7');
});

test('signed PDFs are flagged so the UI can warn', async ({ page }) => {
  const res = await compressInPage(page, F.signed, { level: 'balanced' });
  expect(res.stats.signed).toBe(true);
  const plain = await compressInPage(page, F.photo, { level: 'balanced' });
  expect(plain.stats.signed).toBe(false);
});
