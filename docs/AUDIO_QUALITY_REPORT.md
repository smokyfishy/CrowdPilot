# Live mixing quality: root-cause investigation and fixes (2026-11-22)

## Method

- **Corpus:** 30 real house/techno tracks from Jamendo. Licences permit adaptations (CC BY-NC-SA and similar, no ND). The artist enabled downloads, and provenance plus rights records are in the private store. That gives 29 tempo-adjacent pairs.
- **Reference beats:** the official Beat This! (CPJKU, MIT). `final0` is the reference; `small0` is the deployment candidate. Small vs final agreement: beat F1 0.95, downbeat F1 0.82.
- **Harness:** `evaluation/dj.eval.ts` runs the **same TypeScript** the browser uses (analyzer → planner → renderer) and writes rendered WAVs plus per-pair metrics to `C:\crowdpilot-data\eval\<tag>\`.
- **Controls:** `evaluation/selfmix.eval.ts` (a track mixed into itself must align at about 0 ms; 4 of 6 tracks did, and the other two exposed grid drift) and `evaluation/beatnet.eval.ts` (TypeScript vs Python model).

## Root causes (with evidence)

| # | Audible defect | Evidence (version A = deployed) | Layer | Responsible code | Fix |
|---|---|---|---|---|---|
| 1 | Hard cuts almost every time | 26/29 pairs were cuts; only 14/30 tracks were beat-matchable | Planning | `beatmatchable()` gate (bpmConf ≥ 0.35) plus confidence/downbeat penalties made cuts the cheapest option | Gate on calibrated tempo confidence (0.30); downbeat uncertainty became a graded penalty and a risk, never a veto; cuts and un-matched fades cost more when a blend is feasible |
| 2 | Wrong-tempo tracks (unmixable) | 7/30 tracks at 66–100 BPM vs 125–158 reference | Analysis | Autocorrelation tempo prior picked half-time and 2/3-time peaks | **In-browser Beat This!** (tempo error median 0.006–0.8%; 27/30 octave-correct) |
| 3 | Bar phase wrong (blends start mid-phrase) | Downbeat F1 0.45, confidence 0.11 | Analysis | Bar-change heuristic (`estimateDownbeat`) | Network downbeats: F1 **0.78**, confidence 0.75 |
| 4 | Kicks flam during blends | Deck kick offset 30–60 ms | Analysis + planning | One global grid applied to a whole track; tiny period errors and drift accumulate over 16 bars | Robust grid fit (cumulative beat indexing, steady-beat filter, circular phase) plus **local refinement at commit** (snap cues to network beats; local tempo ratio over the overlap) |
| 5 | Bass "drop-outs" or double bass in swaps | Swap was a −40 dB → 0 step in ½ beat, ramped in dB, so both basslines dipped together | Rendering | `step()` EQ curves; shelving "kills" | **LR4 3-band isolator** (200 Hz / 2.5 kHz, bands sum flat); bass handoffs crossfade in **linear amplitude** over 2–4 beats |
| 6 | Mid-blend loudness bump | Equal-power curves add +3 dB on beat-aligned (coherent) material | Rendering | `eqPower` fades | Amplitude-complementary S-curves and ~1 dB headroom while both decks are full |
| 7 | Cue into near-silence | One pair had a −32 dB dropout | Planning | No energy check at cues | Per-phrase energy in the summary; low-energy cue penalty and risk |
| 8 | Production model silently not loading | ONNX Runtime loader `.mjs` served as `application/octet-stream` | Deploy | Static asset MIME type | Loader served as `.js`; production test asserts `gridSource = 'beatnet'` |

## Measured results (same 30 tracks / 29 pairs)

| Version | Hard cuts | Beat-matched | Beat F1 | Downbeat F1 | Octave-correct tempo | Beat-matchable | Clipping |
|---|---|---|---|---|---|---|---|
| A: deployed baseline | 26 | 6.9% | 0.91 | 0.45 | 23/30 | 14/30 | 0 |
| B: new planner + DSP, old analyzer | 15 | 31.0% | 0.91 | 0.45 | 23/30 | 14/30 | 0 |
| D/F: + in-browser Beat This! + robust grid (+ local refinement) | **11** | **51.7%** | **0.94** | **0.78** | **27/30** | **21/30** | 0 |

The remaining cuts and quick fades are pairs more than 6% apart in tempo, which is outside the host's ±6% limit. A cut is the honest choice there, made on a downbeat with click-free 60 ms / 30 ms ramps.

**Alignment caveat:** the deck-alignment metric changed during the investigation (broadband, then kick-band, then windowed kick-band), so A/B/D/F alignment numbers are **not comparable**. Few windows qualify, because short blends into kickless intros leave little to measure. On the two pairs with 11–17 usable windows, local refinement reduced offset from 26 → 10 ms and kept 0 → 1.5 ms.

**Tried and reverted:** a tempo-hypothesis search in the DSP analyzer. It reduced cuts but *lowered* octave correctness (23 → 21) and downbeat F1 (0.45 → 0.12).

## Browser model (Beat This! small0, MIT)

- Exported to ONNX (opset 17, variable length). ONNX vs PyTorch max logit difference 3×10⁻⁵ at T = 1500, 731 and 200.
- TypeScript front-end and postprocessing vs Python: beat F1 median **0.99** (min 0.90), downbeat F1 median **0.94** (min 0.83) on 30 tracks.
- Runtime: ONNX Runtime Web in the analysis worker, WebGPU when available, WASM otherwise. Headless single-thread WASM took 8.5–12.9 s per 1.5–3-minute track. It runs while the previous track plays and never blocks audio. If the model fails, the DSP grid is used with a visible flag.
- Assets: model 10.5 MB and runtime 21.7 MB, served from the app's origin and loaded only by the host.

## Listening evaluation (needs the owner)

29 blind A/B pairs (deployed algorithm vs current) are at `C:\crowdpilot-data\listening\index.html`. They're private, because the licences don't allow redistribution. Labels are randomized; the key is in `key.json`.

No listening judgement has been made by anyone yet. Results will be ingested from the exported JSON. Statistical claims need more than one rater.

## Known remaining issues

- One pair still dips to −34 dB inside a transition window, likely a quiet breakdown at the cue. It needs the structure model.
- Long blends and bass swaps are chosen rarely (2/29); most blends are 4-bar beat-matched fades. Tuning waits for the listening results.
- Pitch-preserving stretch is still the project's WSOLA. Signalsmith Stretch (MIT) has not been evaluated yet.
- No set-level (multi-track) progression beyond the existing constrained beam planner.
