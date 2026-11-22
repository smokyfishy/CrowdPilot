"""Acquisition CLI.

  python -m ml.datasets.acquire inventory                 # snapshot official metadata for every source
  python -m ml.datasets.acquire verify-source unmixdb     # print verified licence/files; write rights records
  python -m ml.datasets.acquire fetch-approved unmixdb [--only set222] [--max-gb N]
  python -m ml.datasets.acquire ingest unmixdb            # build the asset manifest (parquet) + hashes

Downloads only sources whose rights record approves ``waveform_analyze`` with licence
evidence; resumable (HTTP Range), checksum-verified (provider md5), size-limited,
with path-traversal-safe ZIP extraction into a fresh directory per archive.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import shutil
import sys
import time
import zipfile
from pathlib import Path

import requests

from .registry import DATA_ROOT, SOURCES
from .rights import AssetRights, Decision, RightsStore, Use, apply_cc_policy

ROOT = Path(DATA_ROOT)
SNAP = ROOT / "registry" / "snapshots"
PRIVATE = ROOT / "registry" / "private"
REPO = Path(__file__).resolve().parents[2]
LOG = ROOT / "logs" / "acquisition.jsonl"
UA = {"User-Agent": "CrowdPilot-research-pipeline/1.0 (noncommercial research)"}


def log(event: str, **kw) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    rec = {"at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "event": event, **kw}
    with LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec) + "\n")
    print(json.dumps(rec))


def get_json(url: str, retries: int = 4) -> dict | list:
    for attempt in range(retries):
        try:
            r = requests.get(url, headers=UA, timeout=30)
            if r.status_code == 429 or r.status_code >= 500:
                raise requests.HTTPError(f"HTTP {r.status_code}")
            r.raise_for_status()
            return r.json()
        except (requests.RequestException, ValueError):
            if attempt == retries - 1:
                raise
            time.sleep(2**attempt)
    raise RuntimeError("unreachable")


# ───────────────────────── inventory ─────────────────────────

def inventory(_: argparse.Namespace) -> None:
    SNAP.mkdir(parents=True, exist_ok=True)
    out = {}
    for sid, src in SOURCES.items():
        api = src.get("api")
        row = {"id": sid, **{k: src[k] for k in ("title", "official", "kind", "audio_available", "quality_tier")}}
        if not api:
            row["metadata_status"] = "no machine-readable endpoint; page review required"
            out[sid] = row
            continue
        try:
            data = get_json(api)
            (SNAP / f"{sid}.json").write_text(json.dumps(data, indent=1), encoding="utf-8")
            if "zenodo" in api:
                row["licence"] = data["metadata"].get("license", {}).get("id")
                row["files"] = [{"key": f["key"], "bytes": f["size"], "checksum": f["checksum"]} for f in data.get("files", [])]
                row["total_bytes"] = sum(f["size"] for f in data.get("files", []))
            elif "huggingface" in api:
                row["licence"] = (data.get("cardData") or {}).get("license") or next((t.split(":", 1)[1] for t in data.get("tags", []) if t.startswith("license:")), None)
                row["gated"] = data.get("gated")
                row["files"] = [s.get("rfilename") for s in data.get("siblings", [])][:200]
                row["audio_files_in_repo"] = sum(1 for s in data.get("siblings", []) if str(s.get("rfilename", "")).lower().endswith((".wav", ".mp3", ".flac", ".ogg", ".m4a")))
            elif "github" in api:
                row["licence"] = (data.get("license") or {}).get("spdx_id")
                row["default_branch"] = data.get("default_branch")
                row["updated"] = data.get("pushed_at")
            row["metadata_status"] = "snapshot saved"
        except Exception as e:  # noqa: BLE001
            row["metadata_status"] = f"fetch failed: {e}"
        out[sid] = row
        log("inventory", source=sid, status=row["metadata_status"], licence=row.get("licence"))
    (REPO / "reports").mkdir(exist_ok=True)
    (REPO / "reports" / "dataset_inventory.json").write_text(json.dumps(out, indent=1), encoding="utf-8")


# ───────────────────────── rights records for a source ─────────────────────────

def rights_store() -> RightsStore:
    return RightsStore(PRIVATE / "rights.json")


def verify_source(args: argparse.Namespace) -> None:
    sid = args.source
    if sid != "unmixdb":
        log("verify-source", source=sid, result="metadata-only: no audio distributed by this source, no rights records created")
        return
    data = get_json(SOURCES[sid]["api"])
    (SNAP / f"{sid}.json").write_text(json.dumps(data, indent=1), encoding="utf-8")
    lic = data["metadata"].get("license", {}).get("id", "")
    evidence = [SOURCES[sid]["official"], str(SNAP / f"{sid}.json"), f"https://creativecommons.org/licenses/{lic.replace('cc-', '').rsplit('-', 1)[0]}/4.0/" if lic.startswith("cc-") else ""]
    evidence = [e for e in evidence if e]
    store = rights_store()
    for f in data.get("files", []):
        a = AssetRights(asset_id=f"unmixdb/{f['key']}", role="synthetic_reference" if f["key"].endswith(".zip") else "documentation", platform_terms="Zenodo open access record")
        apply_cc_policy(a, lic, evidence[-1] if evidence else "", evidence)
        store.put(a, f"licence policy applied from official record ({lic})")
    store.save()
    store.save_redacted(REPO / "ml" / "data" / "registry" / "rights_redacted.json")
    log("verify-source", source=sid, licence=lic, files=len(data.get("files", [])), decisions={u.value: a.decision(u).decision.value for u in Use})


# ───────────────────────── downloads ─────────────────────────

def _md5(path: Path) -> str:
    h = hashlib.md5()  # provider checksum (Zenodo publishes md5)
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(url: str, dest: Path, expected_bytes: int, expected_md5: str | None, max_bytes: int) -> Path:
    if expected_bytes > max_bytes:
        raise RuntimeError(f"{dest.name}: {expected_bytes} bytes exceeds the per-file limit {max_bytes}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size == expected_bytes and (not expected_md5 or _md5(dest) == expected_md5):
        log("download", file=dest.name, result="already present, checksum ok")
        return dest
    part = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(8):
        have = part.stat().st_size if part.exists() else 0
        headers = {**UA, **({"Range": f"bytes={have}-"} if have else {})}
        try:
            with requests.get(url, headers=headers, stream=True, timeout=60) as r:
                if r.status_code == 416:
                    break
                r.raise_for_status()
                if have and r.status_code != 206:
                    have = 0  # server ignored Range: restart
                with part.open("ab" if have else "wb") as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
            if part.stat().st_size >= expected_bytes:
                break
        except requests.RequestException as e:
            log("download-retry", file=dest.name, attempt=attempt, error=str(e))
            time.sleep(min(60, 2**attempt))
    if part.stat().st_size != expected_bytes:
        raise RuntimeError(f"{dest.name}: size {part.stat().st_size} != expected {expected_bytes}")
    if expected_md5 and _md5(part) != expected_md5:
        part.unlink()
        raise RuntimeError(f"{dest.name}: md5 mismatch — deleted partial file")
    os.replace(part, dest)
    log("download", file=dest.name, bytes=expected_bytes, md5="ok" if expected_md5 else "n/a")
    return dest


def safe_extract(zip_path: Path, target: Path) -> int:
    """Extract into a fresh directory, refusing absolute paths, '..' and symlinks."""
    if target.exists() and any(target.iterdir()):
        return sum(1 for _ in target.rglob("*") if _.is_file())
    target.mkdir(parents=True, exist_ok=True)
    root = target.resolve()
    n = 0
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            name = info.filename
            if name.startswith(("/", "\\")) or ".." in Path(name).parts or ":" in name:
                raise RuntimeError(f"unsafe path in {zip_path.name}: {name}")
            if (info.external_attr >> 16) & 0o170000 == 0o120000:
                raise RuntimeError(f"symlink in {zip_path.name}: {name}")
            dest = (root / name).resolve()
            if root not in dest.parents and dest != root:
                raise RuntimeError(f"escapes target: {name}")
            if info.is_dir():
                dest.mkdir(parents=True, exist_ok=True)
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            with z.open(info) as src, dest.open("wb") as out:
                shutil.copyfileobj(src, out)
            n += 1
    return n


def fetch_approved(args: argparse.Namespace) -> None:
    sid = args.source
    if sid != "unmixdb":
        raise SystemExit(f"{sid}: no approved downloadable audio (metadata-only source)")
    store = rights_store()
    data = json.loads((SNAP / f"{sid}.json").read_text(encoding="utf-8"))
    free = shutil.disk_usage(ROOT).free
    files = [f for f in data["files"] if not args.only or any(o in f["key"] for o in args.only)]
    need = sum(f["size"] for f in files)
    if need * 2.2 > free:  # zip + extracted copy
        raise SystemExit(f"not enough free disk: need ≈{need * 2.2 / 1e9:.1f} GB, have {free / 1e9:.1f} GB")
    for f in files:
        a = store.assets.get(f"unmixdb/{f['key']}")
        if not a or not a.allows(Use.WAVEFORM_ANALYZE):
            log("fetch-skip", file=f["key"], reason="waveform_analyze not approved")
            continue
        url = f["links"]["self"]
        md5 = f["checksum"].split(":", 1)[1] if f["checksum"].startswith("md5:") else None
        dest = download(url, ROOT / "raw" / sid / "archives" / f["key"], f["size"], md5, int(args.max_gb * 1e9))
        if dest.suffix == ".zip":
            n = safe_extract(dest, ROOT / "raw" / sid / "extracted" / dest.stem)
            log("extract", file=dest.name, files=n)


# ───────────────────────── ingest (UnmixDB manifest) ─────────────────────────

def ingest(args: argparse.Namespace) -> None:
    from .unmixdb import build_manifest

    df = build_manifest(ROOT / "raw" / "unmixdb" / "extracted")
    out = ROOT / "derived" / "unmixdb_manifest.parquet"
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out)
    log("ingest", source="unmixdb", rows=len(df), mixes=int((df.role == "mix").sum()), excerpts=int((df.role == "excerpt").sum()), path=str(out))


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="python -m ml.datasets.acquire")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("inventory").set_defaults(fn=inventory)
    v = sub.add_parser("verify-source")
    v.add_argument("source")
    v.set_defaults(fn=verify_source)
    f = sub.add_parser("fetch-approved")
    f.add_argument("source")
    f.add_argument("--only", nargs="*")
    f.add_argument("--max-gb", type=float, default=5.0, help="per-file safety limit")
    f.set_defaults(fn=fetch_approved)
    i = sub.add_parser("ingest")
    i.add_argument("source")
    i.set_defaults(fn=ingest)
    args = p.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
