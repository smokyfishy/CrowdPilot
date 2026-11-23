"""Learned downbeat (bar-phase) model vs the browser heuristic.

  python -m ml.models.downbeat train

Labels: IRCAM `ircambeat` beat/measure markers shipped with UnmixDB (.beat.xml, full-track
timeline), mapped onto each 40 s excerpt via its cutpoint/joinpoint. These are ALGORITHMIC
labels (weak), so results are reported as agreement with ircambeat, not as accuracy.
Split: train = UnmixDB sets except held-out 275/123; test = held-out sets (unseen tracks).
Model: logistic regression on per-beat features with ±2-beat context (portable to the
browser as a JSON weight vector). Track bar phase = argmax_p Σ logit(beat i ≡ p mod 4).
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np

from ml.datasets.acquire import REPO, ROOT
from ml.datasets.unmixdb import parse_refsong, set_dirs
from ml.dsp.unmix import HOP, N_FFT, SR, load_mono, mag

FEATS = ["dlow", "dmid", "dhigh", "dchroma", "onlow", "onhigh", "low", "high"]


def beats_from_xml(p: Path) -> list[tuple[float, bool]]:
    txt = p.read_text(encoding="utf-8", errors="replace")
    out = []
    for m in re.finditer(r'<segment time="([0-9.]+)"[^>]*>\s*<beattype[^>]*measure="(\d)"', txt):
        out.append((float(m.group(1)), m.group(2) == "1"))
    return out


def excerpt_beats(xml: Path, meta: dict) -> list[tuple[float, bool]]:
    cut, join = meta["cutpoint"], meta["joinpoint"]
    out = []
    for t, d in beats_from_xml(xml):
        if t <= cut:
            out.append((t, d))
        elif t >= join:
            out.append((cut + (t - join), d))
    return [b for b in out if b[0] < meta["duration"] - 0.05]


def beat_features(x: np.ndarray, beats: np.ndarray) -> np.ndarray:
    M = mag(x)
    f = np.arange(M.shape[0]) * SR / N_FFT
    P = M**2
    low, mid, high = (np.log10(1e-10 + P[(f >= a) & (f < b)].sum(0)) for a, b in ((0, 150), (150, 2500), (2500, SR / 2)))
    L = np.log1p(100 * M)
    d = np.maximum(0, np.diff(L, axis=1, prepend=L[:, :1]))
    on_low = d[f < 150].sum(0)
    on_high = d[f >= 2500].sum(0)
    pc = np.round(69 + 12 * np.log2(np.maximum(f, 1e-6) / 440)).astype(int) % 12
    chroma = np.stack([P[(pc == k) & (f > 55) & (f < 5000)].sum(0) for k in range(12)])
    chroma /= chroma.sum(0, keepdims=True) + 1e-12
    fps = SR / HOP
    fr = np.clip((beats * fps).astype(int), 0, M.shape[1] - 1)
    seg = lambda a, b, arr: arr[..., a:max(a + 1, b)].mean(-1)  # noqa: E731
    rows = []
    for i in range(len(fr)):
        a = fr[i]
        b = fr[i + 1] if i + 1 < len(fr) else min(M.shape[1], a + (a - fr[i - 1] if i else 20))
        pa = fr[i - 1] if i else max(0, a - (b - a))
        cur = [seg(a, b, low), seg(a, b, mid), seg(a, b, high), seg(a, b, chroma)]
        prv = [seg(pa, a, low), seg(pa, a, mid), seg(pa, a, high), seg(pa, a, chroma)]
        rows.append([cur[0] - prv[0], cur[1] - prv[1], cur[2] - prv[2], float(np.abs(cur[3] - prv[3]).sum()), on_low[a], on_high[a], cur[0], cur[2]])
    F = np.array(rows, np.float32)
    F = (F - F.mean(0)) / (F.std(0) + 1e-6)  # per-track standardisation (portable)
    return F


def with_context(F: np.ndarray, k: int = 2) -> np.ndarray:
    pads = [np.roll(F, s, axis=0) for s in range(-k, k + 1)]
    return np.concatenate(pads, axis=1)


def load(split: str) -> list[dict]:
    from ml.experiments.eval_alignment import HELDOUT_SETS

    out = []
    for sdir in set_dirs(ROOT / "raw" / "unmixdb" / "extracted"):
        held = sdir.name in HELDOUT_SETS
        if (split == "test") != held:
            continue
        for xml in sorted((sdir / "refsongs").glob("*.beat.xml")):
            mp3 = xml.with_name(xml.name.replace(".beat.xml", ".excerpt40.mp3"))
            txt = mp3.with_suffix(".txt")
            if not (mp3.exists() and txt.exists()):
                continue
            meta = parse_refsong(txt)
            b = excerpt_beats(xml, meta)
            if len(b) < 24 or sum(d for _, d in b) < 4:
                continue
            t = np.array([x for x, _ in b])
            y = np.array([d for _, d in b], bool)
            F = beat_features(load_mono(mp3), t)
            out.append({"track": mp3.name, "set": sdir.name, "F": F, "y": y})
    return out


def phase_of(scores: np.ndarray) -> int:
    return int(np.argmax([scores[p::4].mean() for p in range(4)]))


def true_phase(y: np.ndarray) -> int:
    return int(np.argmax([y[p::4].mean() for p in range(4)]))


def train(_=None) -> None:
    from sklearn.linear_model import LogisticRegression

    tr, te = load("train"), load("test")
    Xtr = np.concatenate([with_context(d["F"]) for d in tr])
    ytr = np.concatenate([d["y"] for d in tr])
    clf = LogisticRegression(max_iter=2000, C=1.0, class_weight="balanced").fit(Xtr, ytr)
    res = {}
    for name, dset in (("train", tr), ("test_heldout", te)):
        heur, learned = [], []
        for d in dset:
            tp = true_phase(d["y"])
            # browser heuristic replica: mean bar-synchronous change (|Δbands| + 4·Δchroma) + small low-onset accent
            h = np.abs(d["F"][:, 0]) + np.abs(d["F"][:, 1]) + np.abs(d["F"][:, 2]) + 4 * d["F"][:, 3] + 0.02 * d["F"][:, 4]
            heur.append(phase_of(h) == tp)
            learned.append(phase_of(clf.decision_function(with_context(d["F"]))) == tp)
        res[name] = {"tracks": len(dset), "heuristic_phase_agreement_pct": round(100 * float(np.mean(heur)), 1), "learned_phase_agreement_pct": round(100 * float(np.mean(learned)), 1)}
    card = {"model": "DownbeatLR v1", "labels": "ircambeat measure markers (algorithmic, weak)", "features": FEATS, "context": 2, "train_tracks": len(tr), "test_tracks": len(te), "results": res, "coef": clf.coef_[0].round(5).tolist(), "intercept": float(clf.intercept_[0]), "split": "UnmixDB sets; held-out = set275+set123 (unseen tracks)"}
    out = ROOT / "models" / "downbeat"
    out.mkdir(parents=True, exist_ok=True)
    (out / "downbeat_lr.json").write_text(json.dumps(card, indent=1), encoding="utf-8")
    (REPO / "reports" / "train_downbeat_lr.json").write_text(json.dumps({k: v for k, v in card.items() if k not in ("coef",)}, indent=1), encoding="utf-8")
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    sys.exit(train())
