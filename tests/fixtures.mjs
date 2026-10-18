// Deterministic test PDFs built with pdf-lib and the pdfmini JPEG encoder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  PDFDocument, PDFName, PDFNumber, PDFString, StandardFonts, degrees, rgb,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject,
} from 'pdf-lib';

const require = createRequire(import.meta.url);
const jpeg = require('../js/jpeg.js');

/** Small deterministic PRNG (mulberry32). */
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Photo-like RGBA pixels: gradients, waves, blobs and sensor noise. */
export function photoPixels(w, h, seed = 1) {
  const rand = rng(seed);
  const blobs = Array.from({ length: 12 }, () => ({ x: rand() * w, y: rand() * h, r: (0.05 + rand() * 0.2) * w, c: [rand() * 255, rand() * 255, rand() * 255] }));
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 40 + 160 * (x / w), g = 60 + 120 * (y / h), b = 120 + 60 * Math.sin(x / 37 + y / 53);
      for (const bl of blobs) {
        const d = Math.hypot(x - bl.x, y - bl.y) / bl.r;
        if (d < 1) { const k = (1 - d) * 0.8; r += (bl.c[0] - r) * k; g += (bl.c[1] - g) * k; b += (bl.c[2] - b) * k; }
      }
      const n = (rand() - 0.5) * 18;
      const i = (y * w + x) * 4;
      px[i] = r + n; px[i + 1] = g + n; px[i + 2] = b + n; px[i + 3] = 255;
    }
  }
  return px;
}

function jpegBytes(w, h, seed, opts = {}) {
  return jpeg.encode(photoPixels(w, h, seed), w, h, { quality: 92, ...opts });
}

async function finish(doc) {
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

function addText(page, font, text, y = 60) {
  page.drawText(text, { x: 50, y: page.getHeight() - y, size: 14, font, color: rgb(0.1, 0.1, 0.1) });
}

/** Two letter pages, each with a 2400x1800 JPEG drawn 4x3 inches (600 dpi). */
export async function photoPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++) {
    const page = doc.addPage([612, 792]);
    const img = await doc.embedJpg(jpegBytes(2400, 1800, i + 1));
    page.drawImage(img, { x: 72, y: 400, width: 288, height: 216 });
    addText(page, font, `Hello pdfmini page ${i + 1}`);
  }
  return finish(doc);
}

/** Text only: nothing to gain beyond lossless cleanups. */
export async function textPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  for (let p = 0; p < 3; p++) {
    const page = doc.addPage([612, 792]);
    for (let l = 0; l < 40; l++) addText(page, font, `Line ${l + 1} of page ${p + 1}: the quick brown fox jumps over the lazy dog.`, 50 + l * 17);
  }
  return finish(doc);
}

/** Lossless RGB image with an alpha channel (soft mask), like a pasted PNG. */
export async function pngAlphaPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const w = 1600, h = 1200;
  const px = photoPixels(w, h, 7);
  const rgbBytes = new Uint8Array(w * h * 3);
  const alpha = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    rgbBytes[i * 3] = px[j]; rgbBytes[i * 3 + 1] = px[j + 1]; rgbBytes[i * 3 + 2] = px[j + 2];
    const x = i % w, y = (i / w) | 0;
    alpha[i] = Math.hypot(x - w / 2, y - h / 2) < h / 2 ? 255 : 0;
  }
  const ctx = doc.context;
  const smask = ctx.register(ctx.flateStream(alpha, { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }));
  const image = ctx.register(ctx.flateStream(rgbBytes, { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, SMask: smask }));
  drawXObject(page, 'Im1', image, [400, 0, 0, 300, 100, 400]);
  return finish(doc);
}

/** Gray JPEG, CMYK raw image (needs PDF.js), and an indexed (palette) image. */
export async function mixedImagesPdf() {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const page = doc.addPage([612, 792]);
  const gray = await doc.embedJpg(jpegBytes(1800, 1200, 3, { gray: true }));
  page.drawImage(gray, { x: 50, y: 520, width: 240, height: 160 });

  const w = 900, h = 600;
  const px = photoPixels(w, h, 4);
  const cmyk = new Uint8Array(w * h * 4);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const c = 255 - px[j], m = 255 - px[j + 1], y = 255 - px[j + 2], k = Math.min(c, m, y);
    cmyk[j] = c - k; cmyk[j + 1] = m - k; cmyk[j + 2] = y - k; cmyk[j + 3] = k;
  }
  const cmykRef = ctx.register(ctx.flateStream(cmyk, { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceCMYK', BitsPerComponent: 8 }));
  drawXObject(page, 'ImC', cmykRef, [240, 0, 0, 160, 320, 520]);

  const pal = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) { pal[i * 3] = i; pal[i * 3 + 1] = 255 - i; pal[i * 3 + 2] = (i * 7) & 255; }
  const iw = 1200, ih = 800;
  const idx = new Uint8Array(iw * ih);
  const rand = rng(9);
  for (let i = 0; i < idx.length; i++) idx[i] = ((i % iw) / iw * 200 + rand() * 55) | 0;
  const lut = ctx.register(ctx.flateStream(pal));
  const indexed = ctx.register(ctx.flateStream(idx, {
    Type: 'XObject', Subtype: 'Image', Width: iw, Height: ih, BitsPerComponent: 8,
    ColorSpace: ['Indexed', 'DeviceRGB', 255, lut],
  }));
  drawXObject(page, 'ImI', indexed, [240, 0, 0, 160, 50, 300]);
  return finish(doc);
}

/** An image inside a Form XObject that is itself scaled down by 0.25. */
export async function formXObjectPdf() {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const page = doc.addPage([612, 792]);
  const img = await doc.embedJpg(jpegBytes(2000, 1500, 5));
  // pdf-lib embeds lazily; flush so the image ref exists before we use it.
  await doc.flush();
  const content = 'q 1600 0 0 1200 0 0 cm /Im0 Do Q';
  const form = ctx.register(ctx.stream(content, {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1600, 1200], Matrix: [0.25, 0, 0, 0.25, 0, 0],
    Resources: { XObject: { Im0: img.ref } },
  }));
  drawXObject(page, 'Fm0', form, [1, 0, 0, 1, 100, 300]);
  return finish(doc);
}

/** Landscape-rotated page and a page with an unusual size. */
export async function rotatedPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const a = doc.addPage([612, 792]);
  a.setRotation(degrees(90));
  a.drawImage(await doc.embedJpg(jpegBytes(1600, 1200, 6)), { x: 50, y: 300, width: 400, height: 300 });
  addText(a, font, 'Rotated page');
  const b = doc.addPage([300, 500]);
  addText(b, font, 'Small page');
  return finish(doc);
}

/** A photo page carrying a (dummy) digital signature field. */
export async function signedPdf() {
  const doc = await PDFDocument.load(await photoPdf());
  const ctx = doc.context;
  const sig = ctx.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached' });
  const field = ctx.register(ctx.obj({ FT: 'Sig', T: PDFString.of('Signature1'), V: ctx.register(sig), Type: 'Annot', Subtype: 'Widget', Rect: [0, 0, 0, 0] }));
  doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ SigFlags: 3, Fields: [field] }));
  return finish(doc);
}

/** A photo PDF that declares PDF/A-1b conformance in its XMP metadata. */
export async function pdfa1Pdf() {
  const doc = await PDFDocument.load(await photoPdf());
  const xmp = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="1" pdfaid:conformance="B"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  const meta = doc.context.register(doc.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' }));
  doc.catalog.set(PDFName.of('Metadata'), meta);
  return finish(doc);
}

/** Pages of a given size (for combine order checks). */
export async function sizedPdf(sizes, label) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  sizes.forEach((s, i) => addText(doc.addPage(s), font, `${label} page ${i + 1}`, 40));
  return finish(doc);
}

function drawXObject(page, name, ref, m) {
  page.node.setXObject(PDFName.of(name), ref);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...m), drawObject(name), popGraphicsState());
}

const builders = { photoPdf, textPdf, pngAlphaPdf, mixedImagesPdf, formXObjectPdf, rotatedPdf, signedPdf, pdfa1Pdf };

/** Write all fixtures to a temp dir (once per process) and return their paths. */
let cache = null;
export async function fixtureFiles() {
  if (cache) return cache;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfmini-fixtures-'));
  const out = {};
  for (const [name, build] of Object.entries(builders)) {
    const file = path.join(dir, name.replace(/Pdf$/, '') + '.pdf');
    fs.writeFileSync(file, await build());
    out[name.replace(/Pdf$/, '')] = file;
  }
  out.letter = path.join(dir, 'letter.pdf');
  fs.writeFileSync(out.letter, await sizedPdf([[612, 792]], 'Letter'));
  out.a4 = path.join(dir, 'a4.pdf');
  fs.writeFileSync(out.a4, await sizedPdf([[595, 842], [595, 842]], 'A4'));
  out.a5 = path.join(dir, 'a5.pdf');
  fs.writeFileSync(out.a5, await sizedPdf([[420, 595]], 'A5'));
  out.notPdf = path.join(dir, 'notes.pdf');
  fs.writeFileSync(out.notPdf, 'This is plain text, not a PDF.\n');
  out.encrypted = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'encrypted.pdf');
  cache = out;
  return out;
}

export { PDFDocument, PDFName, PDFNumber };
