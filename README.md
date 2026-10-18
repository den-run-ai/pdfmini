# pdfmini

Compress and combine PDFs in your browser. Files are processed on your
device and never uploaded.

**Use it: https://den-run-ai.github.io/pdfmini/**

## Features

- **Compress** – keeps text, vector graphics, links and form fields
  intact and only re-encodes the images, at a resolution that matches how
  large each image is actually shown on the page.
- **Never makes a file bigger** – if no meaningfully smaller version is
  possible, pdfmini says so instead of handing you a worse file.
- **Three simple levels** – Light, Balanced (default) and Strong.
  Everything else is under *Advanced settings*: image resolution, image
  quality, grayscale, removing document info, and *Convert pages to
  images* for scans.
- **Combine** – merge PDFs in any order (drag to reorder on desktop, arrow
  buttons on touch screens), then compress the result in one tap.
- **Same results everywhere** – pdfmini ships its own JPEG encoder, so a
  given file and setting produce byte-identical images on iPhone, Android,
  Mac and Windows (browsers' built-in encoders differ a lot).

## Compression levels

| Level | Images resampled to | JPEG quality | Good for |
|---|---|---|---|
| Light | 200 dpi | 82 | Printing, zooming in, archiving |
| **Balanced** | 144 dpi | 72 | Email, sharing, reading on any screen |
| Strong | 100 dpi | 55 | Upload limits, the smallest file that stays readable |

Images are only resampled when they are more than 15% sharper than the
target for the size they are drawn at, and JPEGs that are already at or
below the target quality are left alone, so repeated compression does not
keep degrading a file. Lossless images such as charts and screenshots are
re-encoded losslessly unless JPEG is dramatically smaller.

See [Calibration](#calibration) for how these values were chosen.

## How it works

1. [pdf-lib](https://github.com/Hopding/pdf-lib) parses the PDF.
2. Page, form and annotation content streams are interpreted to find the
   size at which every image is drawn, which gives its effective DPI.
3. Images above the target DPI are decoded, resampled and re-encoded with
   pdfmini's JPEG encoder (in Web Workers). Charts and screenshots also get
   a lossless (PNG-predicted Flate) candidate, and soft masks are resampled
   to match their images.
4. Images browsers cannot decode (CMYK, JPEG 2000, Lab, ...) are decoded by
   [PDF.js](https://github.com/mozilla/pdf.js), which is only downloaded
   when such an image or *Convert pages to images* is needed.
5. Lossless cleanups: unused objects, duplicate streams (common after
   merging), private application data and embedded thumbnails are
   removed; uncompressed, ASCII-encoded and LZW streams are re-compressed;
   objects are packed into object streams (except for PDF/A-1 files, which
   do not allow them).
6. If the result is not at least 1% smaller, the original file is kept.

## Privacy

Everything runs locally in the page. The only network requests are for
the open-source libraries (pdf-lib, and PDF.js when needed) from the
jsDelivr CDN, pinned to exact versions and checked with Subresource
Integrity. Your settings are remembered in your browser's local storage.

## Browser support

Current versions of Chrome, Edge, Firefox and Safari on desktop, iOS and
Android. Every change is tested in Chromium, Firefox and WebKit, plus
emulated Android and iPhone, in CI.

- Compressing and combining need Safari 14.1+, Chrome/Edge 85+ or
  Firefox 90+.
- CMYK/JPEG 2000 images and *Convert pages to images* use PDF.js, which
  needs Safari/iOS 16.4+, Chrome/Edge 110+ or Firefox 115+. On older
  browsers those images are left as they are.

## Limitations

- Password-protected or encrypted PDFs cannot be optimized directly. If
  the file opens without a password, *Convert pages to images* works.
- Fonts are not subset, so text-only PDFs usually shrink only a little.
- Digital signatures do not survive any modification; pdfmini tells you
  when a signed PDF was compressed.
- *Combine* keeps pages and their content, but not bookmarks or
  interactive form fields of the merged files.
- Very large files (hundreds of MB) can exceed a phone's memory.

## Development

It is a static site with no build step: `index.html`, `js/app.js` (UI),
`js/engine.js` (PDF processing) and `js/jpeg.js` (JPEG encoder).

```sh
npm install
npm run serve            # http://localhost:8080
npx playwright install   # once, to get Chromium, Firefox and WebKit
npm test                 # all browsers + mobile emulation
npm run test:chromium    # just Chromium (desktop + mobile)
```

Tests serve the CDN libraries from `node_modules`, so they run offline
against the exact versions the app uses.

### Calibration

The levels were calibrated on a corpus of real and synthetic documents
(phone scans, photo albums, reports with photos and charts, slides,
screenshots, CMYK print files, text-only papers, forms, a JPEG 2000/JBIG2
book scan) by measuring output size and visual similarity (SSIM of pages
rendered by poppler, an independent renderer) against Ghostscript's
`/screen`, `/ebook` and `/printer` presets. To repeat it:

```sh
node tools/run-engine.mjs --level balanced --out out/ my.pdf   # run the engine
python tools/quality.py my.pdf out/my.pdf                       # SSIM, text and qpdf checks
python tools/calibrate.py --out cal/ --dpi-eval 110,200 \
  --settings "100:55,144:72,200:82" --gs screen,ebook,printer corpus/*.pdf
```

The Python tools need poppler-utils, numpy, pillow, scikit-image and
pikepdf (and Ghostscript for the reference presets).

## License

MIT
