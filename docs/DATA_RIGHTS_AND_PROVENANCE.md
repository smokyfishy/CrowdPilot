# Data rights and provenance

CrowdPilot's research is private, noncommercial and experimental. **That is not a licence.** Every asset has a separate decision per use. The default is denied. No use is inferred from another.

## Scoped uses (`ml/datasets/rights.py`)

`waveform_analyze` · `train_model` · `inverse_reconstruct` · `render_private_mix` · `retain_derived_artifacts` · `redistribute_audio` · `publish_demo` · `commercialize`

Decisions: `denied` (default) · `rights_review` (evidence exists but a human must decide) · `approved` (needs evidence references) · `revoked`.

Triplet statuses: `DISCOVERED → RIGHTS_REVIEW → APPROVED_FOR_TARGET_USE → AUDIO_PRESENT → THREE_WAY_MATCH_CONFIRMED → ALIGNMENT_VALIDATED → TRAINABLE_TRIPLET`, plus `BLOCKED` and `REVOKED`.

A triplet is `TRAINABLE_TRIPLET` only when:

- the mix and both source recordings are each approved for `waveform_analyze` **and** `train_model`;
- all three audio files are present; and
- alignment passed QC.

Revoking any asset raises an error in the gate, so derived data must be removed.

## Licence policy `licence-policy:v1` (applied automatically; the owner can override)

This is applied only to an explicit Creative Commons licence found on the official source (dataset record, the label's own upload, the label's own `info.txt`, or the file's own tag):

| Use | CC BY / BY-SA | NC variants | ND variants |
|---|---|---|---|
| waveform_analyze, inverse_reconstruct, retain_derived_artifacts | approved | approved | approved |
| render_private_mix | approved | approved | **rights_review** (an adaptation) |
| train_model | **rights_review** | **rights_review** | **rights_review** |
| redistribute_audio, publish_demo | rights_review | denied | denied |
| commercialize | denied | denied | denied |

Training is never auto-approved because model weights might later be distributed. **The owner's decision is required.** See the "Next user inputs" list in `docs/PROFESSIONAL_DJ_CORPUS_STATUS.md`.

## Live app sources

| Source | Basis | What CrowdPilot does |
|---|---|---|
| YouTube | IFrame API embed only. Policies forbid separating, modifying or caching audio, and forbid two auto-playing players. | Standard playback only. Never analyzed or mixed. |
| Audius | API Terms + Open Music License §1.2 ("reproduce, … stream, and otherwise use in whole or part"). API Terms allow session caching only and **prohibit ML training**. | Decoded in the host browser for the session only. Derived features (< 4 KB) are synced. Never used for training. Mixing of "All rights reserved" uploads is flagged *pending rights review* behind a host toggle. |
| Jamendo | API Terms §3.3: free for non-commercial use, caching only as needed. Each track has its own CC licence. | Host-only pass-through (no storage). ND tracks are flagged *pending rights review*. |

## Provenance records

- Acquisition log: `C:\crowdpilot-data\logs\acquisition.jsonl` (every inventory, verification, download, skip and extraction).
- Official metadata snapshots: `C:\crowdpilot-data\registry\snapshots\` (Zenodo/HF/GitHub/Internet Archive JSON, Wayback captures of mixotic.net `info.txt` files).
- Rights store: `C:\crowdpilot-data\registry\private\rights.json` (private). A redacted copy is kept in git at `ml/data/registry/rights_redacted.json`.
- No raw audio, private agreement or consent form is ever committed or uploaded to DeepSpace.
