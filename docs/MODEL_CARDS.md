# Model cards

| Model | Implemented | Trained checkpoint | Used in the live app | Evaluation |
|---|---|---|---|---|
| DSP analyzer `cp-dsp-1.0.0` (deterministic) | yes | n/a (no learned weights) | **yes** | Synthetic ground truth: tempo within 0.05 BPM, beat phase within 15 ms, downbeat exact, key within 1 Camelot step, breakdown found (3 synthetic tracks). Real audio: 2 Audius tracks measured 128.00 / 124.00 BPM (Audius-declared 128 / 124; a weak reference, n = 2). No held-out real benchmark yet. |
| MixGraph deterministic planner | yes | n/a | **yes** | Constraint tests and exact agreement with brute force on toy queues. No listening study yet. |
| WSOLA time-stretch | yes | n/a | **yes** | Pitch held within 3 Hz at +5%; beats land within 12 ms. |
| Inverse fader estimator (NNLS, magnitude STFT) | yes (`ml/dsp/unmix.py`) | n/a | research only | UnmixDB benchmark: see `reports/unmixdb_three_way_benchmark.json`. |
| CuePointNet | **no** | **none** | no | — |
| Transition ranker | **no** | **none** | no | — |
| MixGraph-GAT | **no** | **none** | no | — |
| TransitionNet | **no** | **none** | no | — |
| DJCritic | **no** | **none** | no | — |

Do not describe CrowdPilot as "trained on professional DJ performances" until a verified human triplet has passed rights, QC, alignment and split gates, and a model trained on it has been evaluated on held-out DJs and tracks. None has yet.
