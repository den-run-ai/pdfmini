/*
 * pdfmini engine — client-side PDF compression and merging.
 *
 * Default ("images") mode keeps text, vectors, links and forms intact and
 * only re-encodes embedded images: each image is resampled to the target DPI
 * for the size it is actually drawn on the page and re-encoded as JPEG with a
 * deterministic encoder, so results are the same on every browser. Lossless
 * cleanups (unused objects, duplicate streams, private app data, uncompressed
 * streams, object streams) are applied on top. If nothing gets smaller the
 * original file is returned untouched.
 *
 * "rasterize" mode renders every page to a JPEG (via PDF.js, loaded on demand).
 *
 * Requires pdf-lib (global PDFLib) and js/jpeg.js (global PDFMiniJPEG).
 */
(function (root) {
  'use strict';

  const L = () => root.PDFLib;

  // ---------------------------------------------------------------- settings

  /**
   * Compression levels: target image resolution and JPEG quality. Calibrated
   * against SSIM of rendered pages on scans, photos, slides and screenshots
   * (see README): each step roughly halves or doubles the image bytes, and
   * Strong keeps 8-10 pt scanned text readable.
   */
  const LEVELS = {
    light: { dpi: 200, quality: 82 },
    balanced: { dpi: 144, quality: 72 },
    strong: { dpi: 110, quality: 55 },
  };

  const PDFJS_VERSION = '6.4.299';
  // Self-hosters can point this at their own copy of the pdfjs-dist package.
  const PDFJS_BASE = (root.PDFMINI_CONFIG && root.PDFMINI_CONFIG.pdfjsBase) ||
    `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/`;
  // Subresource integrity for the PDF.js modules (verified before import).
  const PDFJS_MODULES = {
    main: ['legacy/build/pdf.min.mjs', 'sha384-oPqHr8MeYfJpkh4zgHbWYiuwabTzthRiOS5tSWsWGmCVWlwqIkS9coGro5aa48OF'],
    worker: ['legacy/build/pdf.worker.min.mjs', 'sha384-tINN5IYq7dFaoHBUBBc2yfxGwR38mZn9GhaX31UofKYNgAg/3y8A7IjUI3GuEg/8'],
  };

  /** iOS Safari refuses canvases larger than this (4096 x 4096). */
  const MAX_CANVAS_PIXELS = 16777216;
  /** Images bigger than this are left alone to stay within mobile memory. */
  const MAX_SOURCE_PIXELS = 100e6;
  /** Images whose stream is smaller than this are not worth touching. */
  const MIN_IMAGE_BYTES = 6 * 1024;
  /** Only resample when the image is at least this much sharper than needed. */
  const RESAMPLE_SLACK = 1.15;
  /** Even flat images cost about this much as JPEG; smaller sources are left alone. */
  const MIN_JPEG_BYTES_PER_PIXEL = 0.02;
  /** A result must be at least this much smaller than the input to be used. */
  const MIN_SAVING = 0.01;

  const scriptBase = (() => {
    try {
      const src = root.document && root.document.currentScript && root.document.currentScript.src;
      return src ? src.slice(0, src.lastIndexOf('/') + 1) : '';
    } catch (e) {
      return '';
    }
  })();

  // ------------------------------------------------------------------ errors

  class PDFMiniError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'PDFMiniError';
      this.code = code;
    }
  }

  function abortError() {
    const e = new Error('Cancelled');
    e.name = 'AbortError';
    return e;
  }

  function checkAbort(signal) {
    if (signal && signal.aborted) throw abortError();
  }

  // --------------------------------------------------------------- utilities

  function toUint8(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw new TypeError('Expected ArrayBuffer or Uint8Array');
  }

  /** PDF files start with "%PDF-" (readers accept it within the first 1 KB). */
  function isPdf(bytes) {
    const n = Math.min(bytes.length - 4, 1024);
    for (let i = 0; i < n; i++) {
      if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) return true;
    }
    return false;
  }

  const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 0));

  function releaseCanvas(canvas) {
    // Safari keeps canvas memory around until the backing store is shrunk.
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }

  function createCanvas(w, h) {
    const c = root.document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function context2d(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    return ctx;
  }

  function ascii(bytes, start, end) {
    let s = '';
    for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  // ------------------------------------------------------- pdf-lib helpers

  const names = {};
  function N(name) {
    return names[name] || (names[name] = L().PDFName.of(name));
  }

  function num(obj, fallback) {
    return obj instanceof L().PDFNumber ? obj.asNumber() : fallback;
  }

  function lookup(ctx, obj) {
    return obj instanceof L().PDFRef ? ctx.lookup(obj) : obj;
  }

  function dictGet(ctx, dict, key) {
    return dict ? lookup(ctx, dict.get(N(key))) : undefined;
  }

  function filtersOf(ctx, dict) {
    const f = dictGet(ctx, dict, 'Filter');
    if (f instanceof L().PDFName) return [f.decodeText()];
    if (f instanceof L().PDFArray) return f.asArray().map((x) => lookup(ctx, x)).filter((x) => x instanceof L().PDFName).map((x) => x.decodeText());
    return [];
  }

  function decodeParmsOf(ctx, dict, index) {
    const p = dictGet(ctx, dict, 'DecodeParms');
    if (p instanceof L().PDFDict) return index === 0 ? p : undefined;
    if (p instanceof L().PDFArray) {
      const v = lookup(ctx, p.get(index));
      return v instanceof L().PDFDict ? v : undefined;
    }
    return undefined;
  }

  /** Decode all filters of a stream that pdf-lib supports (no predictors). */
  function decodeStream(stream) {
    return L().decodePDFRawStream(stream).decode();
  }

  const SUPPORTED_DECODE = new Set(['FlateDecode', 'LZWDecode', 'ASCII85Decode', 'ASCIIHexDecode', 'RunLengthDecode']);

  /** Decoded stream contents, or null if a filter is unsupported or data is corrupt. */
  function tryDecode(ctx, stream) {
    const filters = filtersOf(ctx, stream.dict);
    if (!filters.every((f) => SUPPORTED_DECODE.has(f))) return null;
    if (filters.length === 0) return stream.contents;
    try {
      return decodeStream(stream);
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------- deflate / inflate

  async function streamThrough(bytes, transform) {
    const out = new Response(new Blob([bytes]).stream().pipeThrough(transform));
    return new Uint8Array(await out.arrayBuffer());
  }

  async function deflate(bytes) {
    if (typeof CompressionStream === 'function') {
      try { return await streamThrough(bytes, new CompressionStream('deflate')); } catch (e) { /* fall back */ }
    }
    return pakoDeflate(bytes);
  }

  // pdf-lib bundles pako; flateStream() is the public way to reach it.
  let pakoContext = null;
  function pakoDeflate(bytes) {
    if (!pakoContext) pakoContext = L().PDFContext.create();
    return pakoContext.flateStream(bytes).contents;
  }

  // ----------------------------------------------------- content scanning

  const WS = new Uint8Array(256);
  [0, 9, 10, 12, 13, 32].forEach((c) => { WS[c] = 1; });
  const DELIM = new Uint8Array(256);
  '()<>[]{}/%'.split('').forEach((ch) => { DELIM[ch.charCodeAt(0)] = 1; });

  function skipLiteralString(b, i) {
    let depth = 0;
    for (const n = b.length; i < n; i++) {
      const c = b[i];
      if (c === 0x5c) { i++; continue; } // backslash escape
      if (c === 0x28) depth++;
      else if (c === 0x29 && --depth === 0) return i + 1;
    }
    return i;
  }

  /** Skip a [...] array or <<...>> dictionary operand (nested, with strings). */
  function skipComposite(b, i) {
    let depth = 0;
    const n = b.length;
    while (i < n) {
      const c = b[i];
      if (c === 0x28) { i = skipLiteralString(b, i); continue; }
      if (c === 0x25) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; }
      if (c === 0x5b) { depth++; i++; } else if (c === 0x5d) { depth--; i++; } else if (c === 0x3c && b[i + 1] === 0x3c) { depth++; i += 2; } else if (c === 0x3e && b[i + 1] === 0x3e) { depth--; i += 2; } else if (c === 0x3c) { while (i < n && b[i] !== 0x3e) i++; i++; } else i++;
      if (depth <= 0) return i;
    }
    return i;
  }

  /** Skip inline image data after "ID"; returns the index after "EI". */
  function skipInlineImage(b, i) {
    const n = b.length;
    i++; // the single whitespace after ID
    for (let j = i; j < n - 1; j++) {
      if (b[j] === 0x45 && b[j + 1] === 0x49 && (j === 0 || WS[b[j - 1]]) && (j + 2 >= n || WS[b[j + 2]] || DELIM[b[j + 2]])) {
        // Make sure what follows looks like content, not more binary data.
        let ok = true;
        for (let k = j + 2; k < Math.min(n, j + 34); k++) {
          const c = b[k];
          if (c > 0x7e || (c < 0x20 && !WS[c])) { ok = false; break; }
        }
        if (ok) return j + 2;
      }
    }
    return n;
  }

  /**
   * Tokenize a content stream, calling onOp(operator, operands) for every
   * operator. Operands are numbers, {name} objects, or null for anything else.
   * Returns false if the token budget ran out.
   */
  function tokenize(b, onOp, budget) {
    const n = b.length;
    const ops = [];
    let i = 0;
    while (i < n) {
      const c = b[i];
      if (WS[c]) { i++; continue; }
      if (--budget.left < 0) return false;
      if (c === 0x25) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; }
      if (c === 0x2f) {
        let j = i + 1;
        while (j < n && !WS[b[j]] && !DELIM[b[j]]) j++;
        ops.push({ name: ascii(b, i + 1, j) });
        i = j;
        continue;
      }
      if (c === 0x28) { i = skipLiteralString(b, i); ops.push(null); continue; }
      if (c === 0x5b || (c === 0x3c && b[i + 1] === 0x3c)) { i = skipComposite(b, i); ops.push(null); continue; }
      if (c === 0x3c) { while (i < n && b[i] !== 0x3e) i++; i++; ops.push(null); continue; }
      if (DELIM[c]) { i++; continue; } // stray delimiter
      let j = i;
      while (j < n && !WS[b[j]] && !DELIM[b[j]]) j++;
      if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {
        ops.push(parseFloat(ascii(b, i, j)));
      } else {
        const op = ascii(b, i, j);
        if (op === 'ID') { j = skipInlineImage(b, j); } else if (op !== 'BI') onOp(op, ops);
        ops.length = 0;
      }
      i = j;
    }
    return true;
  }

  function mul(m, n) {
    return [
      m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
      m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
      m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
    ];
  }

  function matrixOf(ctx, dict, key) {
    const a = dictGet(ctx, dict, key);
    if (!(a instanceof L().PDFArray) || a.size() !== 6) return [1, 0, 0, 1, 0, 0];
    const m = a.asArray().map((x) => num(lookup(ctx, x), NaN));
    return m.every(Number.isFinite) ? m : [1, 0, 0, 1, 0, 0];
  }

  function streamBytes(ctx, contents) {
    const parts = [];
    const list = contents instanceof L().PDFArray ? contents.asArray() : [contents];
    for (const item of list) {
      const s = lookup(ctx, item);
      if (s instanceof L().PDFRawStream) {
        const d = tryDecode(ctx, s);
        if (d) parts.push(d);
      }
    }
    if (parts.length === 1) return parts[0];
    const total = parts.reduce((a, p) => a + p.length + 1, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; out[o++] = 10; }
    return out;
  }

  /**
   * Find the largest size (in points) at which each image XObject is drawn,
   * by interpreting the CTM in page, form and annotation content streams.
   * Returns Map<PDFRef, {w, h}>; images not found are absent.
   */
  function scanImagePlacements(doc) {
    const ctx = doc.context;
    const placements = new Map();
    const budget = { left: 20e6 };
    const record = (ref, ctm, unit) => {
      const w = Math.hypot(ctm[0], ctm[1]) * unit;
      const h = Math.hypot(ctm[2], ctm[3]) * unit;
      if (!(w >= 1 && h >= 1) || !Number.isFinite(w + h)) return;
      const p = placements.get(ref);
      if (!p) placements.set(ref, { w, h });
      else { p.w = Math.max(p.w, w); p.h = Math.max(p.h, h); }
    };

    const walk = (bytes, resources, startCtm, unit, depth, active) => {
      let ctm = startCtm;
      const stack = [];
      const xobjects = dictGet(ctx, resources, 'XObject');
      return tokenize(bytes, (op, args) => {
        if (op === 'q') { if (stack.length < 512) stack.push(ctm); } else if (op === 'Q') { if (stack.length) ctm = stack.pop(); } else if (op === 'cm') {
          if (args.length >= 6) {
            const m = args.slice(-6);
            if (m.every((v) => typeof v === 'number' && Number.isFinite(v))) ctm = mul(m, ctm);
          }
        } else if (op === 'Do') {
          const nameArg = args[args.length - 1];
          if (!nameArg || !nameArg.name || !(xobjects instanceof L().PDFDict)) return;
          const ref = xobjects.get(L().PDFName.of(nameArg.name));
          const xo = lookup(ctx, ref);
          if (!(xo instanceof L().PDFRawStream)) return;
          const subtype = dictGet(ctx, xo.dict, 'Subtype');
          if (subtype === N('Image')) {
            if (ref instanceof L().PDFRef) record(ref, ctm, unit);
          } else if (subtype === N('Form') && depth < 12 && !active.has(xo)) {
            const content = tryDecode(ctx, xo);
            if (!content) return;
            const res = dictGet(ctx, xo.dict, 'Resources');
            active.add(xo);
            walk(content, res instanceof L().PDFDict ? res : resources, mul(matrixOf(ctx, xo.dict, 'Matrix'), ctm), unit, depth + 1, active);
            active.delete(xo);
          }
        }
      }, budget);
    };

    for (const page of doc.getPages()) {
      const node = page.node;
      const unit = num(lookup(ctx, node.get(N('UserUnit'))), 1) || 1;
      const resources = node.Resources();
      const contents = node.Contents();
      if (contents) walk(streamBytes(ctx, contents), resources, [1, 0, 0, 1, 0, 0], unit, 0, new Set());
      // Annotation appearance streams are forms mapped onto the annotation's Rect.
      const annots = node.Annots();
      if (!annots) continue;
      for (const a of annots.asArray()) {
        const annot = lookup(ctx, a);
        if (!(annot instanceof L().PDFDict)) continue;
        const rect = dictGet(ctx, annot, 'Rect');
        const ap = dictGet(ctx, annot, 'AP');
        const normal = ap instanceof L().PDFDict ? dictGet(ctx, ap, 'N') : undefined;
        if (!(rect instanceof L().PDFArray) || !normal) continue;
        const r = rect.asArray().map((x) => num(lookup(ctx, x), 0));
        const forms = normal instanceof L().PDFRawStream ? [normal]
          : normal instanceof L().PDFDict ? normal.values().map((v) => lookup(ctx, v)).filter((v) => v instanceof L().PDFRawStream) : [];
        for (const form of forms) {
          const content = tryDecode(ctx, form);
          if (!content) continue;
          const m = matrixOf(ctx, form.dict, 'Matrix');
          const bbox = dictGet(ctx, form.dict, 'BBox');
          if (!(bbox instanceof L().PDFArray)) continue;
          const bb = bbox.asArray().map((x) => num(lookup(ctx, x), 0));
          const xs = [], ys = [];
          for (const [x, y] of [[bb[0], bb[1]], [bb[2], bb[1]], [bb[0], bb[3]], [bb[2], bb[3]]]) {
            xs.push(m[0] * x + m[2] * y + m[4]);
            ys.push(m[1] * x + m[3] * y + m[5]);
          }
          const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys);
          const rw = Math.abs(r[2] - r[0]), rh = Math.abs(r[3] - r[1]);
          if (!(bw > 0 && bh > 0)) continue;
          const sx = rw / bw, sy = rh / bh;
          const A = [sx, 0, 0, sy, Math.min(r[0], r[2]) - Math.min(...xs) * sx, Math.min(r[1], r[3]) - Math.min(...ys) * sy];
          const res = dictGet(ctx, form.dict, 'Resources');
          walk(content, res instanceof L().PDFDict ? res : resources, mul(m, A), unit, 1, new Set([form]));
        }
      }
    }
    return { placements, complete: budget.left >= 0 };
  }

  // ------------------------------------------------------- image analysis

  /** Describe an image's colour space: {kind, n, base?, hival?, lookup?, cs}. */
  function colorSpaceInfo(ctx, csObj, depth) {
    const cs = lookup(ctx, csObj);
    if (depth > 4 || cs === undefined) return { kind: 'unknown', n: 0 };
    if (cs instanceof L().PDFName) {
      switch (cs.decodeText()) {
        case 'DeviceGray': case 'G': case 'CalGray': return { kind: 'gray', n: 1 };
        case 'DeviceRGB': case 'RGB': case 'CalRGB': return { kind: 'rgb', n: 3 };
        case 'DeviceCMYK': case 'CMYK': return { kind: 'cmyk', n: 4 };
        default: return { kind: 'unknown', n: 0 };
      }
    }
    if (cs instanceof L().PDFArray && cs.size() > 0) {
      const fam = lookup(ctx, cs.get(0));
      const family = fam instanceof L().PDFName ? fam.decodeText() : '';
      if (family === 'ICCBased') {
        const s = lookup(ctx, cs.get(1));
        const n = s instanceof L().PDFRawStream ? num(dictGet(ctx, s.dict, 'N'), 0) : 0;
        return n === 1 ? { kind: 'gray', n: 1, icc: true } : n === 3 ? { kind: 'rgb', n: 3, icc: true } : n === 4 ? { kind: 'cmyk', n: 4 } : { kind: 'unknown', n: 0 };
      }
      if (family === 'CalRGB') return { kind: 'rgb', n: 3 };
      if (family === 'CalGray') return { kind: 'gray', n: 1 };
      if (family === 'Indexed' || family === 'I') {
        const base = colorSpaceInfo(ctx, cs.get(1), depth + 1);
        const hival = num(lookup(ctx, cs.get(2)), -1);
        const lut = lookup(ctx, cs.get(3));
        let table = null;
        if (lut instanceof L().PDFRawStream) table = tryDecode(ctx, lut);
        else if (lut instanceof L().PDFHexString || lut instanceof L().PDFString) table = lut.asBytes();
        return { kind: 'indexed', n: 1, base, hival, table };
      }
      return { kind: family === 'Lab' ? 'lab' : 'unknown', n: 0 };
    }
    return { kind: 'unknown', n: 0 };
  }

  function isDefaultDecode(ctx, dict, n, bpc) {
    const d = dictGet(ctx, dict, 'Decode');
    if (!(d instanceof L().PDFArray)) return true;
    const v = d.asArray().map((x) => num(lookup(ctx, x), NaN));
    const max = bpc ? (1 << bpc) - 1 : 1;
    for (let i = 0; i < v.length; i += 2) {
      if (v[i] !== 0 || (v[i + 1] !== 1 && v[i + 1] !== max)) return false;
    }
    return v.length === 2 * n || v.length === 0;
  }

  /** Strip APP1 (EXIF/XMP) and APP2 (ICC) so browsers decode raw pixel order and values. */
  function stripJpegMetadata(bytes) {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
    const parts = [bytes.subarray(0, 2)];
    let i = 2;
    while (i + 4 <= bytes.length && bytes[i] === 0xff) {
      const marker = bytes[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xda || marker === 0xd9) break; // start of scan: rest is data
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (marker !== 0xe1 && marker !== 0xe2) parts.push(bytes.subarray(i, i + 2 + len));
      i += 2 + len;
    }
    parts.push(bytes.subarray(i));
    if (parts.length === 2) return bytes;
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  /** Inspect a JPEG header: {components, adobe, transform, quality} or null. */
  function jpegInfo(bytes) {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    const info = { components: 0, adobe: false, transform: -1, quality: 0, progressive: false };
    let i = 2;
    while (i + 4 <= bytes.length && bytes[i] === 0xff) {
      const marker = bytes[i + 1];
      if (marker === 0xff) { i++; continue; }
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      const seg = i + 4;
      if (marker === 0xdb && !info.quality) info.quality = estimateQuality(bytes, seg, seg + len - 2);
      else if (marker === 0xee && len >= 12 && ascii(bytes, seg, seg + 5) === 'Adobe') { info.adobe = true; info.transform = bytes[seg + 11]; } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        info.components = bytes[seg + 5];
        info.progressive = marker === 0xc2;
      } else if (marker === 0xda) break;
      i += 2 + len;
    }
    return info.components ? info : null;
  }

  /** Estimate IJG-equivalent quality from the luminance quantization table. */
  function estimateQuality(bytes, start, end) {
    const STD = [16, 11, 12, 14, 12, 10, 16, 14, 13, 14, 18, 17, 16, 19, 24, 40, 26, 24, 22, 22, 24, 49, 35, 37, 29, 40, 58, 51, 61, 60, 57, 51, 56, 55, 64, 72, 92, 78, 64, 68, 87, 69, 55, 56, 80, 109, 81, 87, 95, 98, 103, 104, 103, 62, 77, 113, 121, 112, 100, 120, 92, 101, 103, 99];
    let i = start;
    while (i < end) {
      const pq = bytes[i] >> 4, tq = bytes[i] & 15;
      i++;
      const size = pq ? 128 : 64;
      if (tq === 0) {
        let sum = 0;
        for (let k = 0; k < 64; k++) {
          const q = pq ? (bytes[i + 2 * k] << 8) | bytes[i + 2 * k + 1] : bytes[i + k];
          sum += (q * 100) / STD[k];
        }
        const scale = sum / 64;
        return Math.max(1, Math.min(100, Math.round(scale <= 100 ? (200 - scale) / 2 : 5000 / scale)));
      }
      i += size;
    }
    return 0;
  }

  // ----------------------------------------------------- pixel decoding

  function unpredict(data, parms) {
    const predictor = parms ? num(parms.get(N('Predictor')), 1) : 1;
    if (predictor <= 1) return data;
    // Spec defaults, as PDF.js applies them.
    const colors = num(parms.get(N('Colors')), 1);
    const bpc = num(parms.get(N('BitsPerComponent')), 8);
    const columns = num(parms.get(N('Columns')), 1);
    const bpp = Math.max(1, (colors * bpc) >> 3);
    const rowLen = (columns * colors * bpc + 7) >> 3;
    if (predictor === 2) { // TIFF predictor, 8 bpc only
      if (bpc !== 8) return null;
      const out = new Uint8Array(data);
      for (let r = 0; r + rowLen <= out.length; r += rowLen) {
        for (let k = bpp; k < rowLen; k++) out[r + k] = (out[r + k] + out[r + k - bpp]) & 255;
      }
      return out;
    }
    const rows = Math.floor(data.length / (rowLen + 1));
    const out = new Uint8Array(rows * rowLen);
    let prev = new Uint8Array(rowLen);
    for (let r = 0; r < rows; r++) {
      const type = data[r * (rowLen + 1)];
      const src = r * (rowLen + 1) + 1;
      const dst = r * rowLen;
      for (let k = 0; k < rowLen; k++) {
        const x = data[src + k];
        const a = k >= bpp ? out[dst + k - bpp] : 0;
        const b = prev[k];
        const c = k >= bpp ? prev[k - bpp] : 0;
        let v;
        switch (type) {
          case 0: v = x; break;
          case 1: v = x + a; break;
          case 2: v = x + b; break;
          case 3: v = x + ((a + b) >> 1); break;
          case 4: {
            const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
            v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
            break;
          }
          default: return null;
        }
        out[dst + k] = v & 255;
      }
      prev = out.subarray(dst, dst + rowLen);
    }
    return out;
  }

  /**
   * Decode a losslessly-compressed image (gray/RGB/indexed, 1-16 bpc) into
   * ImageData-compatible RGBA. Returns null if unsupported.
   */
  function decodeRawImage(ctx, img) {
    const { stream, width: w, height: h, bpc, cs } = img;
    const filters = filtersOf(ctx, stream.dict);
    if (!filters.every((f) => SUPPORTED_DECODE.has(f))) return null;
    let data = tryDecode(ctx, stream);
    if (!data) return null;
    const colors = cs.kind === 'indexed' ? 1 : cs.n;
    const parms = decodeParmsOf(ctx, stream.dict, filters.length - 1);
    data = unpredict(data, parms);
    if (!data) return null;
    const rowLen = (w * colors * bpc + 7) >> 3;
    if (data.length < rowLen * h) return null;

    const rgba = new Uint8ClampedArray(w * h * 4);
    const sample = (row, idx) => { // idx-th sample in row
      if (bpc === 8) return data[row + idx];
      if (bpc === 16) return data[row + idx * 2];
      const bit = idx * bpc;
      return (data[row + (bit >> 3)] >> (8 - bpc - (bit & 7))) & ((1 << bpc) - 1);
    };
    if (cs.kind === 'indexed') {
      const base = cs.base;
      const table = cs.table;
      if (!table || (base.kind !== 'rgb' && base.kind !== 'gray') || bpc > 8) return null;
      const bn = base.n;
      const pal = new Uint8Array(256 * 3);
      for (let k = 0; k <= Math.min(255, cs.hival); k++) {
        for (let c = 0; c < 3; c++) pal[k * 3 + c] = table[k * bn + (bn === 1 ? 0 : c)] || 0;
      }
      for (let y = 0, o = 0; y < h; y++) {
        const row = y * rowLen;
        for (let x = 0; x < w; x++, o += 4) {
          const k = sample(row, x) * 3;
          rgba[o] = pal[k]; rgba[o + 1] = pal[k + 1]; rgba[o + 2] = pal[k + 2]; rgba[o + 3] = 255;
        }
      }
      return rgba;
    }
    if (cs.kind !== 'gray' && cs.kind !== 'rgb') return null;
    if (bpc === 8) { // common case: plain interleaved bytes
      const n = w * h;
      if (colors === 3) {
        for (let i = 0, j = 0, o = 0; i < n; i++, j += 3, o += 4) { rgba[o] = data[j]; rgba[o + 1] = data[j + 1]; rgba[o + 2] = data[j + 2]; rgba[o + 3] = 255; }
      } else {
        for (let i = 0, o = 0; i < n; i++, o += 4) { const v = data[i]; rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v; rgba[o + 3] = 255; }
      }
      return rgba;
    }
    const scale = bpc === 16 ? 1 : 255 / ((1 << bpc) - 1);
    for (let y = 0, o = 0; y < h; y++) {
      const row = y * rowLen;
      for (let x = 0; x < w; x++, o += 4) {
        if (colors === 1) {
          const v = sample(row, x) * scale;
          rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v;
        } else {
          rgba[o] = sample(row, x * 3) * scale;
          rgba[o + 1] = sample(row, x * 3 + 1) * scale;
          rgba[o + 2] = sample(row, x * 3 + 2) * scale;
        }
        rgba[o + 3] = 255;
      }
    }
    return rgba;
  }

  async function decodeJpegToSource(bytes) {
    const blob = new Blob([stripJpegMetadata(bytes)], { type: 'image/jpeg' });
    if (typeof createImageBitmap === 'function') {
      try { return await createImageBitmap(blob); } catch (e) { /* fall back to <img> */ }
    }
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      if (img.decode) await img.decode();
      else await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function sourceSize(src) {
    return { w: src.naturalWidth || src.width, h: src.naturalHeight || src.height };
  }

  /**
   * Resample a drawable source to exactly tw x th and return RGBA pixels.
   * Large reductions are done in halving steps so every browser gets a
   * proper area average instead of aliasing.
   */
  function resampleToPixels(src, tw, th) {
    let { w, h } = sourceSize(src);
    let current = src;
    let temp = null;
    while (w / 2 >= tw && h / 2 >= th) {
      let nw = Math.ceil(w / 2), nh = Math.ceil(h / 2);
      if (nw * nh > MAX_CANVAS_PIXELS) {
        const f = Math.sqrt(MAX_CANVAS_PIXELS / (nw * nh));
        nw = Math.max(tw, Math.floor(nw * f));
        nh = Math.max(th, Math.floor(nh * f));
      }
      const c = createCanvas(nw, nh);
      const g = context2d(c);
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(current, 0, 0, w, h, 0, 0, nw, nh);
      if (temp) releaseCanvas(temp);
      temp = c;
      current = c;
      w = nw; h = nh;
    }
    const out = createCanvas(tw, th);
    const g = context2d(out);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.fillStyle = '#fff';
    g.fillRect(0, 0, tw, th);
    g.drawImage(current, 0, 0, w, h, 0, 0, tw, th);
    if (temp) releaseCanvas(temp);
    const data = g.getImageData(0, 0, tw, th).data;
    releaseCanvas(out);
    return data;
  }

  function rgbaToCanvasSource(rgba, w, h) {
    const c = createCanvas(w, h);
    context2d(c).putImageData(new ImageData(rgba, w, h), 0, 0);
    return c;
  }

  /** Pack RGBA into gray (1 channel, luma) or RGB (3 channels) bytes. */
  function channels(rgba, gray) {
    const n = rgba.length >> 2;
    const out = new Uint8Array(n * (gray ? 1 : 3));
    if (gray) {
      for (let i = 0, j = 0; i < n; i++, j += 4) out[i] = (rgba[j] * 299 + rgba[j + 1] * 587 + rgba[j + 2] * 114 + 500) / 1000;
    } else {
      for (let i = 0, j = 0, o = 0; i < n; i++, j += 4) { out[o++] = rgba[j]; out[o++] = rgba[j + 1]; out[o++] = rgba[j + 2]; }
    }
    return out;
  }

  /**
   * Apply PNG row filters (choosing per row by minimum absolute sum, like
   * libpng) so Flate compresses photos and gradients much better.
   */
  function pngPredict(data, width, height, bpp) {
    const rowLen = width * bpp;
    const out = new Uint8Array((rowLen + 1) * height);
    const zero = new Uint8Array(rowLen);
    const abs = (v) => { v &= 255; return v < 128 ? v : 256 - v; };
    for (let y = 0; y < height; y++) {
      const ro = y * rowLen;
      const po = (y - 1) * rowLen;
      const prev = y ? data : zero;
      const pBase = y ? po : 0;
      // Pass 1: score each filter type on this row.
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
      for (let x = 0; x < rowLen; x++) {
        const v = data[ro + x];
        const a = x >= bpp ? data[ro + x - bpp] : 0;
        const b = prev[pBase + x];
        const c = x >= bpp ? prev[pBase + x - bpp] : 0;
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        s0 += v < 128 ? v : 256 - v;
        s1 += abs(v - a);
        s2 += abs(v - b);
        s3 += abs(v - ((a + b) >> 1));
        s4 += abs(v - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c));
      }
      let best = 0, bestSum = s0;
      if (s1 < bestSum) { best = 1; bestSum = s1; }
      if (s2 < bestSum) { best = 2; bestSum = s2; }
      if (s3 < bestSum) { best = 3; bestSum = s3; }
      if (s4 < bestSum) best = 4;
      // Pass 2: write the chosen filter.
      const oo = y * (rowLen + 1);
      out[oo] = best;
      for (let x = 0; x < rowLen; x++) {
        const v = data[ro + x];
        const a = x >= bpp ? data[ro + x - bpp] : 0;
        const b = prev[pBase + x];
        let f;
        if (best === 0) f = v;
        else if (best === 1) f = v - a;
        else if (best === 2) f = v - b;
        else if (best === 3) f = v - ((a + b) >> 1);
        else {
          const c = x >= bpp ? prev[pBase + x - bpp] : 0;
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          f = v - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
        out[oo + 1 + x] = f & 255;
      }
    }
    return out;
  }

  /** True if no pixel has visible colour (thin coloured strokes count). */
  function isGrayscale(rgba) {
    for (let i = 0; i < rgba.length; i += 4) {
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      if (Math.abs(r - g) > 10 || Math.abs(r - b) > 10 || Math.abs(g - b) > 10) return false;
    }
    return true;
  }

  // ------------------------------------------------------ JPEG workers

  let pool = null;
  function encoderPool() {
    if (pool) return pool;
    const workers = [];
    const queue = [];
    const pending = new Map();
    let nextId = 1;
    let broken = typeof Worker !== 'function';
    const size = Math.max(1, Math.min(4, ((root.navigator && root.navigator.hardwareConcurrency) || 2) - 1));
    function spawn() {
      try {
        const w = new Worker(scriptBase + 'jpeg.js');
        w.busy = false;
        w.onmessage = (e) => {
          const job = pending.get(e.data.id);
          pending.delete(e.data.id);
          w.busy = false;
          if (e.data.error) job.reject(new Error(e.data.error));
          else job.resolve(e.data.jpeg);
          pump();
        };
        w.onerror = (e) => {
          // A worker that cannot start (e.g. file:// pages) means we encode inline.
          e.preventDefault && e.preventDefault();
          broken = true;
          for (const [id, job] of pending) { if (job.worker === w) { pending.delete(id); queue.unshift(job); } }
          pump();
        };
        workers.push(w);
        return w;
      } catch (e) {
        broken = true;
        return null;
      }
    }
    function pump() {
      while (queue.length) {
        if (broken) {
          const job = queue.shift();
          try { job.resolve(root.PDFMiniJPEG.encode(job.rgba, job.width, job.height, job.opts)); } catch (e) { job.reject(e); }
          continue;
        }
        let w = workers.find((x) => !x.busy);
        if (!w && workers.length < size) w = spawn();
        if (!w) { if (broken) continue; return; }
        const job = queue.shift();
        w.busy = true;
        job.worker = w;
        pending.set(job.id, job);
        w.postMessage({ id: job.id, rgba: job.rgba, width: job.width, height: job.height, opts: job.opts }, [job.rgba.buffer]);
      }
    }
    pool = {
      encode(rgba, width, height, opts) {
        return new Promise((resolve, reject) => {
          queue.push({ id: nextId++, rgba, width, height, opts, resolve, reject });
          pump();
        });
      },
    };
    return pool;
  }

  function encodeJpeg(rgba, width, height, opts) {
    // Copy into a transferable buffer that we own.
    const own = rgba.byteOffset === 0 && rgba.byteLength === rgba.buffer.byteLength ? rgba : rgba.slice();
    return encoderPool().encode(own, width, height, opts);
  }

  // ---------------------------------------------------------- PDF.js

  /** Fetch a module, let the browser check its integrity, and expose it as a blob URL. */
  async function verifiedModuleUrl([path, integrity]) {
    const res = await fetch(PDFJS_BASE + path, { integrity, mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error(`Could not load ${path} (HTTP ${res.status})`);
    return URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: 'text/javascript' }));
  }

  /** PDF.js is only needed for rasterizing and exotic images, so load it on demand. */
  let pdfjsPromise = null;
  function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = (async () => {
        const [main, worker] = await Promise.all([verifiedModuleUrl(PDFJS_MODULES.main), verifiedModuleUrl(PDFJS_MODULES.worker)]);
        const lib = await import(/* webpackIgnore: true */ main);
        lib.GlobalWorkerOptions.workerSrc = worker;
        return lib;
      })();
      pdfjsPromise.catch(() => { pdfjsPromise = null; });
    }
    return pdfjsPromise;
  }

  function pdfjsDocument(lib, data, password) {
    return lib.getDocument({
      data,
      password,
      wasmUrl: PDFJS_BASE + 'wasm/',
      iccUrl: PDFJS_BASE + 'iccs/',
      cMapUrl: PDFJS_BASE + 'cmaps/',
      standardFontDataUrl: PDFJS_BASE + 'standard_fonts/',
      enableXfa: false,
      verbosity: 0,
    });
  }

  /**
   * Render images PDF.js can decode but we can't (CMYK, JPX, Lab, exotic
   * Decode arrays...) by drawing each one alone on a page of its target size.
   * Calls onPixels(item, rgba) for each; returns the number rendered.
   */
  async function renderImagesWithPdfjs(doc, items, onPixels, signal) {
    const PDFLib = L();
    const lib = await loadPdfjs();
    const mini = await PDFLib.PDFDocument.create({ updateMetadata: false });
    const copier = PDFLib.PDFObjectCopier.for(doc.context, mini.context);
    for (const item of items) {
      const dict = PDFLib.PDFDict.withContext(doc.context);
      for (const [k, v] of item.stream.dict.entries()) {
        if (k !== N('SMask') && k !== N('Mask') && k !== N('Length')) dict.set(k, v);
      }
      const copied = copier.copy(PDFLib.PDFRawStream.of(dict, item.stream.contents));
      const ref = mini.context.register(copied);
      const page = mini.addPage([item.tw, item.th]);
      page.node.setXObject(N('Im0'), ref);
      page.pushOperators(
        PDFLib.pushGraphicsState(),
        PDFLib.concatTransformationMatrix(item.tw, 0, 0, item.th, 0, 0),
        PDFLib.drawObject('Im0'),
        PDFLib.popGraphicsState(),
      );
    }
    const bytes = await mini.save({ useObjectStreams: false, objectsPerTick: 500 });
    const task = pdfjsDocument(lib, bytes);
    const pdf = await task.promise;
    let done = 0;
    try {
      for (let i = 0; i < items.length; i++) {
        checkAbort(signal);
        const item = items[i];
        const page = await pdf.getPage(i + 1);
        const viewport = page.getViewport({ scale: 1 });
        const canvas = createCanvas(item.tw, item.th);
        try {
          await page.render({ canvas: null, canvasContext: context2d(canvas), viewport, background: 'rgb(255,255,255)' }).promise;
          const rgba = context2d(canvas).getImageData(0, 0, item.tw, item.th).data;
          await onPixels(item, rgba);
          done++;
        } catch (e) {
          if (e && e.name === 'AbortError') throw e;
        } finally {
          releaseCanvas(canvas);
          page.cleanup();
        }
      }
    } finally {
      await task.destroy();
    }
    return done;
  }

  // ------------------------------------------------ image recompression

  function collectImages(doc) {
    const ctx = doc.context;
    const PDFLib = L();
    const images = [];
    const maskRefs = new Set();
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFLib.PDFRawStream)) continue;
      const d = obj.dict;
      if (d.get(N('Subtype')) !== N('Image')) continue;
      const sm = d.get(N('SMask'));
      if (sm instanceof PDFLib.PDFRef) maskRefs.add(sm);
      const mk = d.get(N('Mask'));
      if (mk instanceof PDFLib.PDFRef) maskRefs.add(mk);
      images.push({ ref, stream: obj });
    }
    return images.filter((img) => !maskRefs.has(img.ref)).map((img) => {
      const d = img.stream.dict;
      const width = num(dictGet(ctx, d, 'Width'), 0);
      const height = num(dictGet(ctx, d, 'Height'), 0);
      const imageMask = dictGet(ctx, d, 'ImageMask');
      return Object.assign(img, {
        width,
        height,
        bpc: num(dictGet(ctx, d, 'BitsPerComponent'), 8),
        filters: filtersOf(ctx, d),
        cs: colorSpaceInfo(ctx, d.get(N('ColorSpace')), 0),
        imageMask: imageMask instanceof PDFLib.PDFBool && imageMask.asBoolean(),
        colorKeyMask: dictGet(ctx, d, 'Mask') instanceof PDFLib.PDFArray,
        bytes: img.stream.contents.length,
      });
    });
  }

  function maxPageSize(doc) {
    let m = 0;
    for (const p of doc.getPages()) {
      const { width, height } = p.getSize();
      m = Math.max(m, width, height);
    }
    return m || 842;
  }

  /** Decide target pixel size for an image, or null to keep its resolution. */
  function targetSize(img, placement, fallbackPts, dpi) {
    const wPts = placement ? placement.w : fallbackPts;
    const hPts = placement ? placement.h : fallbackPts;
    const dpiX = img.width / (wPts / 72);
    const dpiY = img.height / (hPts / 72);
    const tw = dpiX > dpi * RESAMPLE_SLACK ? Math.max(1, Math.round(img.width * dpi / dpiX)) : img.width;
    const th = dpiY > dpi * RESAMPLE_SLACK ? Math.max(1, Math.round(img.height * dpi / dpiY)) : img.height;
    return { tw, th, dpi: Math.min(dpiX, dpiY) };
  }

  /**
   * Colour space for the re-encoded image. Pixel values decoded by us (not
   * PDF.js) are still in the source colour space, so calibrated/ICC spaces can
   * be kept; PDF.js output is already converted to sRGB.
   */
  function outputColorSpace(ctx, img, gray) {
    const original = img.stream.dict.get(N('ColorSpace'));
    if (img.path !== 'pdfjs') {
      if (img.cs.kind === (gray ? 'gray' : 'rgb')) return original;
      if (img.cs.kind === 'indexed' && img.cs.base.kind === (gray ? 'gray' : 'rgb')) {
        const arr = lookup(ctx, original);
        return arr instanceof L().PDFArray ? arr.get(1) : N(gray ? 'DeviceGray' : 'DeviceRGB');
      }
    }
    return N(gray ? 'DeviceGray' : 'DeviceRGB');
  }

  /**
   * Swap in re-encoded image data: JPEG, or (when `flateColors` is set) Flate
   * with PNG predictors.
   */
  function replaceImage(doc, img, data, gray, flateColors) {
    const PDFLib = L();
    const ctx = doc.context;
    const cs = outputColorSpace(ctx, img, gray);
    const dict = img.stream.dict.clone(ctx);
    for (const key of ['DecodeParms', 'Decode', 'Length', 'SMaskInData', 'Filter', 'ColorSpace', 'BitsPerComponent', 'Width', 'Height']) dict.delete(N(key));
    dict.set(N('Width'), PDFLib.PDFNumber.of(img.tw));
    dict.set(N('Height'), PDFLib.PDFNumber.of(img.th));
    dict.set(N('BitsPerComponent'), PDFLib.PDFNumber.of(8));
    dict.set(N('ColorSpace'), cs);
    if (flateColors) {
      dict.set(N('Filter'), N('FlateDecode'));
      dict.set(N('DecodeParms'), ctx.obj({ Predictor: 15, Colors: flateColors, BitsPerComponent: 8, Columns: img.tw }));
    } else {
      dict.set(N('Filter'), N('DCTDecode'));
    }
    ctx.assign(img.ref, PDFLib.PDFRawStream.of(dict, data));
  }

  /**
   * After shrinking an image, shrink its soft mask (alpha) to match, losslessly.
   * Returns the number of bytes saved.
   */
  async function resampleSoftMask(doc, img) {
    const PDFLib = L();
    const ctx = doc.context;
    const ref = img.stream.dict.get(N('SMask'));
    const mask = ref instanceof PDFLib.PDFRef ? ctx.lookup(ref) : null;
    if (!(mask instanceof PDFLib.PDFRawStream)) return 0;
    const m = {
      stream: mask,
      width: num(dictGet(ctx, mask.dict, 'Width'), 0),
      height: num(dictGet(ctx, mask.dict, 'Height'), 0),
      bpc: num(dictGet(ctx, mask.dict, 'BitsPerComponent'), 8),
      cs: { kind: 'gray', n: 1 },
    };
    if (m.width !== img.width || m.height !== img.height || m.bpc !== 8) return 0;
    if (dictGet(ctx, mask.dict, 'Matte') || !isDefaultDecode(ctx, mask.dict, 1, 8)) return 0;
    const full = decodeRawImage(ctx, m);
    if (!full) return 0;
    const c = rgbaToCanvasSource(full, m.width, m.height);
    const rgba = resampleToPixels(c, img.tw, img.th);
    releaseCanvas(c);
    const flate = await deflate(pngPredict(channels(rgba, true), img.tw, img.th, 1));
    if (flate.length >= mask.contents.length) return 0;
    const dict = mask.dict.clone(ctx);
    for (const key of ['DecodeParms', 'Length', 'Filter', 'Width', 'Height']) dict.delete(N(key));
    dict.set(N('Width'), PDFLib.PDFNumber.of(img.tw));
    dict.set(N('Height'), PDFLib.PDFNumber.of(img.th));
    dict.set(N('Filter'), N('FlateDecode'));
    dict.set(N('DecodeParms'), ctx.obj({ Predictor: 15, Colors: 1, BitsPerComponent: 8, Columns: img.tw }));
    const saved = mask.contents.length - flate.length;
    ctx.assign(ref, PDFLib.PDFRawStream.of(dict, flate));
    return saved;
  }

  /** Decide how (and whether) to re-encode one image. Sets img.path or returns false. */
  function planImage(ctx, img, placement, fallbackPts, opts) {
    if (skipReason(ctx, img)) return false;
    const { tw, th } = targetSize(img, placement, fallbackPts, opts.dpi);
    const resample = tw !== img.width || th !== img.height;
    const last = img.filters[img.filters.length - 1];
    const lossless = img.filters.every((f) => SUPPORTED_DECODE.has(f));
    let path;
    if (last === 'DCTDecode' && img.filters.length <= 2) {
      const jpegBytes = img.filters.length === 1 ? img.stream.contents : tryDecodeFirst(ctx, img.stream);
      const info = jpegBytes ? jpegInfo(jpegBytes) : null;
      // Re-encoding a JPEG at its own resolution only pays off if it was saved at higher quality.
      if (!resample && !opts.gray && info && info.quality && info.quality <= opts.quality + 6) return false;
      const parms = decodeParmsOf(ctx, img.stream.dict, img.filters.length - 1);
      const native = info && info.components === img.cs.n && (img.cs.kind === 'gray' || img.cs.kind === 'rgb') &&
        isDefaultDecode(ctx, img.stream.dict, img.cs.n, 8) && !(parms && parms.has(N('ColorTransform')));
      path = native ? 'jpeg' : 'pdfjs';
      if (native) img.jpegBytes = jpegBytes;
    } else if (lossless) {
      const simple = (img.cs.kind === 'gray' || img.cs.kind === 'rgb' || img.cs.kind === 'indexed') && isDefaultDecode(ctx, img.stream.dict, img.cs.n, img.bpc);
      path = simple ? 'raw' : 'pdfjs';
    } else if (last === 'JPXDecode' && img.filters.length === 1) {
      path = 'pdfjs';
    } else {
      return false;
    }
    if (path !== 'pdfjs' && img.width * img.height > MAX_SOURCE_PIXELS) return false;
    if (img.bytes < tw * th * MIN_JPEG_BYTES_PER_PIXEL) return false;
    Object.assign(img, { tw, th, path, lossless });
    return true;
  }

  async function recompressImages(doc, opts, report) {
    const ctx = doc.context;
    const scan = scanImagePlacements(doc);
    // A partial scan could miss a larger use of an image; then trust none of it.
    const placements = scan.complete ? scan.placements : new Map();
    const fallbackPts = maxPageSize(doc);
    const images = collectImages(doc);
    const stats = { images: images.length, recompressed: 0, kept: 0, imageBytesBefore: 0, imageBytesAfter: 0 };
    const direct = [];
    const viaPdfjs = [];
    for (const img of images) {
      if (!planImage(ctx, img, placements.get(img.ref), fallbackPts, opts)) { stats.kept++; continue; }
      (img.path === 'pdfjs' ? viaPdfjs : direct).push(img);
    }

    const total = direct.length + viaPdfjs.length;
    let done = 0;
    const inflight = new Set();
    const finish = async (img, rgba) => {
      const gray = opts.gray || isGrayscale(rgba);
      const resampled = img.tw !== img.width || img.th !== img.height;
      // Lossless sources (charts, screenshots, PNGs) also get a lossless candidate.
      const flatePixels = img.lossless && (resampled || img.cs.kind !== 'indexed') ? channels(rgba, gray) : null;
      const job = Promise.all([
        encodeJpeg(rgba, img.tw, img.th, { quality: opts.quality, gray }),
        flatePixels ? deflate(pngPredict(flatePixels, img.tw, img.th, gray ? 1 : 3)) : null,
      ]).then(async ([jpeg, flate]) => {
        stats.imageBytesBefore += img.bytes;
        // JPEG only wins over lossless if it is much smaller (it adds artifacts).
        const useJpeg = !flate || jpeg.length < flate.length * opts.losslessRatio;
        const best = useJpeg ? jpeg : flate;
        const limit = img.bytes * (img.lossless && useJpeg ? opts.losslessRatio : 0.92);
        if (img.group) img.group.tried++;
        if (best.length >= limit) {
          stats.kept++;
          stats.imageBytesAfter += img.bytes;
          return;
        }
        if (img.group) img.group.won++;
        replaceImage(doc, img, best, gray, useJpeg ? null : (gray ? 1 : 3));
        stats.recompressed++;
        stats.imageBytesAfter += best.length;
        if (resampled) stats.imageBytesAfter -= await resampleSoftMask(doc, img);
      }).catch(() => { stats.kept++; });
      const tracked = job.then(() => inflight.delete(tracked));
      inflight.add(tracked);
      // Bound memory: only a few decoded images wait for the encoder at once.
      while (inflight.size >= 4) await Promise.race(inflight);
      done++;
      report(done / total, `Compressing images ${done}/${total}`);
    };

    for (const img of direct) {
      checkAbort(opts.signal);
      let rgba = null;
      try {
        if (img.path === 'jpeg') {
          const src = await decodeJpegToSource(img.jpegBytes);
          const { w, h } = sourceSize(src);
          if (w !== img.width || h !== img.height) throw new Error('JPEG size mismatch');
          rgba = resampleToPixels(src, img.tw, img.th);
          if (src.close) src.close();
        } else {
          const full = decodeRawImage(ctx, img);
          if (!full) throw new Error('unsupported raw image');
          if (img.tw === img.width && img.th === img.height) rgba = full;
          else {
            const c = rgbaToCanvasSource(full, img.width, img.height);
            rgba = resampleToPixels(c, img.tw, img.th);
            releaseCanvas(c);
          }
        }
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        img.path = 'pdfjs'; // let PDF.js try its decoders
        viaPdfjs.push(img);
        continue;
      } finally {
        img.jpegBytes = null;
      }
      await finish(img, rgba);
    }

    // PDF.js decoding (JPEG 2000 especially) is slow, and scanned books often
    // hold hundreds of near-identical images. Probe two of each kind first and
    // skip the rest of a kind that does not get smaller.
    const groups = new Map();
    for (const img of viaPdfjs) {
      const bpp = Math.round(Math.log2(img.bytes / (img.width * img.height)) * 2);
      const key = `${img.filters.join('+')}|${img.cs.kind}|${img.width}x${img.height}|${bpp}|${img.tw}x${img.th}`;
      if (!groups.has(key)) groups.set(key, { tried: 0, won: 0, items: [] });
      img.group = groups.get(key);
      img.group.items.push(img);
    }
    const probes = [], rest = [];
    for (const g of groups.values()) { probes.push(...g.items.slice(0, 2)); rest.push(...g.items.slice(2)); }
    // Keep going with a kind only while at least a quarter of its images shrink.
    const promising = (g) => g.won > 0 && (g.tried < 4 || g.won / g.tried >= 0.25);
    const runPdfjs = async (items) => {
      let i = 0;
      while (i < items.length) {
        checkAbort(opts.signal);
        const batch = [];
        while (i < items.length && batch.length < 8) {
          const img = items[i++];
          if (img.group.tried < 2 || promising(img.group)) batch.push(img); else stats.kept++;
        }
        if (!batch.length) continue;
        await renderImagesWithPdfjs(doc, batch, finish, opts.signal);
        await Promise.all(inflight); // results feed the next batch's decision
      }
    };
    try {
      await runPdfjs(probes);
      await runPdfjs(rest);
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      stats.rendererError = String((e && e.message) || e);
    }
    await Promise.all(inflight);
    return stats;
  }

  function skipReason(ctx, img) {
    if (!(img.width > 0 && img.height > 0)) return 'invalid';
    if (img.imageMask) return 'stencil mask';
    if (img.colorKeyMask) return 'color-key mask';
    if (img.bpc === 1 && img.cs.kind !== 'indexed') return 'bilevel';
    if (num(dictGet(ctx, img.stream.dict, 'SMaskInData'), 0) > 0) return 'embedded alpha';
    if (img.bytes < MIN_IMAGE_BYTES || img.width * img.height < 64 * 64) return 'small';
    return null;
  }

  /** Remove the first (ASCII) filter layer, used to get at wrapped JPEG data. */
  function tryDecodeFirst(ctx, stream) {
    const PDFLib = L();
    const filters = filtersOf(ctx, stream.dict);
    if (!SUPPORTED_DECODE.has(filters[0])) return null;
    const dict = PDFLib.PDFDict.withContext(ctx);
    dict.set(N('Filter'), N(filters[0]));
    try {
      return decodeStream(PDFLib.PDFRawStream.of(dict, stream.contents));
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------- lossless cleanups

  /** Drop data that viewers never display (private app data, thumbnails). */
  function stripPrivateData(doc) {
    const ctx = doc.context;
    const PDFLib = L();
    let removed = 0;
    for (const [, obj] of ctx.enumerateIndirectObjects()) {
      const dict = obj instanceof PDFLib.PDFDict ? obj : obj instanceof PDFLib.PDFRawStream ? obj.dict : null;
      if (!dict) continue;
      if (dict.has(N('PieceInfo'))) { dict.delete(N('PieceInfo')); removed++; }
      if (dict.get(N('Type')) === N('Page') && dict.has(N('Thumb'))) { dict.delete(N('Thumb')); removed++; }
    }
    return removed;
  }

  function stripMetadata(doc) {
    const ctx = doc.context;
    doc.catalog.delete(N('Metadata'));
    const info = lookup(ctx, ctx.trailerInfo.Info);
    if (info instanceof L().PDFDict) {
      for (const k of info.keys()) info.delete(k);
    }
  }

  /** Visit every object reachable from the trailer. */
  function reachable(doc) {
    const ctx = doc.context;
    const PDFLib = L();
    const seen = new Set();
    const stack = [ctx.trailerInfo.Root, ctx.trailerInfo.Info, ctx.trailerInfo.Encrypt];
    while (stack.length) {
      const obj = stack.pop();
      if (!obj) continue;
      if (obj instanceof PDFLib.PDFRef) {
        if (seen.has(obj)) continue;
        seen.add(obj);
        stack.push(ctx.lookup(obj));
      } else if (obj instanceof PDFLib.PDFDict) {
        for (const v of obj.values()) stack.push(v);
      } else if (obj instanceof PDFLib.PDFArray) {
        for (const v of obj.asArray()) stack.push(v);
      } else if (obj instanceof PDFLib.PDFStream) {
        for (const v of obj.dict.values()) stack.push(v);
      }
    }
    return seen;
  }

  function removeUnreachable(doc) {
    const ctx = doc.context;
    const keep = reachable(doc);
    let removed = 0;
    for (const [ref] of ctx.enumerateIndirectObjects()) {
      if (!keep.has(ref)) { ctx.delete(ref); removed++; }
    }
    return removed;
  }

  function hashBytes(bytes) {
    let h = 0x811c9dc5;
    const step = bytes.length > 65536 ? Math.floor(bytes.length / 16384) : 1;
    for (let i = 0; i < bytes.length; i += step) { h ^= bytes[i]; h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16) + ':' + bytes.length;
  }

  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /** Merge byte-identical streams (common after combining PDFs). */
  function dedupeStreams(doc) {
    const ctx = doc.context;
    const PDFLib = L();
    const buckets = new Map();
    const replace = new Map();
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFLib.PDFRawStream) || obj.contents.length < 256) continue;
      const type = obj.dict.get(N('Type'));
      if (type === N('XRef') || type === N('ObjStm') || type === N('Metadata')) continue;
      const dictKey = obj.dict.entries().filter(([k]) => k !== N('Length')).map(([k, v]) => `${k}${v}`).join('');
      const key = hashBytes(obj.contents) + '|' + dictKey;
      const list = buckets.get(key);
      if (!list) { buckets.set(key, [[ref, obj]]); continue; }
      const match = list.find(([, o]) => sameBytes(o.contents, obj.contents));
      if (match) replace.set(ref, match[0]);
      else list.push([ref, obj]);
    }
    if (!replace.size) return 0;
    const swap = (v) => (v instanceof PDFLib.PDFRef && replace.has(v) ? replace.get(v) : v);
    const fix = (obj) => {
      if (obj instanceof PDFLib.PDFDict) { for (const [k, v] of obj.entries()) { const n = swap(v); if (n !== v) obj.set(k, n); else fix(v); } } else if (obj instanceof PDFLib.PDFArray) { for (let i = 0; i < obj.size(); i++) { const v = obj.get(i); const n = swap(v); if (n !== v) obj.set(i, n); else fix(v); } } else if (obj instanceof PDFLib.PDFStream) fix(obj.dict);
    };
    for (const [, obj] of ctx.enumerateIndirectObjects()) fix(obj);
    for (const k of ['Root', 'Info']) ctx.trailerInfo[k] = swap(ctx.trailerInfo[k]);
    return replace.size;
  }

  /**
   * Losslessly shrink streams stored inefficiently: uncompressed, ASCII85/Hex
   * wrapped (+25-100%), or LZW/RunLength (weaker than Flate).
   */
  async function compressPlainStreams(doc) {
    const ctx = doc.context;
    const PDFLib = L();
    let saved = 0;
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFLib.PDFRawStream) || obj.contents.length < 64) continue;
      const d = obj.dict;
      const type = d.get(N('Type'));
      if (type === N('Metadata') || type === N('XRef') || type === N('ObjStm') || d.has(N('F'))) continue;
      const filters = filtersOf(ctx, d);
      const parms = dictGet(ctx, d, 'DecodeParms');
      const parmList = parms instanceof PDFLib.PDFArray ? parms.asArray() : [parms];
      let contents, newFilters, newParms;
      if (filters.length === 0) {
        contents = await deflate(obj.contents);
        newFilters = ['FlateDecode'];
        newParms = [];
      } else if (filters[0] === 'ASCII85Decode' || filters[0] === 'ASCIIHexDecode') {
        // Drop the text encoding layer; keep any filters underneath.
        const inner = tryDecodeFirst(ctx, obj);
        if (!inner) continue;
        if (filters.length === 1) {
          contents = await deflate(inner);
          newFilters = ['FlateDecode'];
          newParms = [];
        } else {
          contents = inner;
          newFilters = filters.slice(1);
          newParms = parms instanceof PDFLib.PDFArray ? parmList.slice(1) : [parms];
        }
      } else if (filters.length === 1 && (filters[0] === 'LZWDecode' || filters[0] === 'RunLengthDecode')) {
        // Same predictor semantics apply after Flate as after LZW.
        const inner = tryDecodeFirst(ctx, obj);
        if (!inner) continue;
        contents = await deflate(inner);
        newFilters = ['FlateDecode'];
        let p = lookup(ctx, parmList[0]);
        if (p instanceof PDFLib.PDFDict && p.has(N('EarlyChange'))) { p = p.clone(ctx); p.delete(N('EarlyChange')); }
        newParms = p instanceof PDFLib.PDFDict ? [p] : [];
      } else {
        continue;
      }
      if (!contents || contents.length >= obj.contents.length) continue;
      const dict = d.clone(ctx);
      for (const k of ['Filter', 'DecodeParms', 'Length']) dict.delete(N(k));
      dict.set(N('Filter'), newFilters.length === 1 ? N(newFilters[0]) : ctx.obj(newFilters.map((f) => N(f))));
      const realParms = newParms.filter((p) => p && p !== PDFLib.PDFNull);
      if (realParms.length) {
        dict.set(N('DecodeParms'), newFilters.length === 1 ? newParms[0] : ctx.obj(newParms.map((p) => p || PDFLib.PDFNull)));
      }
      saved += obj.contents.length - contents.length;
      ctx.assign(ref, PDFLib.PDFRawStream.of(dict, contents));
    }
    return saved;
  }

  // ------------------------------------------------------------ loading

  async function loadPdfLib(bytes) {
    const PDFLib = L();
    if (!PDFLib) throw new PDFMiniError('lib', 'PDF library failed to load. Check your connection and reload.');
    try {
      return await PDFLib.PDFDocument.load(bytes, { updateMetadata: false, parseSpeed: 1500, throwOnInvalidObject: false });
    } catch (e) {
      if (e instanceof PDFLib.EncryptedPDFError || /encrypt/i.test(e && e.message)) {
        throw new PDFMiniError('encrypted', 'This PDF is password-protected or encrypted.');
      }
      throw new PDFMiniError('invalid', 'This file could not be read as a PDF. It may be damaged.');
    }
  }

  /**
   * Write with object streams. pdf-lib's save() packs 50 objects per stream;
   * 400 compresses noticeably better on documents with many small objects.
   */
  async function serialize(doc, opts) {
    await doc.flush();
    const PDFLib = L();
    // PDF/A-1 is based on PDF 1.4, which has no object streams.
    if (opts && opts.noObjectStreams) return PDFLib.PDFWriter.forContext(doc.context, 2000).serializeToBuffer();
    return PDFLib.PDFStreamWriter.forContext(doc.context, 2000, true, 400).serializeToBuffer();
  }

  /** PDF/A part declared in the document's XMP metadata, or 0. */
  function pdfaPart(doc) {
    const meta = lookup(doc.context, doc.catalog.get(N('Metadata')));
    if (!(meta instanceof L().PDFRawStream)) return 0;
    const xml = tryDecode(doc.context, meta);
    if (!xml) return 0;
    const m = /pdfaid:part(?:>|\s*=\s*["'])\s*(\d)/.exec(ascii(xml, 0, Math.min(xml.length, 65536)));
    return m ? Number(m[1]) : 0;
  }

  /** True if the document carries a digital signature (rewriting invalidates it). */
  function isSigned(doc) {
    const ctx = doc.context;
    const form = lookup(ctx, doc.catalog.get(N('AcroForm')));
    if (!(form instanceof L().PDFDict)) return false;
    if (num(dictGet(ctx, form, 'SigFlags'), 0) & 1) return true;
    const fields = dictGet(ctx, form, 'Fields');
    if (!(fields instanceof L().PDFArray)) return false;
    return fields.asArray().some((f) => {
      const field = lookup(ctx, f);
      return field instanceof L().PDFDict && dictGet(ctx, field, 'FT') === N('Sig') && !!field.get(N('V'));
    });
  }

  function bumpVersion(doc) {
    if (pdfaPart(doc) === 1) return;
    const h = doc.context.header;
    const major = Number(h.major), minor = Number(h.minor);
    if (major === 1 && minor < 5) doc.context.header = L().PDFHeader.forVersion(1, 7);
  }

  function resolveSettings(opts) {
    const level = LEVELS[opts.level] || LEVELS.balanced;
    return {
      dpi: opts.dpi || level.dpi,
      quality: opts.quality || level.quality,
      gray: !!opts.grayscale,
      stripMetadata: !!opts.stripMetadata,
      losslessRatio: opts.level === 'strong' ? 0.8 : opts.level === 'light' ? 0.5 : 0.65,
      signal: opts.signal,
    };
  }

  // ------------------------------------------------------- compression

  /**
   * Compress a PDF.
   * @param {ArrayBuffer|Uint8Array} input
   * @param {object} [options] level ('light'|'balanced'|'strong'), mode
   *   ('images'|'rasterize'), dpi, quality (1-100), grayscale, stripMetadata,
   *   signal (AbortSignal), onProgress(fraction, message)
   * @returns {Promise<{bytes: Uint8Array, improved: boolean, mode: string, stats: object}>}
   */
  async function compress(input, options) {
    const opts = Object.assign({ level: 'balanced', mode: 'images' }, options || {});
    const bytes = toUint8(input);
    if (!isPdf(bytes)) throw new PDFMiniError('not-pdf', 'This file is not a PDF.');
    const settings = resolveSettings(opts);
    const progress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    const started = Date.now();
    let result;
    if (opts.mode === 'rasterize') {
      result = await rasterize(bytes, settings, progress, opts.password);
    } else {
      result = await optimize(bytes, settings, progress);
    }
    checkAbort(settings.signal);
    const improved = result.bytes.length < bytes.length * (1 - MIN_SAVING);
    progress(1, 'Done');
    return {
      bytes: improved ? result.bytes : bytes,
      improved,
      mode: opts.mode,
      stats: Object.assign(result.stats || {}, { inputSize: bytes.length, outputSize: improved ? result.bytes.length : bytes.length, ms: Date.now() - started, settings: { dpi: settings.dpi, quality: settings.quality, gray: settings.gray } }),
    };
  }

  async function optimize(bytes, settings, progress) {
    progress(0.02, 'Reading PDF');
    const doc = await loadPdfLib(bytes);
    checkAbort(settings.signal);
    progress(0.1, 'Analyzing images');
    await nextFrame();
    let imageStats;
    try {
      imageStats = await recompressImages(doc, settings, (f, msg) => progress(0.1 + f * 0.75, msg));
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      // Replacements are atomic, so the document is still valid: keep going losslessly.
      imageStats = { imageError: String((e && e.message) || e) };
    }
    checkAbort(settings.signal);
    progress(0.86, 'Optimizing structure');
    await nextFrame();
    const pdfa = pdfaPart(doc);
    const signed = isSigned(doc);
    const privateRemoved = stripPrivateData(doc);
    if (settings.stripMetadata) stripMetadata(doc);
    const duplicates = dedupeStreams(doc);
    const unreachable = removeUnreachable(doc);
    const plainSaved = await compressPlainStreams(doc);
    bumpVersion(doc);
    checkAbort(settings.signal);
    progress(0.92, 'Saving');
    await nextFrame();
    const out = await serialize(doc, { noObjectStreams: pdfa === 1 });
    return { bytes: out, stats: Object.assign(imageStats, { pages: doc.getPageCount(), privateRemoved, duplicates, unreachable, plainSaved, pdfa, signed }) };
  }

  async function rasterize(bytes, settings, progress, password) {
    const PDFLib = L();
    progress(0.02, 'Loading renderer');
    let lib;
    try {
      lib = await loadPdfjs();
    } catch (e) {
      throw new PDFMiniError('renderer', 'The page renderer could not be loaded. Check your connection, or use the default mode.');
    }
    checkAbort(settings.signal);
    const task = pdfjsDocument(lib, bytes.slice(), password);
    let pdf;
    try {
      pdf = await task.promise;
    } catch (e) {
      task.destroy();
      if (e && e.name === 'PasswordException') throw new PDFMiniError('encrypted', 'This PDF is password-protected.');
      throw new PDFMiniError('invalid', 'This file could not be read as a PDF. It may be damaged.');
    }
    const out = await PDFLib.PDFDocument.create({ updateMetadata: false });
    const pending = [];
    const addPage = async ({ jpeg, width, height }) => {
      const img = await out.embedJpg(await jpeg);
      out.addPage([width, height]).drawImage(img, { x: 0, y: 0, width, height });
    };
    try {
      const n = pdf.numPages;
      for (let i = 1; i <= n; i++) {
        checkAbort(settings.signal);
        progress(0.05 + 0.9 * ((i - 1) / n), `Rendering page ${i}/${n}`);
        const page = await pdf.getPage(i);
        const base = page.getViewport({ scale: 1 });
        let scale = settings.dpi / 72;
        if (base.width * base.height * scale * scale > MAX_CANVAS_PIXELS) scale = Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height));
        const viewport = page.getViewport({ scale });
        const w = Math.max(1, Math.round(viewport.width)), h = Math.max(1, Math.round(viewport.height));
        const canvas = createCanvas(w, h);
        let rgba;
        try {
          await page.render({ canvas: null, canvasContext: context2d(canvas), viewport, background: 'rgb(255,255,255)', annotationMode: lib.AnnotationMode.ENABLE }).promise;
          rgba = context2d(canvas).getImageData(0, 0, w, h).data;
        } finally {
          releaseCanvas(canvas);
          page.cleanup();
        }
        const gray = settings.gray || isGrayscale(rgba);
        // Encode in the background while the next page renders; add pages in order.
        pending.push({ jpeg: encodeJpeg(rgba, w, h, { quality: settings.quality, gray }), width: base.width, height: base.height });
        if (pending.length > 2) await addPage(pending.shift());
      }
      while (pending.length) await addPage(pending.shift());
      try {
        const meta = await pdf.getMetadata();
        const info = (meta && meta.info) || {};
        if (info.Title) out.setTitle(String(info.Title));
        if (info.Author) out.setAuthor(String(info.Author));
      } catch (e) { /* metadata is optional */ }
    } finally {
      await task.destroy();
    }
    progress(0.96, 'Saving');
    const saved = await serialize(out);
    return { bytes: saved, stats: { pages: out.getPageCount() } };
  }

  // ------------------------------------------------------------ combine

  /**
   * Merge PDFs in order.
   * @param {Array<{bytes: ArrayBuffer|Uint8Array, name?: string}>} files
   * @returns {Promise<{bytes: Uint8Array, pages: number}>}
   */
  async function combine(files, options) {
    const opts = options || {};
    const progress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    const PDFLib = L();
    if (!PDFLib) throw new PDFMiniError('lib', 'PDF library failed to load. Check your connection and reload.');
    const out = await PDFLib.PDFDocument.create({ updateMetadata: false });
    for (let i = 0; i < files.length; i++) {
      checkAbort(opts.signal);
      const f = files[i];
      progress(i / files.length, `Adding ${f.name || `file ${i + 1}`}`);
      const bytes = toUint8(f.bytes);
      if (!isPdf(bytes)) throw new PDFMiniError('not-pdf', `${f.name || 'A file'} is not a PDF.`);
      let src;
      try {
        src = await loadPdfLib(bytes);
      } catch (e) {
        if (e instanceof PDFMiniError) e.message = `${f.name || 'A file'}: ${e.message}`;
        throw e;
      }
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
      await nextFrame();
    }
    progress(0.95, 'Saving');
    const saved = await serialize(out);
    progress(1, 'Done');
    return { bytes: saved, pages: out.getPageCount() };
  }

  /** Quick page count for file lists (null if unreadable). */
  async function pageCount(input) {
    const bytes = toUint8(input);
    if (!isPdf(bytes)) throw new PDFMiniError('not-pdf', 'This file is not a PDF.');
    const doc = await loadPdfLib(bytes);
    return doc.getPageCount();
  }

  root.PDFMini = {
    LEVELS,
    PDFJS_VERSION,
    PDFMiniError,
    compress,
    combine,
    pageCount,
    isPdf,
    loadPdfjs,
    _internal: { scanImagePlacements, collectImages, targetSize, stripJpegMetadata, jpegInfo, unpredict, tokenize, estimateQuality },
  };
})(typeof window !== 'undefined' ? window : globalThis);
