# Training plan (no models have been trained yet)

## Why nothing has been trained

| Data | Audio present | Rights for `train_model` | Labels | Status |
|---|---|---|---|---|
| UnmixDB v1 (synthetic reference mixes) | yes (4 of 6 sets complete; 2 resuming) | **rights_review** (CC BY-NC-ND 4.0 dataset / CC BY-NC-ND 3.0 tracks) | exact synthetic ground truth | blocked on owner decision |
| Mixotic human DJ mixes (6) | yes (880 MB, md5-verified) | **rights_review** (CC BY-NC-ND 2.0/3.0 per the label's info.txt) | ordered tracklist only; transitions must be aligned | blocked on owner decision + alignment |
| Netlabel masters (3) | yes | **rights_review** (CC BY-NC-ND 2.0 DE/2.5) | — | blocked on owner decision |
| Audius streams (live app) | session only | **prohibited** by the Audius API Terms | — | never used for training |
| DJ Mix Dataset / djmix transitions (HF) | no (links only) | licence not stated on the card (inventory: `null`) | estimated (weak) | metadata only |
| EDM-CUE | annotations only (no audio in repo) | MIT (annotations) | expert cues | needs lawful audio for the same tracks |
| Real controller telemetry | none exists publicly (searched) | — | — | needs a consenting human session |

Training on NC/ND material without the owner's explicit decision would break the project's own rules. The live app therefore runs the deterministic baseline.

## Planned runs (in order) once the inputs exist

| # | Model | Data | Baseline to beat | Compute | Rough cost |
|---|---|---|---|---|---|
| 1 | CuePointNet-lite (gradient-boosted on bar features) | UnmixDB cue regions (synthetic) → Mixotic human cues (aligned) | phrase heuristic in `src/dsp/structure.ts` | local CPU, < 30 min | $0 |
| 2 | Transition ranker (LightGBM/MLP) | aligned human transitions (positives) vs same-pair alternative edges (unlabelled, **not** negatives) | MixGraph deterministic cost | local CPU, < 1 h | $0 |
| 3 | MixGraph-GAT (PyG GATv2, `edge_dim`) | the graph built from 2 | ranker from 2 (ship only if it wins on unseen DJs and tracks) | Azure CPU or T4 spot, < 2 h | small; check current pricing before each run |
| 4 | TransitionNet controls (temporal CNN) | consented Mixxx sessions (gold) + vetted inverse estimates | templates in `src/dj/transitions.ts` | Azure T4 spot, < 2 h | small; check current pricing before each run |
| 5 | DJCritic | blinded A/B judgements on rendered clips (`src/dj/render.ts` exports) | — | local CPU | $0 |

Every run must record seed, git SHA, data manifest hash, hardware and cost in `docs/MODEL_CARDS.md`.

Splits:

- by DJ/mix, and by recording/work, using the dedup manifest;
- synthetic and human domains are reported separately.

Azure: the CLI is logged into a subscription in tenant `patelvihaan2007gmail.onmicrosoft.com`. The owner must confirm it is the intended ~$1,000-credit subscription before any resource is created.

- Use spot VMs with auto-shutdown and delete them after the run.
- Confirm with the owner before any job estimated above about $100.
