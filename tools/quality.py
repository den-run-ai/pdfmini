"""Compare original and compressed PDFs with an independent renderer (poppler).

Usage: python tools/quality.py [--dpi 150] original.pdf compressed.pdf [...pairs]

Prints per-file: size ratio, page count check, mean/min SSIM and PSNR of the
rendered pages (grayscale), whether extracted text is unchanged, and qpdf
structural problems. Needs: poppler-utils (pdftoppm, pdftotext), numpy,
pillow, scikit-image, pikepdf.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

import numpy as np
import pikepdf
from PIL import Image
from skimage.metrics import structural_similarity

Image.MAX_IMAGE_PIXELS = None


def render(pdf, dpi, outdir, tag):
    prefix = os.path.join(outdir, tag)
    subprocess.run(["pdftoppm", "-r", str(dpi), "-gray", "-png", pdf, prefix], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    files = sorted(f for f in os.listdir(outdir) if f.startswith(tag + "-") and f.endswith(".png"))
    return [os.path.join(outdir, f) for f in files]


def text_of(pdf):
    out = subprocess.run(["pdftotext", "-q", pdf, "-"], capture_output=True)
    return " ".join(out.stdout.decode("utf-8", "replace").split())


def compare(orig, comp, dpi):
    res = {"file": os.path.basename(orig), "in": os.path.getsize(orig), "out": os.path.getsize(comp)}
    res["ratio"] = res["out"] / res["in"]
    try:
        with pikepdf.open(comp) as p:
            check = getattr(p, "check_pdf_syntax", None) or p.check
            problems = [str(x) for x in check()]
            res["pages_out"] = len(p.pages)
        res["qpdf_problems"] = problems[:3]
    except Exception as e:  # noqa: BLE001
        res["qpdf_problems"] = [f"open failed: {e}"]
        return res
    with pikepdf.open(orig) as p:
        res["pages_in"] = len(p.pages)
    res["text_same"] = text_of(orig) == text_of(comp)
    with tempfile.TemporaryDirectory() as tmp:
        a = render(orig, dpi, tmp, "a")
        b = render(comp, dpi, tmp, "b")
        ssims, psnrs = [], []
        for fa, fb in zip(a, b):
            ia = np.asarray(Image.open(fa).convert("L"), dtype=np.float64)
            ib = np.asarray(Image.open(fb).convert("L"), dtype=np.float64)
            if ia.shape != ib.shape:
                h, w = min(ia.shape[0], ib.shape[0]), min(ia.shape[1], ib.shape[1])
                ia, ib = ia[:h, :w], ib[:h, :w]
                res["size_mismatch"] = True
            ssims.append(structural_similarity(ia, ib, data_range=255))
            mse = np.mean((ia - ib) ** 2)
            psnrs.append(99.0 if mse == 0 else 10 * np.log10(255 ** 2 / mse))
    res["ssim_mean"] = float(np.mean(ssims)) if ssims else None
    res["ssim_min"] = float(np.min(ssims)) if ssims else None
    res["psnr_mean"] = float(np.mean(psnrs)) if psnrs else None
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dpi", type=int, default=150)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("files", nargs="+")
    args = ap.parse_args()
    if len(args.files) % 2:
        sys.exit("expected pairs: original compressed")
    rows = [compare(args.files[i], args.files[i + 1], args.dpi) for i in range(0, len(args.files), 2)]
    if args.json:
        print(json.dumps(rows, indent=1))
        return
    for r in rows:
        print(f"{r['file']:<28} {r['in']/1e6:7.2f}MB -> {r['out']/1e6:7.2f}MB ({r['ratio']*100:5.1f}%)"
              f"  pages {r.get('pages_in')}/{r.get('pages_out')}"
              f"  ssim {r.get('ssim_mean') or 0:.4f} (min {r.get('ssim_min') or 0:.4f})"
              f"  psnr {r.get('psnr_mean') or 0:5.1f}  text {'same' if r.get('text_same') else 'DIFF'}"
              f"  {'qpdf: ' + '; '.join(r['qpdf_problems']) if r.get('qpdf_problems') else ''}")


if __name__ == "__main__":
    main()
