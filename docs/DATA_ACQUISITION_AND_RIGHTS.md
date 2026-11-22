# Data acquisition and rights: commands

Run from `C:\dev\CrowdPilot` with `ml\.venv\Scripts\python`. Data goes to `C:\crowdpilot-data`.

```text
python -m ml.datasets.acquire inventory                      # snapshot official metadata (Zenodo, HF, GitHub, Internet Archive)
python -m ml.datasets.acquire verify-source unmixdb|mixotic  # licence evidence → per-use rights records
python -m ml.datasets.acquire fetch-approved unmixdb|mixotic [--only ...] [--max-gb N]
python -m ml.datasets.human_triplet register|fetch|align     # human triplets (Mixotic + netlabel masters)
python -m ml.datasets.triplets register unmixdb              # synthetic triplets
python -m ml.datasets.triplets align [--limit N]             # three-way decode/align/reconstruct benchmark
python -m ml.datasets.triplets audit                         # statuses + blockers → reports/
python -m ml.datasets.triplets export-train --verified-only --domain professional_dj_performance
python -m ml.reports                                         # all evidence reports
python -m ml.capture.receiver listen|finalize ...            # Mixxx telemetry sessions
python -m pytest ml/tests                                    # rights gating, three-way audio, wrong version, clock sync
```

Download safety:

- Fetches only after `waveform_analyze` is approved with evidence.
- Resumable with HTTP Range and verified against provider md5.
- Per-file size limit and a disk-space precheck.
- ZIPs are extracted into a fresh directory, refusing absolute paths, `..`, drive letters and symlinks.

Policy details: `docs/DATA_RIGHTS_AND_PROVENANCE.md`.
