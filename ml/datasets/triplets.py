"""Triplet registry CLI: mix + outgoing source + incoming source.

  python -m ml.datasets.triplets register unmixdb            # derive triplets from UnmixDB labels (synthetic_reference)
  python -m ml.datasets.triplets register human --mix M --out A --in B --rights-ref R   # a human DJ performance
  python -m ml.datasets.triplets audit                       # counts, statuses, blockers → reports/
  python -m ml.datasets.triplets align [--limit N]           # three-way decode/align/reconstruct → reports/
  python -m ml.datasets.triplets export-train --verified-only [--domain professional_dj_performance]

Synthetic (UnmixDB) and human triplets are separate domains and are NEVER counted together.
``export-train`` emits only TRAINABLE_TRIPLET rows for the requested domain.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

from .acquire import PRIVATE, REPO, ROOT, log, rights_store
from .rights import AssetRights, GateError, Status, apply_cc_policy, gate_triplet_for_waveform_training

TRIPLETS = ROOT / "derived" / "triplets.parquet"
ALIGN = ROOT / "derived" / "unmixdb_alignment.jsonl"


def _unmixdb_root() -> Path:
    return ROOT / "raw" / "unmixdb" / "extracted"


def register_unmixdb() -> pd.DataFrame:
    from .unmixdb import parse_mix_labels, set_dirs

    store = rights_store()
    rows = []
    for sdir in set_dirs(_unmixdb_root()):
        archive = f"unmixdb/{sdir.name}.zip"
        parent = store.assets.get(archive)
        for lab in sorted((sdir / "mixes").glob("*.labels.txt")):
            ml = parse_mix_labels(lab)
            nos = sorted(ml.tracks)
            for a, b in zip(nos, nos[1:]):
                ta, tb = ml.tracks[a], ml.tracks[b]
                mix_id = f"unmixdb/{sdir.name}/mixes/{ml.audio.name}"
                ids = {"mix": mix_id, "out": f"unmixdb/{sdir.name}/refsongs/{ta.file}", "in": f"unmixdb/{sdir.name}/refsongs/{tb.file}"}
                # each file inherits the archive's licence-policy decisions (same official record)
                for role, aid in ids.items():
                    if aid not in store.assets and parent:
                        child = AssetRights.from_json({**parent.to_json(), "asset_id": aid, "role": {"mix": "synthetic_reference", "out": "source_outgoing", "in": "source_incoming"}[role]})
                        child.licence = f"{parent.licence}; track files: CC BY-NC-ND 3.0 (license_link.txt)"
                        store.put(child, "inherited from archive record")
                rows.append({
                    "triplet_id": f"{mix_id}#{a}>{b}", "domain": "synthetic_reference", "set": sdir.name, "mix_id": ids["mix"], "out_id": ids["out"], "in_id": ids["in"],
                    "mix_path": str(ml.audio) if ml.audio.exists() else None, "out_path": str(sdir / "refsongs" / ta.file), "in_path": str(sdir / "refsongs" / tb.file),
                    "timescale": ml.timescale, "effect": ml.effect, "fade_out": ta.fadeout, "fade_in": tb.fadein, "label_origin": "synthetic_ground_truth",
                })
    store.save()
    store.save_redacted(REPO / "ml" / "data" / "registry" / "rights_redacted.json")
    df = pd.DataFrame(rows)
    TRIPLETS.parent.mkdir(parents=True, exist_ok=True)
    existing = pd.read_parquet(TRIPLETS) if TRIPLETS.exists() else pd.DataFrame()
    if len(existing):
        existing = existing[existing.domain != "synthetic_reference"]
    df = pd.concat([existing, df], ignore_index=True)
    df.to_parquet(TRIPLETS)
    log("register", domain="synthetic_reference", triplets=len(rows))
    return df


def register_human(args: argparse.Namespace) -> None:
    """Registers a human performance triplet as DISCOVERED. Rights for each of the three
    assets must be added by a human reviewer to the private store; nothing is assumed."""
    store = rights_store()
    for aid, role in ((args.mix, "dj_reference"), (args.out, "source_outgoing"), (args.inc, "source_incoming")):
        if aid not in store.assets:
            store.put(AssetRights(aid, role), "registered (default deny)")
    store.save()
    df = pd.read_parquet(TRIPLETS) if TRIPLETS.exists() else pd.DataFrame()
    row = {"triplet_id": f"{args.mix}#{args.out}>{args.inc}", "domain": "professional_dj_performance", "mix_id": args.mix, "out_id": args.out, "in_id": args.inc, "mix_path": args.mix_path, "out_path": args.out_path, "in_path": args.in_path, "label_origin": "human_performance", "rights_ref": args.rights_ref}
    pd.concat([df, pd.DataFrame([row])], ignore_index=True).to_parquet(TRIPLETS)
    log("register", domain="professional_dj_performance", triplet=row["triplet_id"])


def _alignment_index() -> dict[str, dict]:
    idx: dict[str, dict] = {}
    if ALIGN.exists():
        for line in ALIGN.read_text(encoding="utf-8").splitlines():
            r = json.loads(line)
            idx[r["mix"]] = r
    return idx


def audit(_: argparse.Namespace | None = None) -> dict:
    store = rights_store()
    df = pd.read_parquet(TRIPLETS) if TRIPLETS.exists() else pd.DataFrame(columns=["domain"])
    al = _alignment_index()
    statuses = []
    for r in df.itertuples():
        assets = [store.assets.get(i) or AssetRights(i, "unknown") for i in (r.mix_id, r.out_id, r.in_id)]
        present = {a.asset_id: bool(p and Path(p).exists()) for a, p in zip(assets, (r.mix_path, r.out_path, r.in_path))}
        mix_name = Path(r.mix_path).name if isinstance(r.mix_path, str) else None
        validated = bool(mix_name and al.get(mix_name, {}).get("alignment_validated"))
        try:
            st = gate_triplet_for_waveform_training(*assets, present, validated)
        except GateError:
            st = Status.REVOKED
        blocker = {Status.RIGHTS_REVIEW: "train_model needs human rights review (CC BY-NC-ND: training not explicitly covered)", Status.APPROVED_FOR_TARGET_USE: "audio file missing (labels only)", Status.THREE_WAY_MATCH_CONFIRMED: "alignment not validated", Status.DISCOVERED: "no rights reviewed", Status.BLOCKED: "a required use is denied"}.get(st, "")
        statuses.append({"triplet_id": r.triplet_id, "domain": r.domain, "status": st.value, "audio_complete": all(present.values()), "alignment_validated": validated, "blocker": blocker})
    sdf = pd.DataFrame(statuses)
    (REPO / "reports").mkdir(exist_ok=True)
    sdf.to_csv(REPO / "reports" / "triplet_readiness.csv", index=False)
    def count(domain: str, **cond) -> int:
        d = sdf[sdf.domain == domain] if len(sdf) else sdf
        for k, v in cond.items():
            d = d[d[k] == v]
        return int(len(d))
    summary = {
        "professional_dj_performance": {"metadata_candidates": None, "triplets_registered": count("professional_dj_performance"), "audio_complete": count("professional_dj_performance", audio_complete=True), "alignment_verified": count("professional_dj_performance", alignment_validated=True), "human_dj_triplets_trainable": count("professional_dj_performance", status="TRAINABLE_TRIPLET")},
        "synthetic_reference_unmixdb": {"triplets_registered": count("synthetic_reference"), "audio_complete": count("synthetic_reference", audio_complete=True), "alignment_verified": count("synthetic_reference", alignment_validated=True), "trainable": count("synthetic_reference", status="TRAINABLE_TRIPLET"), "status_counts": sdf[sdf.domain == "synthetic_reference"].status.value_counts().to_dict() if len(sdf) else {}},
    }
    (REPO / "reports" / "rights_compliance.json").write_text(json.dumps({"summary": summary, "policy": "licence-policy:v1 (default deny; per-use; human review for training/adaptation under NC/ND)", "assets_with_records": len(store.assets)}, indent=1), encoding="utf-8")
    log("audit", **{k: v for k, v in summary["synthetic_reference_unmixdb"].items() if k != "status_counts"})
    return summary


def align_cmd(args: argparse.Namespace) -> None:
    from ml.dsp.unmix import AudioDecodeError, verify_mix

    from .unmixdb import parse_mix_labels, set_dirs

    done = _alignment_index()
    n = 0
    with ALIGN.open("a", encoding="utf-8") as f:
        for sdir in set_dirs(_unmixdb_root()):
            for lab in sorted((sdir / "mixes").glob("*.labels.txt")):
                ml = parse_mix_labels(lab)
                if not ml.audio.exists() or ml.audio.name in done:
                    continue
                try:
                    r = verify_mix(ml, sdir / "refsongs")
                except AudioDecodeError as e:
                    r = {"mix": ml.audio.name, "error": str(e), "alignment_validated": False}
                r["set"] = sdir.name
                f.write(json.dumps(r) + "\n")
                f.flush()
                n += 1
                if args.limit and n >= args.limit:
                    break
            if args.limit and n >= args.limit:
                break
    log("align", processed=n)
    summarize_alignment()


def summarize_alignment() -> dict:
    rows = []
    for r in _alignment_index().values():
        if "tracks" not in r:
            continue
        for t in r["tracks"]:
            rows.append({"set": r["set"], "timescale": r["timescale"], "effect": r["effect"], "start_err_ms": t["start_err_ms"], "start_err_corr_ms": t["start_err_codec_corrected_ms"], "speed_err": t["speed_err"], "gain_corr": t["gain_corr"], "gain_mae_fades": t["gain_mae_fades"], "sc": r["spectral_convergence"], "lsd": r["log_spectral_distance_db"], "snr": r.get("time_domain_snr_db"), "validated": r["alignment_validated"]})
    df = pd.DataFrame(rows)
    out = {}
    if len(df):
        for ts, g in df.groupby("timescale"):
            out[ts] = {
                "tracks": int(len(g)),
                "mixes": int(len(g) // 3),
                "start_err_ms_median": float(g.start_err_ms.median()),
                "start_within_50ms_pct": float((g.start_err_ms <= 50).mean() * 100),
                "start_err_codec_corrected_ms_median": float(g.start_err_corr_ms.median()),
                "speed_err_median": float(g.speed_err.median()),
                "gain_corr_median": float(g.gain_corr.median()),
                "gain_mae_fades_median": float(g.gain_mae_fades.median()),
                "spectral_convergence_median": float(g.sc.median()),
                "lsd_db_median": float(g.lsd.median()),
                "time_domain_snr_db_median": float(g.snr.median()) if g.snr.notna().any() else None,
                "mixes_validated_pct": float(g.groupby(g.index // 3).validated.first().mean() * 100),
            }
        for eff, g in df.groupby("effect"):
            out[f"effect={eff}"] = {"tracks": int(len(g)), "start_within_50ms_pct": float((g.start_err_ms <= 50).mean() * 100), "gain_corr_median": float(g.gain_corr.median())}
    (REPO / "reports").mkdir(exist_ok=True)
    (REPO / "reports" / "unmixdb_three_way_benchmark.json").write_text(json.dumps({"benchmark": "UnmixDB v1 (synthetic reference mixes; NOT professional DJ performances)", "by_group": out, "note": "start_err includes a constant 25.06 ms MP3 encoder delay between mix and source files; codec-corrected values subtract it."}, indent=1), encoding="utf-8")
    return out


def export_train(args: argparse.Namespace) -> None:
    audit()
    sdf = pd.read_csv(REPO / "reports" / "triplet_readiness.csv")
    ok = sdf[(sdf.domain == args.domain) & (sdf.status == "TRAINABLE_TRIPLET")] if args.verified_only else sdf[sdf.domain == args.domain]
    out = ROOT / "derived" / f"train_{args.domain}.parquet"
    ok.to_parquet(out)
    log("export-train", domain=args.domain, rows=len(ok), path=str(out), note="0 rows means no triplet passed rights + audio + alignment gates")


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="python -m ml.datasets.triplets")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("register")
    r.add_argument("kind", choices=["unmixdb", "human"])
    r.add_argument("--mix")
    r.add_argument("--out")
    r.add_argument("--in", dest="inc")
    r.add_argument("--mix-path")
    r.add_argument("--out-path")
    r.add_argument("--in-path")
    r.add_argument("--rights-ref")
    r.set_defaults(fn=lambda a: register_unmixdb() if a.kind == "unmixdb" else register_human(a))
    sub.add_parser("audit").set_defaults(fn=audit)
    a = sub.add_parser("align")
    a.add_argument("--limit", type=int)
    a.set_defaults(fn=align_cmd)
    e = sub.add_parser("export-train")
    e.add_argument("--verified-only", action="store_true")
    e.add_argument("--domain", default="professional_dj_performance")
    e.set_defaults(fn=export_train)
    args = p.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
