// Build a stand-in for a software-generated tax return: official IRS forms
// filled with synthetic values, flattened and merged into one PDF.
//
//   node tools/make-form-return.mjs out/return.pdf
//
// Downloads the forms from irs.gov (cached next to the output).
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, PDFTextField, PDFCheckBox } from 'pdf-lib';

const FORMS = ['f1040', 'f1040s1', 'f1040s2', 'f1040s3', 'f1040sa', 'f1040sb', 'f1040sc', 'f1040sd', 'f1040se',
  'f1040sse', 'f8949', 'f8995', 'f8812', 'f8889', 'f8962', 'f2441', 'f8863', 'f4562'];

const out = process.argv[2];
if (!out) {
  console.error('usage: node tools/make-form-return.mjs out/return.pdf');
  process.exit(1);
}
const cache = path.join(path.dirname(out), 'irs-forms');
fs.mkdirSync(cache, { recursive: true });

let seed = 7;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

async function form(name) {
  const file = path.join(cache, `${name}.pdf`);
  if (!fs.existsSync(file)) {
    const res = await fetch(`https://www.irs.gov/pub/irs-pdf/${name}.pdf`);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return fs.readFileSync(file);
}

const result = await PDFDocument.create();
for (const name of FORMS) {
  const doc = await PDFDocument.load(await form(name));
  const fields = doc.getForm(); // pdf-lib drops the XFA copy here
  for (const field of fields.getFields()) {
    try {
      if (field instanceof PDFTextField) {
        let v = rand() < 0.5 ? Math.floor(rand() * 90000 + 1000).toLocaleString('en-US') : 'Jane Q Taxpayer';
        const max = field.getMaxLength();
        if (max) v = v.replace(/\D/g, '').slice(0, max) || '1';
        field.setText(v);
      } else if (field instanceof PDFCheckBox && rand() < 0.3) {
        field.check();
      }
    } catch { /* some fields reject values */ }
  }
  fields.flatten();
  for (const page of await result.copyPages(doc, doc.getPageIndices())) result.addPage(page);
}
fs.writeFileSync(out, await result.save());
console.log(`${out}: ${result.getPageCount()} pages, ${fs.statSync(out).size} bytes`);
