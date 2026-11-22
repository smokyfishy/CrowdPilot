"""Experiment 3 — reproduce DJtransGAN (Chen et al., ICASSP 2022; MIT licence) pretrained inference.

Runs the official generator checkpoint (djtransgan_minmax.pt / djtransgan_least_square.pt) on
CrowdPilot's held-out pairs, with the SAME 8-bar cue regions CrowdPilot's bass swap uses
(evaluation/ml/djtg_pairs.eval.ts writes them). Adaptations, all outside the model:
  * beat/downbeat tracking: madmom (not installable here) is replaced by the Beat This! beats
    we already computed for these tracks (stronger tracker; same role),
  * time stretching: pyrubberband needs the rubberband CLI (absent on this machine) → librosa's
    phase vocoder. Pairs are chosen within ±2 % tempo so the stretch is small,
  * audio I/O via soundfile (torchaudio's backends changed since the repo's pinned version).

    <djtg-venv>/python -I ml/experiments/run_djtransgan.py <DJTransGAN repo dir> <pairs.json> <out dir> [minmax|least_square]
"""
from __future__ import annotations

import json
import os
import sys
import time
import types

import numpy as np


def main():
    repo, pairs_path, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    variant = sys.argv[4] if len(sys.argv) > 4 else "minmax"
    # stub madmom before the package imports it (never called: estimate_beat is replaced)
    for name in ("madmom", "madmom.features", "madmom.features.downbeats"):
        sys.modules[name] = types.ModuleType(name)
    sys.modules["madmom.features.downbeats"].DBNDownBeatTrackingProcessor = object
    sys.modules["madmom.features.downbeats"].RNNDownBeatProcessor = object
    # `acoustics` (training-time noise augmentation only) no longer imports with current SciPy
    for name in ("acoustics", "acoustics.generator"):
        sys.modules[name] = types.ModuleType(name)
    sys.modules["acoustics.generator"].noise = lambda *a, **k: None
    sys.path.insert(0, repo)
    import torchaudio
    if not hasattr(torchaudio, "set_audio_backend"):  # removed in torchaudio 2.x; the repo calls it at import
        torchaudio.set_audio_backend = lambda *_a, **_k: None
    import librosa
    import soundfile as sf
    import torch

    import djtransgan.process.process as proc
    import djtransgan.process.sync as sync
    from djtransgan.config import settings
    from djtransgan.model import get_generator
    from djtransgan.process.beat import estimate_bpm
    from djtransgan.process.utils import filter_beat

    def stretch(audio, ratio, sr=settings.SR):
        if ratio == 1:
            return audio
        x = audio.squeeze().numpy() if isinstance(audio, torch.Tensor) else audio
        y = librosa.effects.time_stretch(x.astype(np.float32), rate=float(ratio))
        return torch.from_numpy(y).unsqueeze(0) if isinstance(audio, torch.Tensor) else y

    sync.time_stretch = stretch
    queue: list = []

    def fake_estimate_beat(_audio):
        beats, downbeats = queue.pop(0)
        b = np.asarray(beats, float)
        d = np.asarray([x for x in downbeats if x >= b[0] - 1e-6], float)
        d = np.asarray([b[np.argmin(np.abs(b - x))] for x in d])  # downbeats on the beat list
        return (4, 4), estimate_bpm(b), filter_beat(b, d, 4), d

    proc.estimate_beat = fake_estimate_beat

    gen = get_generator()
    ckpt = os.path.join(repo, "pretrained", f"djtransgan_{variant}.pt")
    state = torch.load(ckpt, map_location="cpu")
    gen.load_state_dict(state)
    gen.eval()

    def load(path):
        x, sr = sf.read(path, dtype="float32", always_2d=True)
        x = x.mean(axis=1)
        if sr != settings.SR:
            x = librosa.resample(x, orig_sr=sr, target_sr=settings.SR)
        return torch.from_numpy(x).unsqueeze(0)

    os.makedirs(out_dir, exist_ok=True)
    results = []
    for p in json.load(open(pairs_path)):
        t0 = time.time()
        prev, nxt = load(p["prev_wav"]), load(p["next_wav"])
        queue[:] = [(p["prev_beats"], p["prev_downbeats"]), (p["next_beats"], p["next_downbeats"])]
        try:
            (pair_audio, timestamps), (pair_for_g, cue_for_g) = proc.preprocess(prev, nxt, p["prev_cue"], p["next_cue"])
        except Exception as e:  # e.g. the 8-bar region would start before the first downbeat
            results.append({"id": p["id"], "error": f"{type(e).__name__}: {e}"})
            print(p["id"], "FAILED", e)
            continue
        with torch.no_grad():
            mix, mix_out = gen.infer(*[t.to(torch.float32) for t in pair_for_g], cue_region=cue_for_g.to(torch.float32))
            post, post_cue = proc.postprocess(mix, pair_audio, timestamps, cue_for_g)
        y = post.squeeze().numpy().astype(np.float32)
        # keep 10 s before / after the cue region, like the CrowdPilot render
        c0, c1 = float(post_cue[0]), float(post_cue[1])
        a, b = max(0, int((c0 - 10) * settings.SR)), min(len(y), int((c1 + 10) * settings.SR))
        clip = y[a:b]
        peak = float(np.max(np.abs(clip)) + 1e-9)
        if peak > 0.99:
            clip = clip * (0.99 / peak)
        f = os.path.join(out_dir, f"{p['id']}_djtransgan_{variant}.wav")
        sf.write(f, clip, settings.SR, subtype="PCM_16")
        # mixer controls the generator produced (fader + 3-band EQ curves) for inspection
        def ser(v):
            if isinstance(v, torch.Tensor):
                t = v.detach().squeeze().cpu()
                return t.numpy().round(4).tolist() if t.numel() <= 2048 else {"shape": list(t.shape), "mean": float(t.float().mean())}
            if isinstance(v, dict):
                return {str(k): ser(x) for k, x in v.items()}
            if isinstance(v, (list, tuple)):
                return [ser(x) for x in v]
            return v if isinstance(v, (int, float, str, type(None))) else str(type(v))
        ctrl = ser(mix_out)
        results.append({"id": p["id"], "file": f, "t0": c0 - a / settings.SR, "t1": c1 - a / settings.SR, "seconds": round(time.time() - t0, 1),
                        "peak_before_norm": peak, "controls": ctrl})
        print(p["id"], "ok", round(time.time() - t0, 1), "s")
    json.dump(results, open(os.path.join(out_dir, f"djtransgan_{variant}_results.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
