"""Three-way DJ-mix verification: align source recordings to a mix, estimate per-track
gain curves (inverse fader reconstruction), re-render, and measure the error.

Model (magnitude STFT, robust to time-stretch/resample/effects):
    |M(f, t)|  ≈  Σ_k g_k(t) · |X_k(f, w_k(t))|,   w_k(t) = speed_k · (t − start_k)
g_k ≥ 0 per frame by NNLS, then median-smoothed. The inverse problem is not uniquely
identifiable in general, so outputs are PSEUDO-LABELS with residuals attached.
For timescale ∈ {none, resample} a time-domain re-render and SNR are also reported.
"""
from __future__ import annotations

import dataclasses
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.optimize import nnls
from scipy.signal import correlate, medfilt, resample_poly, stft

SR = 22050
N_FFT = 2048
HOP = 512


class AudioDecodeError(Exception):
    pass


def load_mono(path: str | Path, sr: int = SR) -> np.ndarray:
    try:
        x, r = sf.read(str(path), always_2d=True, dtype="float32")
    except Exception as e:  # noqa: BLE001
        raise AudioDecodeError(f"{Path(path).name}: {e}") from e
    if x.size == 0:
        raise AudioDecodeError(f"{Path(path).name}: empty audio")
    x = x.mean(axis=1)
    if not np.isfinite(x).all():
        raise AudioDecodeError(f"{Path(path).name}: non-finite samples")
    if r != sr:
        g = np.gcd(int(r), int(sr))
        x = resample_poly(x, sr // g, int(r) // g).astype(np.float32)
    return x


def mag(x: np.ndarray) -> np.ndarray:
    _, _, Z = stft(x, fs=SR, nperseg=N_FFT, noverlap=N_FFT - HOP, boundary=None, padded=False)
    return np.abs(Z).astype(np.float32)


def onset_env(M: np.ndarray) -> np.ndarray:
    L = np.log1p(100 * M)
    d = np.maximum(0, np.diff(L, axis=1)).sum(axis=0)
    d = np.concatenate([[0], d])
    d -= np.convolve(d, np.ones(16) / 16, mode="same")
    return np.maximum(d, 0)


@dataclasses.dataclass
class Alignment:
    start: float  # mix time of source t=0 (s)
    speed: float
    score: float  # normalised cross-correlation peak of onset envelopes (0..1)
    confident: bool


MP3_ENCODER_DELAY_S = 1105 / 44100  # LAME encoder delay; appears as a constant offset between files


def ncc(m: np.ndarray, w: np.ndarray, min_overlap: int) -> tuple[np.ndarray, np.ndarray]:
    """Pearson correlation of w against m at every lag over the exact overlap (FFT sliding sums).
    Returns (lags, ncc) with ncc in [-1, 1] and −inf where the overlap is too short."""
    n, L = len(m), len(w)
    om, ow = np.ones(n), np.ones(L)
    smw = correlate(m, w, mode="full", method="fft")
    sm = correlate(m, ow, mode="full", method="fft")
    smm = correlate(m * m, ow, mode="full", method="fft")
    sw = correlate(om, w, mode="full", method="fft")
    sww = correlate(om, w * w, mode="full", method="fft")
    lags = np.arange(-L + 1, n)
    N = (np.minimum(n, lags + L) - np.maximum(0, lags)).astype(float)
    with np.errstate(invalid="ignore", divide="ignore"):
        num = smw - sm * sw / N
        den = np.sqrt(np.maximum(smm - sm * sm / N, 0) * np.maximum(sww - sw * sw / N, 0))
        r = num / den
    r[(N < min_overlap) | ~np.isfinite(r)] = -np.inf
    return lags, r


def align(mix_env: np.ndarray, src_env: np.ndarray, speeds: np.ndarray, min_score: float = 0.3, window: tuple[float, float] | None = None) -> Alignment:
    """Coarse alignment over a speed grid by normalised cross-correlation of onset envelopes
    (frame resolution HOP/SR ≈ 23 ms). Refine with `refine_waveform` where the waveform is
    preserved (none/resample)."""
    fps = SR / HOP
    best = Alignment(0.0, 1.0, -np.inf, False)
    for s in speeds:
        L = int(len(src_env) / s)
        if L < 8:
            continue
        w = np.interp(np.arange(L) * s, np.arange(len(src_env)), src_env)
        lags, r = ncc(mix_env, w, min_overlap=int(0.6 * min(len(mix_env), L)))
        if window:
            r = np.where((lags / fps >= window[0]) & (lags / fps <= window[1]), r, -np.inf)
        i = int(np.argmax(r))
        if r[i] > best.score:
            best = Alignment(start=float(lags[i] / fps), speed=float(s), score=float(r[i]), confident=False)
    best.confident = bool(best.score >= min_score)
    return best


def fine_env(x: np.ndarray, hop: int = 128) -> np.ndarray:
    _, _, Z = stft(x, fs=SR, nperseg=1024, noverlap=1024 - hop, boundary=None, padded=False)
    return onset_env(np.abs(Z).astype(np.float32))


def align_full(mix: np.ndarray, src: np.ndarray, timescale: str, mix_env: np.ndarray, src_env: np.ndarray, window: tuple[float, float] | None = None) -> tuple[Alignment, float | None]:
    """Coarse speed/lag on onset envelopes → fine speed (0.0005 steps, 5.8 ms envelope) →
    (none/resample only) sample-exact waveform NCC over ALL lags, which uses the whole
    excerpt and so resolves bar-repetition ambiguity. Returns (alignment, waveform peak NCC)."""
    if timescale == "none":
        speeds = np.array([1.0])
        al = align(mix_env, src_env, speeds, window=window)
    else:
        al = align(mix_env, src_env, np.round(np.arange(0.90, 1.1001, 0.005), 4), window=window)
        fm, fs_ = fine_env(mix), fine_env(src)
        hop_fps = SR / 128
        best = (-np.inf, al.speed, al.start)
        for sp in np.arange(al.speed - 0.006, al.speed + 0.0061, 0.0005):
            L = int(len(fs_) / sp)
            w = np.interp(np.arange(L) * sp, np.arange(len(fs_)), fs_)
            lags, r = ncc(fm, w, min_overlap=int(0.6 * min(len(fm), L)))
            if window:
                r = np.where((lags / hop_fps >= window[0]) & (lags / hop_fps <= window[1]), r, -np.inf)
            i = int(np.argmax(r))
            if r[i] > best[0]:
                best = (float(r[i]), float(sp), float(lags[i] / hop_fps))
        al = Alignment(start=best[2], speed=round(best[1], 5), score=best[0], confident=best[0] >= 0.3)
    if timescale not in ("none", "resample"):
        return al, None
    n_out = int(round(len(src) / al.speed))
    x = np.interp(np.arange(n_out) * al.speed, np.arange(len(src)), src).astype(np.float32) if al.speed != 1.0 else src
    # Waveform stage on a mix SEGMENT around the envelope estimate (±3 s): sample-exact and
    # memory-bounded for hour-long mixes. The segment still covers the whole placed track,
    # so bar-repetition ambiguity is resolved by the full-length overlap.
    pad = int(3 * SR)
    a = max(0, int(al.start * SR) - pad)
    b = min(len(mix), int(al.start * SR) + len(x) + pad)
    seg = mix[a:b].astype(np.float64)
    if len(seg) < SR:
        return al, None
    lags, r = ncc(seg, x.astype(np.float64), min_overlap=int(0.6 * min(len(seg), len(x))))
    lags = lags + a
    near = np.abs(lags / SR - al.start) <= 2.0
    r2 = np.where(near, r, -np.inf)
    k = int(np.argmax(r2))
    if np.isfinite(r2[k]):
        al = Alignment(start=float(lags[k] / SR), speed=al.speed, score=al.score, confident=al.confident and r2[k] > 0.2)
        return al, float(r2[k])
    return al, None


def refine_waveform(mix: np.ndarray, src: np.ndarray, coarse: Alignment, window_s: float = 0.25) -> tuple[Alignment, float]:
    """Sample-exact refinement for pitch-coupled time scaling (none/resample): resample the
    source by the coarse speed, cross-correlate waveforms within ±window of the coarse lag.
    Returns the refined alignment and the peak-to-sidelobe ratio (> 1.0 = unambiguous)."""
    if abs(coarse.speed - 1) > 1e-6:
        n_out = int(round(len(src) / coarse.speed))
        x = np.interp(np.arange(n_out) * coarse.speed, np.arange(len(src)), src).astype(np.float32)
    else:
        x = src
    c = correlate(mix, x, mode="full", method="fft")
    lags = np.arange(-len(x) + 1, len(mix))
    centre = coarse.start * SR
    win = np.abs(lags - centre) <= window_s * SR
    if not win.any():
        return coarse, 0.0
    cw = np.where(win, np.abs(c), 0)
    k = int(np.argmax(cw))
    side = np.abs(lags - lags[k]) > int(0.05 * SR)
    psr = float(cw[k] / (np.abs(c)[side & win].max() + 1e-12)) if (side & win).any() else float("inf")
    return Alignment(start=float(lags[k] / SR), speed=coarse.speed, score=coarse.score, confident=coarse.confident), psr


def warp_mag(X: np.ndarray, n_frames: int, start: float, speed: float) -> np.ndarray:
    fps = SR / HOP
    t = np.arange(n_frames) / fps
    src_f = speed * (t - start) * fps
    out = np.zeros((X.shape[0], n_frames), dtype=np.float32)
    ok = (src_f >= 0) & (src_f <= X.shape[1] - 1)
    i0 = np.floor(src_f[ok]).astype(int)
    fr = (src_f[ok] - i0)[None, :]
    i1 = np.minimum(i0 + 1, X.shape[1] - 1)
    out[:, ok] = X[:, i0] * (1 - fr) + X[:, i1] * fr
    return out


def estimate_gains(M: np.ndarray, Ys: list[np.ndarray], smooth: int = 9) -> np.ndarray:
    K, T = len(Ys), M.shape[1]
    G = np.zeros((K, T), dtype=np.float32)
    for t in range(T):
        A = np.stack([Y[:, t] for Y in Ys], axis=1)
        if not A.any():
            continue
        G[:, t] = nnls(A, M[:, t], maxiter=200)[0]
    if smooth > 1:
        G = np.stack([medfilt(g, smooth) for g in G])
    return G


def ground_truth_gain(tr, n_frames: int) -> np.ndarray:
    """UnmixDB uses linear (amplitude) crossfades between start/fade/stop labels."""
    fps = SR / HOP
    t = np.arange(n_frames) / fps
    g = np.zeros(n_frames, dtype=np.float32)
    lo = tr.fadein[1] if tr.fadein else tr.start
    hi = tr.fadeout[0] if tr.fadeout else (tr.stop if tr.stop is not None else t[-1] + 1)
    g[(t >= max(lo, 0)) & (t < hi)] = 1
    if tr.fadein:
        a, b = tr.fadein
        m = (t >= a) & (t < b)
        g[m] = (t[m] - a) / max(b - a, 1e-6)
    if tr.fadeout:
        a, b = tr.fadeout
        m = (t >= a) & (t < b)
        g[m] = 1 - (t[m] - a) / max(b - a, 1e-6)
    if tr.stop is not None:
        g[t >= tr.stop] = 0
    return g


def detect_fade(g: np.ndarray, rising: bool) -> tuple[float, float] | None:
    fps = SR / HOP
    gn = g / (np.percentile(g[g > 0], 95) + 1e-9) if (g > 0).any() else g
    lo_hits = np.nonzero(gn > 0.1)[0]
    hi_hits = np.nonzero(gn > 0.9)[0]
    if not len(lo_hits) or not len(hi_hits):
        return None
    if rising:
        a = lo_hits[0]
        b = hi_hits[hi_hits >= a][0] if (hi_hits >= a).any() else None
        return (a / fps, b / fps) if b is not None else None
    b = lo_hits[-1]
    a = hi_hits[hi_hits <= b][-1] if (hi_hits <= b).any() else None
    return (a / fps, b / fps) if a is not None else None


def verify_mix(labels, refsong_dir: Path, speeds: np.ndarray | None = None) -> dict:
    """Full three-way check for one UnmixDB mix: decode, hash, align, reconstruct, compare."""
    from ml.datasets.unmixdb import sha256

    mix = load_mono(labels.audio)
    M = mag(mix)
    T = M.shape[1]
    menv = onset_env(M)
    if speeds is None:
        speeds = np.round(np.arange(0.90, 1.1001, 0.005), 4) if labels.timescale != "none" else np.array([1.0])
    res = {"mix": labels.audio.name, "mix_sha256": sha256(labels.audio), "timescale": labels.timescale, "effect": labels.effect, "tracks": []}
    Ys, gts = [], []
    prev: tuple[float, float] | None = None  # (start, duration in mix time) of the previous track
    for no in sorted(labels.tracks):
        tr = labels.tracks[no]
        src_path = refsong_dir / tr.file
        x = load_mono(src_path)
        X = mag(x)
        # Tracklist-order prior (real DJ mixes come with a tracklist): track k starts inside the
        # previous track's span. Uses only the ORDER, never the labelled times.
        window = (prev[0] + 0.2 * prev[1], prev[0] + prev[1]) if prev else None
        al, psr = align_full(mix, x, labels.timescale, menv, onset_env(X), window)
        prev = (al.start, len(x) / SR / al.speed)
        Ys.append(warp_mag(X, T, al.start, al.speed))
        gts.append(ground_truth_gain(tr, T))
        res["tracks"].append({"track_no": no, "file": tr.file, "sha256": sha256(src_path), "label_start": tr.start, "label_speed": tr.speed, "est_start": al.start, "est_speed": al.speed, "start_err_ms": abs(al.start - tr.start) * 1000, "start_err_codec_corrected_ms": abs(al.start - tr.start - MP3_ENCODER_DELAY_S) * 1000, "waveform_ncc": psr, "speed_err": abs(al.speed - tr.speed), "align_score": al.score, "align_confident": al.confident})
    G = estimate_gains(M, Ys)
    Mhat = sum(G[k][None, :] * Ys[k] for k in range(len(Ys)))
    sc = float(np.linalg.norm(M - Mhat) / (np.linalg.norm(M) + 1e-12))
    eps = 1e-6
    lsd = float(np.mean(np.sqrt(np.mean((20 * np.log10(M + eps) - 20 * np.log10(Mhat + eps)) ** 2, axis=0))))
    res["spectral_convergence"] = sc
    res["log_spectral_distance_db"] = lsd
    fps = SR / HOP
    for k, t in enumerate(res["tracks"]):
        g = G[k]
        scale = np.percentile(g[g > 0], 95) if (g > 0).any() else 1.0
        gn = np.clip(g / (scale + 1e-9), 0, 1.5)
        gt = gts[k]
        tr = labels.tracks[t["track_no"]]
        fade_mask = np.zeros(T, bool)
        for fr in (tr.fadein, tr.fadeout):
            if fr:
                fade_mask |= (np.arange(T) / fps >= fr[0]) & (np.arange(T) / fps < fr[1])
        t["gain_mae_fades"] = float(np.mean(np.abs(gn[fade_mask] - gt[fade_mask]))) if fade_mask.any() else None
        t["gain_corr"] = float(np.corrcoef(gn, gt)[0, 1]) if gt.std() > 0 and gn.std() > 0 else None
        if tr.fadein:
            d = detect_fade(g, rising=True)
            t["fadein_start_err_s"] = abs(d[0] - tr.fadein[0]) if d else None
        if tr.fadeout:
            d = detect_fade(g, rising=False)
            t["fadeout_end_err_s"] = abs(d[1] - tr.fadeout[1]) if d else None
    if labels.timescale in ("none", "resample"):
        # time-domain re-render with estimated gains (interpolated to samples)
        y = np.zeros_like(mix)
        tt = np.arange(len(mix)) / SR
        for k, t in enumerate(res["tracks"]):
            x = load_mono(refsong_dir / t["file"])
            src_t = t["est_speed"] * (tt - t["est_start"])
            ok = (src_t >= 0) & (src_t < (len(x) - 1) / SR)
            xs = np.zeros_like(mix)
            xs[ok] = np.interp(src_t[ok] * SR, np.arange(len(x)), x)
            gs = np.interp(tt, np.arange(T) / fps + (N_FFT / 2) / SR, G[k])
            y += gs * xs
        err = mix - y
        res["time_domain_snr_db"] = float(10 * np.log10(np.sum(mix**2) / (np.sum(err**2) + 1e-12)))
    for t in res["tracks"]:
        t["align_confident"] = bool(t["waveform_ncc"] > 0.2) if t["waveform_ncc"] is not None else bool(t["align_score"] >= 0.3)
    res["alignment_validated"] = all(t["align_confident"] for t in res["tracks"]) and sc < 0.3
    return res
