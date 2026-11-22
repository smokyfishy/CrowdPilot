"""Generate the evidence reports from real records (logs, rights store, files on disk).

  python -m ml.reports
"""
from __future__ import annotations

import csv
import json
import shutil
from pathlib import Path

import pandas as pd

from ml.datasets.acquire import LOG, REPO, ROOT, rights_store
from ml.datasets.rights import Use

R = REPO / "reports"


def _log() -> list[dict]:
    return [json.loads(l) for l in LOG.read_text(encoding="utf-8").splitlines()] if LOG.exists() else []


def _bytes(p: Path) -> int:
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) if p.exists() else 0


def main() -> None:
    R.mkdir(exist_ok=True)
    log = _log()
    store = rights_store()
    dl = [e for e in log if e["event"] == "download" and "bytes" in e]
    # ── audio coverage ──
    mixes = sorted((ROOT / "raw" / "mixotic" / "mixes").glob("*.mp3"))
    masters = sorted((ROOT / "raw" / "netlabel").rglob("*.mp3"))
    um = ROOT / "raw" / "unmixdb" / "extracted"
    coverage = {
        "unmixdb_synthetic": {"archives_complete": len(list((ROOT / "raw" / "unmixdb" / "archives").glob("*.zip"))), "archives_total": 6, "mix_audio_files": len(list(um.rglob("mixes/*.mp3"))), "mix_label_files": len(list(um.rglob("mixes/*.labels.txt"))), "source_excerpt_files": len(list(um.rglob("refsongs/*.mp3"))), "domain": "synthetic_reference"},
        "human_dj_mixes_mixotic": {"files": [m.name for m in mixes], "count": len(mixes), "bytes": sum(m.stat().st_size for m in mixes), "domain": "professional_dj_performance"},
        "source_masters_netlabel": {"files": [m.name for m in masters], "count": len(masters)},
        "edm_cue_annotations": {"present": (ROOT / "raw" / "edm-cue" / "data").exists(), "audio": "none (annotations only)"},
        "disk_used_bytes": _bytes(ROOT),
        "disk_free_bytes": shutil.disk_usage(ROOT).free,
    }
    (R / "audio_coverage.json").write_text(json.dumps(coverage, indent=1), encoding="utf-8")

    # ── human triplet status ──
    ha = json.loads((ROOT / "derived" / "human_alignment.json").read_text(encoding="utf-8")) if (ROOT / "derived" / "human_alignment.json").exists() else {}
    human_rows = []
    for tid, r in ha.items():
        validated = bool(r.get("alignment_validated"))
        status = "BLOCKED" if r.get("status") == "blocked" else ("RIGHTS_REVIEW" if validated else "THREE_WAY_MATCH_UNVERIFIED")
        human_rows.append({"triplet_id": tid, "mix": "Mixotic 044 (Cotumo)", "status": status, "alignment_validated": validated, "audio_complete": r.get("status") != "blocked", "blocker": r.get("reason") or ("outgoing track alignment below confidence (waveform NCC < 0.2, envelope < 0.3)" if not validated else "train_model rights_review (CC BY-NC-ND)"), "label_origin": "human_performance (inferred controls = pseudo-labels)"})
    pd.DataFrame(human_rows).to_parquet(R / "verified_triplets.parquet")

    # ── acquisition outcomes ──
    sb = ROOT / "derived" / "triplets.parquet"
    synth = pd.read_parquet(sb) if sb.exists() else pd.DataFrame(columns=["domain"])
    rc = json.loads((R / "rights_compliance.json").read_text(encoding="utf-8")) if (R / "rights_compliance.json").exists() else {}
    outcomes = {
        "bytes_downloaded": sum(e["bytes"] for e in dl),
        "files_downloaded": len(dl),
        "downloads_blocked_by_rights": sum(1 for e in log if e["event"] == "fetch-skip"),
        "counters": {
            "metadata_candidates": {"djmix_transitions_rows": 64748, "edm_cue_tracks": 4811, "mixotic_playlist_entries_in_6_sets": 86},
            "audio_mixes_present_human": len(mixes),
            "source_masters_present_full": len(masters),
            "source_excerpts_present_unmixdb": coverage["unmixdb_synthetic"]["source_excerpt_files"],
            "triplet_complete_human": sum(1 for h in human_rows if h["audio_complete"]),
            "rights_reviewed_for_training": 0,
            "alignment_verified_human": sum(1 for h in human_rows if h["alignment_validated"]),
            "human_dj_triplets_trainable": 0,
            "synthetic_triplets_registered": int((synth.domain == "synthetic_reference").sum()) if len(synth) else 0,
            "genuine_telemetry_sessions": 0,
            "synthetic_control_samples": 0,
        },
        "rights_summary": rc.get("summary"),
        "assets_with_rights_records": len(store.assets),
        "assets_approved_waveform_analyze": sum(1 for a in store.assets.values() if a.allows(Use.WAVEFORM_ANALYZE)),
        "assets_approved_train_model": sum(1 for a in store.assets.values() if a.allows(Use.TRAIN_MODEL)),
    }
    (R / "acquisition_outcomes.json").write_text(json.dumps(outcomes, indent=1), encoding="utf-8")

    # ── professional audio sourcing (per candidate) ──
    rows = [
        ["candidate", "kind", "official_source", "audio_available", "licence_evidence", "downloaded", "rights_decision_training", "utility", "blocker_or_next_action"],
        ["UnmixDB v1 (6 sets)", "synthetic_reference", "https://zenodo.org/records/1422385", "mixes + 40 s source excerpts", "Zenodo record CC BY-NC-ND 4.0; tracks CC BY-NC-ND 3.0", f"{coverage['unmixdb_synthetic']['archives_complete']}/6 archives", "rights_review", "algorithm validation (exact ground truth)", "owner decision on train_model; finish set123/044"],
        *[["Mixotic " + m.name.split("_")[1], "professional_dj_performance", "mixotic.net info.txt (Wayback) + archive.org mirror", "full DJ mix", "label info.txt: CC BY-NC-ND 2.0/3.0", "yes (md5 ok)", "rights_review", "human transitions (tracklist order)", "source masters for each transition; owner decision on train_model"] for m in mixes],
        ["pntg005-03 On The Run", "source_master", "archive.org/details/pntg005", "full track", "UnmixDB attribution CC BY-NC-ND 2.0 DE (community upload, weaker provenance)", "yes", "rights_review", "Mixotic 044 track 12", "alignment unverified in the mix"],
        ["pntg006-03 Das Haus im Wald", "source_master", "archive.org/details/pntg006", "full track", "label upload CC BY-NC-ND 2.5 + attribution", "yes", "rights_review", "Mixotic 044 track 13", "aligned (incoming)"],
        ["pntg003-04 Litchy Licker", "source_master", "archive.org/details/pntg003", "full track", "label upload 2.5 + ID3 2.0 DE + attribution", "yes", "rights_review", "Mixotic 044 track 04", "pair blocked by track 05"],
        ["pntg007-01 Dance Away", "source_master", "archive.org/details/pntg007", "full track", "NONE found (item, ID3, attribution)", "no (default deny)", "denied", "Mixotic 044 track 05", "permission request draft (template 1)"],
        ["DJ Mix Dataset / djmix transitions", "professional_dj_metadata", "https://huggingface.co/datasets/djmix/transitions", "none (64,748 metadata rows)", "licence not stated", "no", "n/a", "weak transition statistics", "maintainer contact (template 3)"],
        ["EDM-CUE", "expert_annotations", "https://huggingface.co/datasets/disco-eth/edm-cue", "none (4,811 annotated tracks)", "MIT (annotations)", "annotations only", "n/a", "cue labels if lawful audio is found", "commercial recordings: no lawful audio source yet"],
        ["Raveform", "professional_dj_metadata", "https://mir-aidj.github.io/raveform/", "unknown", "no machine-readable licence", "no", "n/a", "phrase annotations", "manual page review"],
        ["Audius (live app)", "streaming", "api.audius.co", "session streams", "API Terms prohibit ML training", "n/a", "prohibited", "live mixing only", "—"],
    ]
    with (R / "professional_audio_sourcing.csv").open("w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerows(rows)

    # ── telemetry audit ──
    tele = [
        ["source", "query_or_url", "finding", "human_performed", "controls_logged", "audio_synced", "usable_as_gold"],
        ["web search", "dataset DJ performance controller MIDI logs crossfader EQ fader movements recorded with audio research", "no dataset found; only device MIDI maps (Pioneer DDJ-SB), NIME 2018 system (9 informal users), a patent", "n/a", "n/a", "n/a", "no"],
        ["web search", "DJ dataset mixer parameters fader EQ ground truth human DJ sessions recorded Mixxx/Traktor/rekordbox ISMIR", "UnmixDB (synthetic placement only), Kim et al. DAFx 2022 (estimated fader/EQ, not logged), differentiable DJ mixer (generative)", "no", "estimated only", "n/a", "no"],
        ["DJ Mix Dataset (HF)", "https://huggingface.co/datasets/djmix/transitions", "alignment statistics per transition; no controller logs", "yes (mixes)", "none", "no", "no"],
        ["CrowdPilot Mixxx capture kit", "ml/capture/", "implemented + tested with simulated events; awaiting a consenting human session", "pending", "effective mixer state (≈125 controls)", "clock-fit QC", "pending consent"],
    ]
    with (R / "telemetry_source_audit.csv").open("w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerows(tele)
    (R / "controller_telemetry.json").write_text(json.dumps({"genuine_sessions": 0, "consent_records": 0, "logged_control_states": 0, "clock_sync_quality": None, "toolkit": "ml/capture (tests: ml/tests/test_controller_clock_sync.py)", "status": "BLOCKED_HUMAN_SESSION"}, indent=1), encoding="utf-8")
    print(json.dumps(outcomes["counters"], indent=1))


if __name__ == "__main__":
    main()
