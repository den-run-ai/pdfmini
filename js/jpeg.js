/*
 * pdfmini JPEG encoder — baseline JPEG with optimized Huffman tables.
 *
 * Browsers ship different canvas JPEG encoders (Safari: Apple ImageIO,
 * Chrome/Firefox: libjpeg-turbo), so the same quality setting produces
 * different sizes and artifacts on different devices. Encoding in JS makes
 * the output identical everywhere, and also lets us write true 1-channel
 * grayscale JPEGs.
 *
 * Works as a classic <script> (defines self.PDFMiniJPEG), as a Web Worker
 * (answers {id, rgba, width, height, opts} messages), and as a CommonJS module.
 */
(function (root) {
  'use strict';

  // Natural (row-major) index -> zigzag position.
  const ZIGZAG = new Uint8Array([
    0, 1, 5, 6, 14, 15, 27, 28,
    2, 4, 7, 13, 16, 26, 29, 42,
    3, 8, 12, 17, 25, 30, 41, 43,
    9, 11, 18, 24, 31, 40, 44, 53,
    10, 19, 23, 32, 39, 45, 52, 54,
    20, 22, 33, 38, 46, 51, 55, 60,
    21, 34, 37, 47, 50, 56, 59, 61,
    35, 36, 48, 49, 57, 58, 62, 63,
  ]);

  // ITU T.81 Annex K example tables (natural order).
  const STD_LUMA = [
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
  ];
  const STD_CHROMA = [
    17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99,
    24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  ];
  const AAN = [1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.5411961, 0.275899379];

  /** IJG quality scaling (same formula libjpeg uses). */
  function quantTable(base, quality) {
    const q = Math.max(1, Math.min(100, Math.round(quality)));
    const scale = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
    const out = new Uint8Array(64);
    for (let i = 0; i < 64; i++) out[i] = Math.max(1, Math.min(255, Math.floor((base[i] * scale + 50) / 100)));
    return out;
  }

  /** Multipliers that fold AAN scaling and quantization into one step. */
  function divisors(qt) {
    const d = new Float32Array(64);
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) d[r * 8 + c] = 1 / (qt[r * 8 + c] * AAN[r] * AAN[c] * 8);
    }
    return d;
  }

  /** In-place AAN forward DCT on an 8x8 block (float). */
  function fdct(d) {
    for (let i = 0; i < 64; i += 8) {
      const t0 = d[i] + d[i + 7], t7 = d[i] - d[i + 7];
      const t1 = d[i + 1] + d[i + 6], t6 = d[i + 1] - d[i + 6];
      const t2 = d[i + 2] + d[i + 5], t5 = d[i + 2] - d[i + 5];
      const t3 = d[i + 3] + d[i + 4], t4 = d[i + 3] - d[i + 4];
      let t10 = t0 + t3, t13 = t0 - t3, t11 = t1 + t2, t12 = t1 - t2;
      d[i] = t10 + t11;
      d[i + 4] = t10 - t11;
      const z1 = (t12 + t13) * 0.707106781;
      d[i + 2] = t13 + z1;
      d[i + 6] = t13 - z1;
      t10 = t4 + t5; t11 = t5 + t6; t12 = t6 + t7;
      const z5 = (t10 - t12) * 0.382683433;
      const z2 = 0.5411961 * t10 + z5;
      const z4 = 1.306562965 * t12 + z5;
      const z3 = t11 * 0.707106781;
      const z11 = t7 + z3, z13 = t7 - z3;
      d[i + 5] = z13 + z2;
      d[i + 3] = z13 - z2;
      d[i + 1] = z11 + z4;
      d[i + 7] = z11 - z4;
    }
    for (let i = 0; i < 8; i++) {
      const t0 = d[i] + d[i + 56], t7 = d[i] - d[i + 56];
      const t1 = d[i + 8] + d[i + 48], t6 = d[i + 8] - d[i + 48];
      const t2 = d[i + 16] + d[i + 40], t5 = d[i + 16] - d[i + 40];
      const t3 = d[i + 24] + d[i + 32], t4 = d[i + 24] - d[i + 32];
      let t10 = t0 + t3, t13 = t0 - t3, t11 = t1 + t2, t12 = t1 - t2;
      d[i] = t10 + t11;
      d[i + 32] = t10 - t11;
      const z1 = (t12 + t13) * 0.707106781;
      d[i + 16] = t13 + z1;
      d[i + 48] = t13 - z1;
      t10 = t4 + t5; t11 = t5 + t6; t12 = t6 + t7;
      const z5 = (t10 - t12) * 0.382683433;
      const z2 = 0.5411961 * t10 + z5;
      const z4 = 1.306562965 * t12 + z5;
      const z3 = t11 * 0.707106781;
      const z11 = t7 + z3, z13 = t7 - z3;
      d[i + 40] = z13 + z2;
      d[i + 24] = z13 - z2;
      d[i + 8] = z11 + z4;
      d[i + 56] = z11 - z4;
    }
  }

  /**
   * Convert RGBA to level-shifted planes padded to whole MCUs (edge pixels
   * replicated). Chroma planes are averaged down by `sub` in each direction.
   */
  function makePlanes(rgba, width, height, gray, sub) {
    const mcu = 8 * sub;
    const pw = Math.ceil(width / mcu) * mcu;
    const ph = Math.ceil(height / mcu) * mcu;
    const Y = new Float32Array(pw * ph);
    for (let y = 0; y < ph; y++) {
      const sy = y < height ? y : height - 1;
      let src = sy * width * 4;
      let dst = y * pw;
      for (let x = 0; x < width; x++, src += 4) {
        Y[dst++] = 0.299 * rgba[src] + 0.587 * rgba[src + 1] + 0.114 * rgba[src + 2] - 128;
      }
      const edge = Y[dst - 1];
      for (let x = width; x < pw; x++) Y[dst++] = edge;
    }
    if (gray) return { Y, pw, ph };

    const cw = pw / sub, ch = ph / sub;
    const Cb = new Float32Array(cw * ch);
    const Cr = new Float32Array(cw * ch);
    // Byte offsets of the first/last source column of each chroma sample.
    const x0 = new Int32Array(cw), x1 = new Int32Array(cw);
    for (let cx = 0; cx < cw; cx++) {
      x0[cx] = Math.min(cx * sub, width - 1) * 4;
      x1[cx] = Math.min(cx * sub + sub - 1, width - 1) * 4;
    }
    const rowBytes = width * 4;
    for (let cy = 0; cy < ch; cy++) {
      const r0 = Math.min(cy * sub, height - 1) * rowBytes;
      const r1 = Math.min(cy * sub + sub - 1, height - 1) * rowBytes;
      let o = cy * cw;
      for (let cx = 0; cx < cw; cx++, o++) {
        let r, g, b;
        if (sub === 1) {
          const p = r0 + x0[cx];
          r = rgba[p]; g = rgba[p + 1]; b = rgba[p + 2];
        } else {
          const a = r0 + x0[cx], c = r0 + x1[cx], e = r1 + x0[cx], f = r1 + x1[cx];
          r = (rgba[a] + rgba[c] + rgba[e] + rgba[f]) * 0.25;
          g = (rgba[a + 1] + rgba[c + 1] + rgba[e + 1] + rgba[f + 1]) * 0.25;
          b = (rgba[a + 2] + rgba[c + 2] + rgba[e + 2] + rgba[f + 2]) * 0.25;
        }
        Cb[o] = -0.168735892 * r - 0.331264108 * g + 0.5 * b;
        Cr[o] = 0.5 * r - 0.418687589 * g - 0.081312411 * b;
      }
    }
    return { Y, Cb, Cr, pw, ph, cw, ch };
  }

  /** DCT + quantize one 8x8 block from a plane into `out` (zigzag order). */
  function encodeBlock(plane, stride, x0, y0, div, tmp, out, outOff) {
    for (let r = 0, k = 0; r < 8; r++) {
      const row = (y0 + r) * stride + x0;
      for (let c = 0; c < 8; c++) tmp[k++] = plane[row + c];
    }
    fdct(tmp);
    for (let i = 0; i < 64; i++) {
      const v = tmp[i] * div[i];
      out[outOff + ZIGZAG[i]] = v > 0 ? (v + 0.5) | 0 : (v - 0.5) | 0;
    }
  }

  function bitLength(v) {
    return v === 0 ? 0 : 32 - Math.clz32(v < 0 ? -v : v);
  }

  /** Optimal Huffman table from symbol frequencies (ITU T.81 Annex K.2). */
  function optimalTable(freqIn) {
    const freq = new Float64Array(257);
    for (let i = 0; i < 256; i++) freq[i] = freqIn[i];
    freq[256] = 1; // reserved so no code is all 1-bits
    const codesize = new Int32Array(257);
    const others = new Int32Array(257).fill(-1);
    for (;;) {
      let c1 = -1, c2 = -1, v = Infinity;
      for (let i = 0; i <= 256; i++) if (freq[i] && freq[i] <= v) { v = freq[i]; c1 = i; }
      v = Infinity;
      for (let i = 0; i <= 256; i++) if (freq[i] && freq[i] <= v && i !== c1) { v = freq[i]; c2 = i; }
      if (c2 < 0) break;
      freq[c1] += freq[c2];
      freq[c2] = 0;
      codesize[c1]++;
      while (others[c1] >= 0) { c1 = others[c1]; codesize[c1]++; }
      others[c1] = c2;
      codesize[c2]++;
      while (others[c2] >= 0) { c2 = others[c2]; codesize[c2]++; }
    }
    const bits = new Int32Array(33);
    for (let i = 0; i <= 256; i++) if (codesize[i]) bits[codesize[i]]++;
    for (let i = 32; i > 16; i--) {
      while (bits[i] > 0) {
        let j = i - 2;
        while (bits[j] === 0) j--;
        bits[i] -= 2;
        bits[i - 1]++;
        bits[j + 1] += 2;
        bits[j]--;
      }
    }
    let i = 16;
    while (bits[i] === 0) i--;
    bits[i]--; // drop the reserved symbol

    const values = [];
    for (let len = 1; len <= 32; len++) {
      for (let s = 0; s < 256; s++) if (codesize[s] === len) values.push(s);
    }
    const counts = bits.slice(1, 17);
    // Canonical codes.
    const codes = new Int32Array(256), sizes = new Int32Array(256);
    let code = 0, k = 0;
    for (let len = 1; len <= 16; len++) {
      for (let n = 0; n < counts[len - 1]; n++) {
        const s = values[k++];
        codes[s] = code++;
        sizes[s] = len;
      }
      code <<= 1;
    }
    return { counts, values: values.slice(0, k), codes, sizes };
  }

  function ByteWriter(initial) {
    let buf = new Uint8Array(Math.max(1024, initial | 0));
    let pos = 0;
    function ensure(n) {
      if (pos + n <= buf.length) return;
      let size = buf.length * 2;
      while (size < pos + n) size *= 2;
      const next = new Uint8Array(size);
      next.set(buf.subarray(0, pos));
      buf = next;
    }
    return {
      byte(b) { ensure(1); buf[pos++] = b; },
      word(w) { ensure(2); buf[pos++] = (w >> 8) & 255; buf[pos++] = w & 255; },
      bytes(arr) { ensure(arr.length); buf.set(arr, pos); pos += arr.length; },
      ensure,
      get pos() { return pos; },
      set pos(p) { pos = p; },
      get buf() { return buf; },
      result() { return buf.slice(0, pos); },
    };
  }

  /**
   * Encode RGBA pixels as a baseline JPEG.
   * @param {Uint8Array|Uint8ClampedArray} rgba  width*height*4 bytes (alpha ignored)
   * @param {object} [opts]  quality 1-100 (default 75), gray (1-channel output),
   *   subsample (chroma factor 1 = 4:4:4, 2 = 4:2:0; default 2)
   * @returns {Uint8Array}
   */
  function encode(rgba, width, height, opts) {
    opts = opts || {};
    if (!(width > 0 && height > 0) || width > 65535 || height > 65535) throw new Error('Invalid JPEG dimensions');
    if (rgba.length < width * height * 4) throw new Error('Pixel buffer too small');
    const quality = opts.quality == null ? 75 : opts.quality;
    const gray = !!opts.gray;
    const sub = gray ? 1 : (opts.subsample === 1 ? 1 : 2);

    const qtY = quantTable(STD_LUMA, quality);
    const qtC = quantTable(STD_CHROMA, quality);
    const divY = divisors(qtY);
    const divC = divisors(qtC);

    const planes = makePlanes(rgba, width, height, gray, sub);
    const { pw, ph } = planes;
    const mcuX = pw / (8 * sub), mcuY = ph / (8 * sub);
    const blocksPerMcu = gray ? 1 : sub * sub + 2;
    const totalBlocks = mcuX * mcuY * blocksPerMcu;
    const coefs = new Int16Array(totalBlocks * 64);
    const tmp = new Float32Array(64);

    // Pass 1: DCT + quantization for every block, in MCU order.
    let b = 0;
    for (let my = 0; my < mcuY; my++) {
      for (let mx = 0; mx < mcuX; mx++) {
        for (let vy = 0; vy < sub; vy++) {
          for (let vx = 0; vx < sub; vx++) {
            encodeBlock(planes.Y, pw, (mx * sub + vx) * 8, (my * sub + vy) * 8, divY, tmp, coefs, b++ * 64);
          }
        }
        if (!gray) {
          encodeBlock(planes.Cb, planes.cw, mx * 8, my * 8, divC, tmp, coefs, b++ * 64);
          encodeBlock(planes.Cr, planes.cw, mx * 8, my * 8, divC, tmp, coefs, b++ * 64);
        }
      }
    }

    // Pass 2: gather symbol statistics per table (0 = luma, 1 = chroma).
    const dcFreq = [new Int32Array(256), new Int32Array(256)];
    const acFreq = [new Int32Array(256), new Int32Array(256)];
    const tableOf = new Uint8Array(blocksPerMcu); // block-in-MCU -> table
    const compOf = new Uint8Array(blocksPerMcu); // block-in-MCU -> component (DC predictor)
    for (let i = 0; i < blocksPerMcu; i++) {
      const isChroma = !gray && i >= sub * sub;
      tableOf[i] = isChroma ? 1 : 0;
      compOf[i] = isChroma ? (i === sub * sub ? 1 : 2) : 0;
    }
    {
      const pred = [0, 0, 0];
      for (let blk = 0, m = 0; blk < totalBlocks; blk++) {
        const t = tableOf[m], comp = compOf[m];
        if (++m === blocksPerMcu) m = 0;
        const off = blk * 64;
        const dc = coefs[off];
        dcFreq[t][bitLength(dc - pred[comp])]++;
        pred[comp] = dc;
        const ac = acFreq[t];
        let run = 0;
        for (let k = off + 1, end = off + 64; k < end; k++) {
          const v = coefs[k];
          if (v === 0) { run++; continue; }
          while (run > 15) { ac[0xF0]++; run -= 16; }
          ac[(run << 4) | bitLength(v)]++;
          run = 0;
        }
        if (run > 0) ac[0]++;
      }
    }
    const nTables = gray ? 1 : 2;
    const dcT = [], acT = [];
    for (let t = 0; t < nTables; t++) {
      dcT.push(optimalTable(dcFreq[t]));
      acT.push(optimalTable(acFreq[t]));
    }

    // Headers.
    const w = ByteWriter(Math.max(4096, (width * height) >> 2));
    w.word(0xFFD8); // SOI
    w.word(0xFFE0); w.word(16); // APP0 JFIF
    w.bytes([0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
    w.word(0xFFDB); w.word(2 + 65 * nTables); // DQT (zigzag order)
    const qts = [qtY, qtC];
    for (let t = 0; t < nTables; t++) {
      w.byte(t);
      const zz = new Uint8Array(64);
      for (let i = 0; i < 64; i++) zz[ZIGZAG[i]] = qts[t][i];
      w.bytes(zz);
    }
    const nComp = gray ? 1 : 3;
    w.word(0xFFC0); w.word(8 + 3 * nComp); // SOF0
    w.byte(8); w.word(height); w.word(width); w.byte(nComp);
    w.byte(1); w.byte((sub << 4) | sub); w.byte(0);
    if (!gray) {
      w.byte(2); w.byte(0x11); w.byte(1);
      w.byte(3); w.byte(0x11); w.byte(1);
    }
    for (let t = 0; t < nTables; t++) { // DHT
      for (const [cls, tab] of [[0, dcT[t]], [1, acT[t]]]) {
        w.word(0xFFC4); w.word(2 + 1 + 16 + tab.values.length);
        w.byte((cls << 4) | t);
        w.bytes(tab.counts);
        w.bytes(tab.values);
      }
    }
    w.word(0xFFDA); w.word(6 + 2 * nComp); w.byte(nComp); // SOS
    w.byte(1); w.byte(0x00);
    if (!gray) { w.byte(2); w.byte(0x11); w.byte(3); w.byte(0x11); }
    w.byte(0); w.byte(63); w.byte(0);

    // Entropy-coded data with byte stuffing.
    let out = new Uint8Array(Math.max(65536, totalBlocks * 16));
    let pos = 0, acc = 0, nbits = 0;
    const put = (code, size) => {
      acc = (acc << size) | code;
      nbits += size;
      while (nbits >= 8) {
        const byte = (acc >>> (nbits - 8)) & 255;
        out[pos++] = byte;
        if (byte === 255) out[pos++] = 0;
        nbits -= 8;
      }
      acc &= (1 << nbits) - 1;
    };
    {
      const pred = [0, 0, 0];
      for (let blk = 0, m = 0; blk < totalBlocks; blk++) {
        if (pos + 1024 > out.length) { // a block needs < 1 KB even with stuffing
          const grown = new Uint8Array(out.length * 2);
          grown.set(out.subarray(0, pos));
          out = grown;
        }
        const t = tableOf[m], comp = compOf[m];
        if (++m === blocksPerMcu) m = 0;
        const dcCodes = dcT[t].codes, dcSizes = dcT[t].sizes;
        const acCodes = acT[t].codes, acSizes = acT[t].sizes;
        const off = blk * 64;
        const dc = coefs[off];
        const diff = dc - pred[comp];
        pred[comp] = dc;
        let n = bitLength(diff);
        put(dcCodes[n], dcSizes[n]);
        if (n) put(diff < 0 ? (diff - 1) & ((1 << n) - 1) : diff, n);
        let run = 0;
        for (let k = off + 1, end = off + 64; k < end; k++) {
          const v = coefs[k];
          if (v === 0) { run++; continue; }
          while (run > 15) { put(acCodes[0xF0], acSizes[0xF0]); run -= 16; }
          n = bitLength(v);
          const sym = (run << 4) | n;
          put(acCodes[sym], acSizes[sym]);
          put(v < 0 ? (v - 1) & ((1 << n) - 1) : v, n);
          run = 0;
        }
        if (run > 0) put(acCodes[0], acSizes[0]);
      }
    }
    if (nbits > 0) put((1 << (8 - nbits)) - 1, 8 - nbits); // pad with 1-bits
    w.bytes(out.subarray(0, pos));
    w.word(0xFFD9); // EOI
    return w.result();
  }

  const api = { encode };
  root.PDFMiniJPEG = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  // Web Worker entry point.
  if (typeof importScripts === 'function' && typeof root.postMessage === 'function' && typeof document === 'undefined') {
    root.onmessage = (e) => {
      const { id, rgba, width, height, opts } = e.data;
      try {
        const out = encode(rgba, width, height, opts);
        root.postMessage({ id, jpeg: out }, [out.buffer]);
      } catch (err) {
        root.postMessage({ id, error: String((err && err.message) || err) });
      }
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
