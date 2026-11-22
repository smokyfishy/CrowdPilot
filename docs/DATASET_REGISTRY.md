# Dataset registry

Source of truth: `ml/datasets/registry.py`. Live snapshot: `reports/dataset_inventory.json`.

| Source | Kind | Audio in the official source | Licence (verified) | Fetched | Quality tier |
|---|---|---|---|---|---|
| UnmixDB v1 | synthetic reference mixes | mixes + 40 s excerpts | CC BY-NC-ND 4.0 (record) / 3.0 (tracks) | 4/6 archives (2 resuming) | synthetic gold |
| Mixotic sets (6) | human DJ performances | full mixes (mirror) | CC BY-NC-ND 2.0/3.0 (label info.txt) | 6 mixes | human, tracklist-only labels |
| Netlabel masters | source recordings | full tracks | CC BY-NC-ND 2.0 DE / 2.5 | 3 | exact originals |
| djmix/transitions | human DJ metadata | none (64,748 rows) | not stated | no | weak pseudo-labels |
| DJ Mix Dataset (GitHub) | code + metadata | none | not stated (API: null) | no | metadata |
| EDM-CUE | expert cue annotations | none (4,811 tracks) | MIT | annotations | expert labels |
| Raveform | phrase annotations | unknown | no machine-readable licence | no | expert labels |
| CUE-DETR | model | — | MIT (repo) | no | model |
| Beat This! | model | — | MIT (repo) | no | model |
| dj-mix-evaluation-dataset | unknown | unknown | not stated | no | unknown |

Labels are separated by origin: `synthetic_ground_truth` · `human_performance` (tracklist) · `inferred_pseudo_label` (inverse estimates) · `human_controller_gold` (consented capture; none yet).
