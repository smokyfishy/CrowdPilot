# Model cards

| Model | Implemented | Trained checkpoint | Used in the live app | Evaluation |
|---|---|---|---|---|
| **Beat This! small0** (CPJKU, MIT, pretrained, not fine-tuned) | yes (ONNX Runtime Web) | official checkpoint exported to ONNX (sha256 a7b9d494…) | **yes** (grid source; DSP fallback) | ONNX≈PyTorch (3e-5); TS vs Python beat F1 0.99 / downbeat 0.94 on 30 real tracks; vs final0 reference 0.96 / 0.83. See docs/AUDIO_QUALITY_REPORT.md |
| DSP analyzer `cp-dsp-1.0.0` (deterministic) | yes | n/a (no learned weights) | fallback only | Synthetic ground truth: tempo within 0.05 BPM, beat phase within 15 ms, downbeat exact, key within 1 Camelot step, breakdown found (3 synthetic tracks). Real audio: 2 Audius tracks measured 128.00 / 124.00 BPM (Audius-declared 128 / 124; a weak reference, n = 2). No held-out real benchmark yet. |
| MixGraph deterministic planner | yes | n/a | **yes** | Constraint tests and exact agreement with brute force on toy queues. No listening study yet. |
| WSOLA time-stretch | yes | n/a | **yes** | Pitch held within 3 Hz at +5%; beats land within 12 ms. |
| Inverse fader estimator (NNLS, magnitude STFT) | yes (`ml/dsp/unmix.py`) | n/a | research only | UnmixDB benchmark: see `reports/unmixdb_three_way_benchmark.json`. |
| AlignEmbed v1 (contrastive alignment embedding, 245k params, UnmixDB train sets) | yes | **trained** on Azure D64as_v5 (4,000 steps, ~$12.60 total VM cost); checkpoint private (C:\crowdpilot-data\modelslign_embed, sha256 in reports/azure_train_align_embed_s0.json) | no (offline reconstruction research only) | Held-out sets 275/123 (60 mixes, unseen tracks): unchanged-tempo placement within 50 ms **96.2%** vs 69.2% multi-band / 66.7% single envelope; mix validation 76.9% vs 57.7%. Time-scaled variants identical to multi-band because the fine-alignment stage overrides the learned coarse estimate (pipeline issue, not a model result). Synthetic-reference domain only. |
| Downbeat LR / LightGBM (ircambeat weak labels) | yes | local only | no (superseded by Beat This!) | held-out phase agreement LR 43.2% vs heuristic 42.1%; LightGBM 50.5% (n = 95) |
| CuePointNet | **no** | **none** | no | — |
| MixGraph quality ranker | yes | exported LightGBM | **yes** (experimental mode): learned term in every edge cost of the global set planner (src/mixgen/setplan.ts); legacy planner ordering/ranking | Synthetic/render severity objective; see the mix generator ablation |
| MixGraph human cue prior | yes | exported LightGBM | loaded with weight zero | Hurt held-out severity |
| MixGraph-GAT | no shipped runtime | none shipped | no | Research only |
| TransitionNet v1 | yes | exported MLP | **no** — the global planner does not execute its short-blend trajectories (manifest records it as not used); legacy planner opt-in only | Increased bass overlap in the existing ablation |
| TransitionNet v2 (long-form strategy + 12 stage parameters + cue shift) | yes (`src/ml/transitionnet-v2.ts`, `ml/transitionnet/train_v2.py`) | trained locally on CPU (3,678 synthetic known-control renders, track-level splits); checkpoint private (C:\crowdpilot-data\ml\models	ransitionnet_v2) | **no — not promoted, not shipped** | Held-out test windows: 22 % agreement with the render-verified best strategy vs 43 % for a constant rule; parameter and cue heads show no gain. See docs/PRO_DJ_REPORT.md |
| DJCritic quality and artifact | yes | two exported LightGBM models | **yes** (experimental mode): capped term (≤ 0.6) in the closed-loop preview score; legacy same-slot selection | Rendered-preview objective; human preference remains unverified |
| Long-form stage solver, global set planner, closed-loop audio metrics | yes (`src/mixgen/longform.ts`, `setplan.ts`, `audio-quality.ts`, `closedloop.ts`) | n/a (rules and explicit signal measurements — not learned) | **yes** (default planner) | Held-out controlled comparison in docs/PRO_DJ_REPORT.md |

The five exported model artifacts match the SHA-256 values in the shipped registry. Their registry entries are all unpromoted. Models for learned section labeling and advanced stem, edit and performance controls have no shipped checkpoints. The planner uses the existing measured features and rule templates for those decisions.

Do not describe CrowdPilot as "trained on professional DJ performances" until a verified human triplet has passed rights, QC, alignment and split gates, and a model trained on it has been evaluated on held-out DJs and tracks. None has yet.
