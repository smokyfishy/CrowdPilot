"""Held-out alignment evaluation on UnmixDB time-scaled mixes (fixed list, reproducible).

  python -m ml.experiments.eval_alignment --features full|bands|learned [--n 24]
"""
from __future__ import annotations
import argparse, json, time
from pathlib import Path
import numpy as np
from ml.datasets.acquire import ROOT, REPO
from ml.datasets.unmixdb import parse_mix_labels, set_dirs
import ml.dsp.unmix as U

HELDOUT_SETS = ("mixotic-set275-excerpts", "mixotic-set123-excerpts")  # tracks never used for training


def heldout_mixes(n: int, timescales=("resample", "stretch")) -> list[Path]:
    labs = []
    for sdir in set_dirs(ROOT / "raw" / "unmixdb" / "extracted"):
        if sdir.name not in HELDOUT_SETS:
            continue
        for lab in sorted((sdir / "mixes").glob("*.labels.txt")):
            ml = parse_mix_labels(lab)
            if ml.timescale in timescales and ml.audio.exists():
                labs.append(lab)
    rng = np.random.default_rng(0)
    rng.shuffle(labs)
    return sorted(labs[:n])


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--features", default="bands")
    p.add_argument("--n", type=int, default=24)
    p.add_argument("--timescales", nargs="*", default=["resample", "stretch"])
    a = p.parse_args(argv)
    U.FEATURES = a.features
    rows, t0 = [], time.time()
    for lab in heldout_mixes(a.n, tuple(a.timescales)):
        ml = parse_mix_labels(lab)
        r = U.verify_mix(ml, lab.parent.parent / "refsongs")
        for t in r["tracks"]:
            rows.append({"mix": r["mix"], "ts": r["timescale"], "ok50": t["start_err_ms"] <= 50, "err": t["start_err_ms"], "gc": t["gain_corr"], "valid": r["alignment_validated"]})
    by = {}
    for ts in sorted({r["ts"] for r in rows}):
        g = [r for r in rows if r["ts"] == ts]
        mixes = {r["mix"]: r["valid"] for r in g}
        by[ts] = {"tracks": len(g), "start_within_50ms_pct": 100 * np.mean([r["ok50"] for r in g]), "gain_corr_median": float(np.nanmedian([r["gc"] if r["gc"] is not None else np.nan for r in g])), "mixes_validated_pct": 100 * np.mean(list(mixes.values()))}
    out = {"features": a.features, "heldout_sets": HELDOUT_SETS, "n_mixes": len({r["mix"] for r in rows}), "seconds": round(time.time() - t0), "by_timescale": by}
    path = REPO / "reports" / f"alignment_eval_{a.features}.json"
    path.write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
