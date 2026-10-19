import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test as base, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFRawStream, PDFRef, PDFArray, decodePDFRawStream } from 'pdf-lib';
import { routeCdn } from '../tools/cdn-routes.mjs';

/** Every test context serves the CDN libraries from node_modules. */
export const test = base.extend({
  context: async ({ context }, use) => {
    await routeCdn(context);
    await use(context);
  },
});
export { expect };

export async function openHarness(page) {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => !!window.PDFMini && !!window.PDFLib);
}

/** Run PDFMini.compress in the page on a local file. */
export async function compressInPage(page, file, options = {}) {
  const b64 = fs.readFileSync(file).toString('base64');
  const res = await page.evaluate(async ({ b64, options }) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    try {
      const r = await window.PDFMini.compress(bytes.buffer, options);
      let s = '';
      for (let i = 0; i < r.bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, r.bytes.subarray(i, i + 0x8000));
      return { ok: true, b64: btoa(s), improved: r.improved, mode: r.mode, stats: r.stats };
    } catch (e) {
      return { ok: false, name: e.name, code: e.code, message: e.message };
    }
  }, { b64, options });
  if (res.ok) res.bytes = Buffer.from(res.b64, 'base64');
  return res;
}

/** Image XObjects in a PDF with their key properties. */
export async function imagesOf(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const out = [];
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
    const d = obj.dict;
    const get = (k) => ctx.lookup(d.get(PDFName.of(k)));
    const filter = get('Filter');
    const cs = get('ColorSpace');
    out.push({
      ref: ref.toString(),
      width: get('Width').asNumber(),
      height: get('Height').asNumber(),
      filter: filter instanceof PDFArray ? filter.asArray().map(String).join(' ') : String(filter),
      colorSpace: cs instanceof PDFArray ? String(cs.get(0)) : String(cs),
      smask: d.get(PDFName.of('SMask')) instanceof PDFRef ? d.get(PDFName.of('SMask')).toString() : null,
      bytes: obj.contents.length,
    });
  }
  return out;
}

export async function pageSizes(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map((p) => {
    const { width, height } = p.getSize();
    return [Math.round(width), Math.round(height), p.getRotation().angle];
  });
}

/** Text of every page via PDF.js (an independent parser). */
export async function textOf(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false });
  const pdf = await task.promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    pages.push(tc.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim());
  }
  await task.destroy();
  return pages;
}

/** Number of Form XObjects in a PDF. */
export async function formXObjectCount(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  let n = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Form')) n++;
  }
  return n;
}

/** Whether a PDF has XFA data and usage rights, and its text field values. */
export async function formInfo(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const acroForm = doc.catalog.lookup(PDFName.of('AcroForm'));
  const info = { xfa: !!acroForm && acroForm.has(PDFName.of('XFA')), perms: doc.catalog.has(PDFName.of('Perms')) };
  // pdf-lib strips XFA (with a warning) when asked for the form.
  info.fields = info.xfa ? null : Object.fromEntries(doc.getForm().getFields().map((f) => [f.getName(), f.getText()]));
  return info;
}

/** RGBA pixels of every page rendered by PDF.js, to check output looks identical. */
export async function renderPages(bytes, scale = 1) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const fonts = fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url));
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false, standardFontDataUrl: fonts });
  const pdf = await task.promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale });
    const { canvas, context } = pdf.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvasContext: context, canvas, viewport }).promise;
    pages.push(Buffer.from(context.getImageData(0, 0, canvas.width, canvas.height).data));
  }
  await task.destroy();
  return pages;
}

/** Decoded page content streams (unchanged content = unchanged text and vectors). */
export async function contentStreams(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map((p) => {
    const c = p.node.Contents();
    const list = c instanceof PDFArray ? c.asArray() : [c];
    return list.map((r) => {
      const s = doc.context.lookup(r);
      return Buffer.from(s.dict.get(PDFName.of('Filter')) ? decodePDFRawStream(s).decode() : s.contents).toString('latin1');
    }).join('\n');
  });
}
