"""Contrastive tempo-invariant alignment embedding (AlignEmbed).

Train:  python -m ml.models.align_embed train --workers 60 --steps 4000
Eval:   python -m ml.experiments.eval_alignment --features learned|learned+bands

Supervision: REAL positive pairs from UnmixDB training sets (labels give, for every mix
frame, the source time that plays there: u = speed·(t − start)), so positives include sox
resampling/time-stretching, bass/compressor/distortion effects and overlap with the other
track. Held-out evaluation sets (ml/experiments/eval_alignment.HELDOUT_SETS) are excluded
from training (no track leakage). Synthetic-reference domain only — not human DJ truth.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
from pathlib import Path

import numpy as np

from ml.datasets.acquire import REPO, ROOT
from ml.dsp.unmix import HOP, N_FFT, SR, load_mono, mag

N_MELS = 64
WIN = 32  # frames of context (≈0.74 s)
DIM = 32
CKPT_DIR = ROOT / "models" / "align_embed"


def mel_fb(sr: int = SR, n_fft: int = N_FFT, n_mels: int = N_MELS, fmin: float = 30.0, fmax: float = 10000.0) -> np.ndarray:
    hz2mel = lambda f: 2595 * np.log10(1 + f / 700)  # noqa: E731
    mel2hz = lambda m: 700 * (10 ** (m / 2595) - 1)  # noqa: E731
    pts = mel2hz(np.linspace(hz2mel(fmin), hz2mel(fmax), n_mels + 2))
    f = np.arange(n_fft // 2 + 1) * sr / n_fft
    fb = np.zeros((n_mels, len(f)), np.float32)
    for i in range(n_mels):
        lo, c, hi = pts[i], pts[i + 1], pts[i + 2]
        fb[i] = np.clip(np.minimum((f - lo) / (c - lo), (hi - f) / (hi - c)), 0, None)
    return fb


_FB = mel_fb()


def logmel_from_mag(M: np.ndarray) -> np.ndarray:
    L = np.log1p(1000 * (_FB @ (M**2)))
    return ((L - L.mean()) / (L.std() + 1e-6)).astype(np.float32)


def build_model():
    import torch.nn as nn
    import torch.nn.functional as F

    class AlignNet(nn.Module):
        def __init__(self):
            super().__init__()
            def blk(i, o, pool):
                return nn.Sequential(nn.Conv2d(i, o, 3, padding=1), nn.BatchNorm2d(o), nn.ReLU(), nn.MaxPool2d(pool))
            self.f = nn.Sequential(blk(1, 32, (2, 1)), blk(32, 64, (2, 2)), blk(64, 128, (2, 2)), blk(128, 128, (2, 2)))
            self.head = nn.Linear(128, DIM)

        def forward(self, x):  # x: (B, 64, WIN)
            h = self.f(x[:, None]).mean(dim=(2, 3))
            return F.normalize(self.head(h), dim=-1)

    return AlignNet()


# ───────────────────────── data ─────────────────────────

def _prep_mix(lab_path: str) -> dict | None:
    from ml.datasets.unmixdb import parse_mix_labels

    try:
        ml = parse_mix_labels(Path(lab_path))
        Mm = logmel_from_mag(mag(load_mono(ml.audio)))
        tracks = []
        for tr in ml.tracks.values():
            S = logmel_from_mag(mag(load_mono(ml.path.parent.parent / "refsongs" / tr.file)))
            fps = SR / HOP
            lo = max(tr.fadein[0] if tr.fadein else tr.start, 0)
            hi = min(tr.fadeout[1] if tr.fadeout else (tr.stop or 1e9), Mm.shape[1] / fps)
            t = np.arange(int(lo * fps) + WIN, int(hi * fps) - WIN)
            u = (tr.speed * (t / fps - tr.start) * fps).astype(int)
            ok = (u >= WIN) & (u < S.shape[1] - WIN)
            tracks.append({"S": S, "t": t[ok], "u": u[ok]})
        return {"M": Mm, "tracks": tracks}
    except Exception:  # noqa: BLE001
        return None


def load_training(workers: int, max_mixes: int | None) -> list[dict]:
    from multiprocessing import Pool

    from ml.datasets.unmixdb import set_dirs
    from ml.experiments.eval_alignment import HELDOUT_SETS

    labs = []
    for sdir in set_dirs(ROOT / "raw" / "unmixdb" / "extracted"):
        if sdir.name in HELDOUT_SETS:
            continue
        for lab in sorted((sdir / "mixes").glob("*.labels.txt")):
            if lab.with_name(lab.name.replace(".labels.txt", ".mp3")).exists():
                labs.append(str(lab))
    if max_mixes:
        labs = labs[:max_mixes]
    with Pool(workers) as p:
        data = [d for d in p.map(_prep_mix, labs, chunksize=4) if d]
    return data


def sample_batch(data: list[dict], rng: np.random.Generator, B: int) -> tuple[np.ndarray, np.ndarray]:
    a = np.empty((B, N_MELS, WIN), np.float32)
    p = np.empty((B, N_MELS, WIN), np.float32)
    h = WIN // 2
    i = 0
    while i < B:
        d = data[rng.integers(len(data))]
        tr = d["tracks"][rng.integers(len(d["tracks"]))]
        if not len(tr["t"]):
            continue
        k = rng.integers(len(tr["t"]))
        t, u = tr["t"][k], tr["u"][k]
        a[i] = tr["S"][:, u - h : u + h]
        p[i] = d["M"][:, t - h : t + h]
        i += 1
    return a, p


def train(args: argparse.Namespace) -> None:
    import torch
    import torch.nn.functional as F

    torch.set_num_threads(args.threads)
    rng = np.random.default_rng(args.seed)
    torch.manual_seed(args.seed)
    t0 = time.time()
    data = load_training(args.workers, args.max_mixes)
    prep_s = time.time() - t0
    n_val = max(8, len(data) // 20)  # validation = held-out MIXES of training sets (loss monitoring only)
    val, tr_data = data[:n_val], data[n_val:]
    model = build_model()
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=args.steps)
    tau = 0.07
    log = []
    vrng = np.random.default_rng(123)
    va, vp = sample_batch(val, vrng, 1024)
    for step in range(1, args.steps + 1):
        a, p = sample_batch(tr_data, rng, args.batch)
        za, zp = model(torch.from_numpy(a)), model(torch.from_numpy(p))
        logits = za @ zp.T / tau
        y = torch.arange(len(a))
        loss = 0.5 * (F.cross_entropy(logits, y) + F.cross_entropy(logits.T, y))
        opt.zero_grad()
        loss.backward()
        opt.step()
        sched.step()
        if step % 100 == 0 or step == args.steps:
            model.eval()
            with torch.no_grad():
                l2 = model(torch.from_numpy(va)) @ model(torch.from_numpy(vp)).T
                vacc = float((l2.argmax(1) == torch.arange(len(va))).float().mean())
            model.train()
            log.append({"step": step, "loss": round(float(loss), 4), "val_top1_of_1024": round(vacc, 4), "elapsed_s": round(time.time() - t0)})
            print(json.dumps(log[-1]), flush=True)
    CKPT_DIR.mkdir(parents=True, exist_ok=True)
    path = CKPT_DIR / f"align_embed_s{args.seed}.pt"
    torch.save(model.state_dict(), path)
    sha = hashlib.sha256(path.read_bytes()).hexdigest()
    card = {"model": "AlignEmbed v1", "params": sum(p.numel() for p in model.parameters()), "train_mixes": len(tr_data), "val_mixes": len(val), "steps": args.steps, "batch": args.batch, "seed": args.seed, "prep_seconds": round(prep_s), "train_seconds": round(time.time() - t0 - prep_s), "checkpoint_sha256": sha, "checkpoint": str(path), "log": log, "hardware": f"{os.cpu_count()} vCPU ({os.environ.get('CP_HARDWARE', 'unknown')})", "data_domain": "synthetic_reference (UnmixDB train sets; held-out sets excluded)"}
    (CKPT_DIR / f"align_embed_s{args.seed}.json").write_text(json.dumps(card, indent=1), encoding="utf-8")
    (REPO / "reports").mkdir(exist_ok=True)
    (REPO / "reports" / f"train_align_embed_s{args.seed}.json").write_text(json.dumps(card, indent=1), encoding="utf-8")
    print(json.dumps({k: v for k, v in card.items() if k != "log"}))


# ───────────────────────── inference ─────────────────────────

_MODEL = None


def embed_frames(M: np.ndarray, seed: int = 0) -> np.ndarray:
    """(DIM, frames) embedding sequence for a magnitude STFT computed with N_FFT/HOP."""
    global _MODEL
    import torch

    if _MODEL is None:
        _MODEL = build_model()
        _MODEL.load_state_dict(torch.load(CKPT_DIR / f"align_embed_s{seed}.pt", map_location="cpu"))
        _MODEL.eval()
    L = logmel_from_mag(M)
    h = WIN // 2
    Lp = np.pad(L, ((0, 0), (h, h)), mode="edge")
    T = L.shape[1]
    out = np.empty((DIM, T), np.float32)
    with torch.no_grad():
        for s in range(0, T, 4096):
            idx = np.arange(s, min(T, s + 4096))
            patches = np.stack([Lp[:, i : i + WIN] for i in idx])
            out[:, idx] = _MODEL(torch.from_numpy(patches)).numpy().T
    return out


def main(argv=None):
    p = argparse.ArgumentParser(prog="python -m ml.models.align_embed")
    sub = p.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("train")
    t.add_argument("--workers", type=int, default=8)
    t.add_argument("--threads", type=int, default=os.cpu_count() or 8)
    t.add_argument("--steps", type=int, default=4000)
    t.add_argument("--batch", type=int, default=512)
    t.add_argument("--lr", type=float, default=2e-3)
    t.add_argument("--seed", type=int, default=0)
    t.add_argument("--max-mixes", type=int)
    t.set_defaults(fn=train)
    a = p.parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    main()
