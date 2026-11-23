# Professional DJ corpus status (2026-11-22)

All values are counted from `reports/acquisition_outcomes.json`, `reports/triplet_readiness.csv` and `reports/human_triplet_alignment.json`. Regenerate with `python -m ml.reports`.

## Human-performed DJ material

| Counter | Value |
|---|---|
| Mix metadata discovered | 64,748 transition rows (djmix, licence not stated, not fetched) · 86 playlist entries in 6 Mixotic sets (official info.txt) |
| Human reference mixes downloaded and decoded | **6** (Mixotic 044/123/222/230/275/281, 880 MB, md5 matches the Internet Archive) |
| Licence evidence per mix | 6/6: the label's own info.txt states CC BY-NC-ND 2.0 (044) or 3.0 (others) |
| Full source masters downloaded | **3** (Pentagonik 003-04, 005-03, 006-03), md5-verified |
| Source masters refused (no licence evidence) | 1 (Pentagonik 007-01 "Dance Away") |
| Complete mix + A + B audio groups | **1** (Mixotic 044, tracks 12 → 13) |
| Groups with rights approved for waveform training | **0** (train_model = rights_review for every CC BY-NC-ND asset) |
| Groups alignment-validated | **0**. Incoming track located with confidence (63:18, envelope NCC 0.74, waveform NCC 0.20); outgoing track not (0.24 / 0.045) |
| **True professional human trainable triplets** | **0** |

## Synthetic reference (UnmixDB). Never counted above.

| Counter | Value |
|---|---|
| Archives | 4/6 complete, md5-verified; set123 and set044 resuming |
| Triplets registered (mix + A + B) | 3,480 (2,976 with mix audio present) |
| Three-way verified so far | see `reports/unmixdb_three_way_benchmark.json` (benchmark still running; *n* is stated in the file) |
| Trainable | 0 (train_model = rights_review) |

## Controller telemetry

| Counter | Value |
|---|---|
| Public human telemetry datasets found | 0 (queries in `reports/telemetry_source_audit.csv`) |
| Consented sessions recorded | **0**. Status `BLOCKED_HUMAN_SESSION`; the capture kit is implemented and tested |

## Models

None trained. See `docs/MODEL_CARDS.md`.

## Next user inputs required

1. **Rights decision on training:** may CrowdPilot train private models on CC BY-NC-ND material (UnmixDB, the 6 Mixotic mixes, the netlabel masters), with weights never distributed? A yes/no per dataset is enough. This single answer unlocks training on 3,480 synthetic triplets.
2. **Azure:** confirm which subscription holds the ~$1,000 credits. The CLI is logged into tenant `patelvihaan2007gmail.onmicrosoft.com`.
3. **Outreach:** approve sending template 1 to Pentagonik (pntg007), and give the name and contact to sign with.
4. **A consented human session:** you, or a DJ you know, record 20–30 minutes in Mixxx following `docs/DJ_SESSION_CAPTURE_GUIDE.md`, using tracks with recorded licences (for example the CC netlabel tracks already acquired).
5. **Rights review of live mixing** of OML-only Audius uploads and Jamendo ND tracks. This is currently allowed behind a host toggle labelled "pending rights review". Keep it on, or turn it off by default?
