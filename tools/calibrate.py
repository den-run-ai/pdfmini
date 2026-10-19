"""Calibration sweep: file size vs. visual quality for engine settings and Ghostscript.

Usage:
  python tools/calibrate.py --out DIR [--dpi-eval 110,200] \
      --settings "144:72,200:82" [--gs screen,ebook,printer] [--reuse] corpus/*.pdf

Each setting (DPI:quality) runs the engine in headless Chromium via
tools/run-engine.mjs; Ghostscript presets serve as reference points. Outputs
and originals are rendered with poppler at each evaluation DPI (originals
only once) and compared as grayscale SSIM. Results are appended to
DIR/results.jsonl as they finish, and a summary table is printed at the end.

Needs poppler-utils, numpy, pillow, scikit-image (and gs for references).
"""
import argparse
import json
import os
import subprocess
from concurrent.futures import ProcessPoolExecutor, as_completed

import numpy as np
from PIL import Image
from skimage.metrics import structural_similarity

Image.MAX_IMAGE_PIXELS = None
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_engine(files, dpi, q, outdir, mode):
    os.makedirs(outdir, exist_ok=True)
    cmd = ["node", os.path.join(REPO, "tools/run-engine.mjs"), "--json", "--mode", mode,
           "--dpi", str(dpi), "--quality", str(q), "--out", outdir] + files
    for r in json.loads(subprocess.check_output(cmd, cwd=REPO)):
        with open(os.path.join(outdir, r["name"] + ".json"), "w") as f:
            json.dump(r, f)


def run_gs(files, preset, outdir):
    os.makedirs(outdir, exist_ok=True)
    for f in files:
        dst = os.path.join(outdir, os.path.basename(f))
        subprocess.run(["gs", "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=pdfwrite",
                        f"-dPDFSETTINGS=/{preset}", f"-sOutputFile={dst}", f],
                       check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def render(pdf, dpi, outdir):
    """Render every page to grayscale PNG once; return the sorted file list."""
    os.makedirs(outdir, exist_ok=True)
    done = os.path.join(outdir, ".done")
    if not os.path.exists(done):
        subprocess.run(["pdftoppm", "-r", str(dpi), "-gray", "-png", pdf, os.path.join(outdir, "p")],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        open(done, "w").close()
    return sorted(os.path.join(outdir, f) for f in os.listdir(outdir) if f.endswith(".png"))


def ssim_pair(a_files, b_files):
    vals = []
    for fa, fb in zip(a_files, b_files):
        ia = np.asarray(Image.open(fa).convert("L"), dtype=np.float64)
        ib = np.asarray(Image.open(fb).convert("L"), dtype=np.float64)
        h, w = min(ia.shape[0], ib.shape[0]), min(ia.shape[1], ib.shape[1])
        vals.append(structural_similarity(ia[:h, :w], ib[:h, :w], data_range=255))
    if len(a_files) != len(b_files):
        vals.append(0.0)
    return vals


def evaluate(job):
    label, orig, comp, dpis, cache = job
    name = os.path.basename(orig)
    row = {"label": label, "file": name, "in": os.path.getsize(orig), "out": os.path.getsize(comp)}
    for d in dpis:
        a = render(orig, d, os.path.join(cache, "orig", name, str(d)))
        b = render(comp, d, os.path.join(cache, label, name, str(d)))
        s = ssim_pair(a, b)
        row[f"ssim{d}"] = float(np.mean(s))
        row[f"ssim{d}_min"] = float(np.min(s))
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--settings", default="100:55,144:72,200:82")
    ap.add_argument("--gs", default="")
    ap.add_argument("--mode", default="images")
    ap.add_argument("--dpi-eval", default="120")
    ap.add_argument("--reuse", action="store_true", help="skip runs whose output dir exists")
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 4)
    ap.add_argument("files", nargs="+")
    a = ap.parse_args()
    files = [os.path.abspath(f) for f in a.files]
    dpis = [int(x) for x in a.dpi_eval.split(",")]
    cache = os.path.join(a.out, "_renders")
    configs = []
    for s in filter(None, a.settings.split(",")):
        dpi, q = (int(x) for x in s.split(":"))
        label = f"{a.mode[:4]}-{dpi}dpi-q{q}"
        outdir = os.path.join(a.out, label)
        if not (a.reuse and os.path.isdir(outdir)):
            run_engine(files, dpi, q, outdir, a.mode)
        configs.append((label, outdir))
    for preset in filter(None, a.gs.split(",")):
        label = f"gs-{preset}"
        outdir = os.path.join(a.out, label)
        if not (a.reuse and os.path.isdir(outdir)):
            run_gs(files, preset, outdir)
        configs.append((label, outdir))

    # Render originals first (in parallel) so workers never race on the cache.
    with ProcessPoolExecutor(a.jobs) as ex:
        list(ex.map(render, [f for f in files for d in dpis],
                    [d for f in files for d in dpis],
                    [os.path.join(cache, "orig", os.path.basename(f), str(d)) for f in files for d in dpis]))
    jobs = [(label, f, os.path.join(outdir, os.path.basename(f)), dpis, cache)
            for label, outdir in configs for f in files
            if os.path.exists(os.path.join(outdir, os.path.basename(f)))]
    results_path = os.path.join(a.out, "results.jsonl")
    rows = []
    with ProcessPoolExecutor(a.jobs) as ex, open(results_path, "a") as log:
        for fut in as_completed([ex.submit(evaluate, j) for j in jobs]):
            row = fut.result()
            rows.append(row)
            log.write(json.dumps(row) + "\n")
            log.flush()

    print(f"\n| setting | total size % | " + " | ".join(f"mean SSIM@{d} | worst page@{d}" for d in dpis) + " |")
    print("|---|---|" + "---|---|" * len(dpis))
    for label, _ in configs:
        sel = [r for r in rows if r["label"] == label]
        if not sel:
            continue
        ratio = sum(r["out"] for r in sel) / sum(r["in"] for r in sel)
        cells = []
        for d in dpis:
            cells.append(f"{np.mean([r[f'ssim{d}'] for r in sel]):.4f}")
            cells.append(f"{min(r[f'ssim{d}_min'] for r in sel):.4f}")
        print(f"| {label} | {ratio * 100:.2f} | " + " | ".join(cells) + " |")
    print("\nPer file (size %, SSIM@first dpi):")
    names = sorted({r["file"] for r in rows})
    print("| setting | " + " | ".join(names) + " |")
    print("|---|" + "---|" * len(names))
    for label, _ in configs:
        cells = []
        for n in names:
            r = next((x for x in rows if x["label"] == label and x["file"] == n), None)
            cells.append(f"{r['out'] / r['in'] * 100:.1f}% / {r[f'ssim{dpis[0]}']:.3f}" if r else "-")
        print(f"| {label} | " + " | ".join(cells) + " |")


if __name__ == "__main__":
    main()
