# Evaluation protocol

## Implemented and run

| Area | Benchmark | Metric | Where |
|---|---|---|---|
| Tempo, beat phase, downbeat, key, structure | synthetic tracks with known truth | BPM error, phase error (ms), downbeat index, Camelot distance, breakdown bar | `src/dsp/dsp.test.ts` |
| Loudness | BS.1770 reference (997 Hz, 0 dBFS, one channel = −3.01 LUFS) | LUFS error | `src/dsp/dsp.test.ts` |
| Time-stretch | sine and click trains | pitch error (Hz), beat placement (ms) | `src/dsp/stretch.test.ts` |
| Planner constraints | toy queues | exact equality with brute force; lock/pin/commit/timed-slot invariants | `src/dj/planner.test.ts` |
| Rendered transitions | synthetic A → B | clipped samples, dropouts (0.5 s RMS), beat alignment of the incoming deck (median error) | `src/dj/render.test.ts` |
| Live engine on real audio | 2 real Audius tracks, headless Chromium | master RMS present, handoff and completion on the audio clock, 0 clip events (planner cut + forced WSOLA bass swap) | `tests/e2e/dj-lab.spec.ts` (local and production) |
| Multi-user flow | host + guest, real Audius audio | analysis synced to the guest, autopilot proposal, commit, handoff seen by the guest | `tests/e2e/dj-room.spec.ts` |
| Three-way reconstruction | UnmixDB (synthetic) | start error (raw and MP3-codec-corrected), speed error, gain correlation/MAE vs ground-truth faders, spectral convergence, LSD, time-domain SNR | `ml/dsp/unmix.py`, `reports/unmixdb_three_way_benchmark.json` |
| Negative cases | wrong recording, different edit, missing original, corrupted file, revoked/expired rights, false approval | gate decisions | `ml/tests/*` |

## Required before any claim of real-world accuracy (not done)

- Tempo and beat F1 (±70 ms) on a labelled real-music set with lawful audio. The Audius-declared BPM check in `/lab` is a weak reference and is reported only as such.
- A blinded A/B listening study of rendered transitions against baselines (FIFO; BPM/key + fixed crossfade; DSP templates). Win rate with confidence intervals and rater agreement.
- Unseen-DJ and unseen-track splits for any learned model.
