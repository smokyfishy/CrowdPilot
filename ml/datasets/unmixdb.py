"""UnmixDB parsing (official label formats, see the record's README.txt).

mixes/<set>mix<n>-<timescale>-<effect>-<idx>.labels.txt : tab-separated
    start_time  end_time  track_no  label  [argument]
  labels: start "<file>", speed <factor>, bpm <bpm>, fadein, fadeout, cutpoint, stop "<file>"
refsongs/<name>.excerpt40.txt : filename bpm cueinstart cueinend cutpoint joinpoint cueoutstart cueoutend duration
"""
from __future__ import annotations

import dataclasses
import hashlib
import re
from pathlib import Path

import pandas as pd

MIX_RE = re.compile(r"^(?P<set>set\d+)mix(?P<mix>\d+)-(?P<timescale>none|resample|stretch)-(?P<effect>none|bass|compressor|distortion)-(?P<idx>\d+)\.labels\.txt$")


@dataclasses.dataclass
class TrackInMix:
    track_no: int
    file: str
    start: float  # mix time (s) where source t=0 sits (before speed change)
    speed: float
    bpm: float | None = None
    fadein: tuple[float, float] | None = None
    fadeout: tuple[float, float] | None = None
    stop: float | None = None
    cutpoint: float | None = None


@dataclasses.dataclass
class MixLabels:
    path: Path
    set: str
    mix: int
    timescale: str
    effect: str
    idx: int
    tracks: dict[int, TrackInMix]

    @property
    def audio(self) -> Path:
        return self.path.with_name(self.path.name.replace(".labels.txt", ".mp3"))


def parse_mix_labels(path: Path) -> MixLabels:
    m = MIX_RE.match(path.name)
    if not m:
        raise ValueError(f"not an UnmixDB mix label file: {path.name}")
    tracks: dict[int, TrackInMix] = {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        parts = line.rstrip("\n").split("\t")
        if len(parts) < 4:
            continue
        t0, t1, no, label = float(parts[0]), float(parts[1]), int(parts[2]), parts[3]
        arg = parts[4].strip().strip('"') if len(parts) > 4 else ""
        tr = tracks.setdefault(no, TrackInMix(no, "", t0, 1.0))
        if label == "start":
            tr.file, tr.start = arg, t0
        elif label == "speed":
            tr.speed = float(arg)
        elif label == "bpm":
            tr.bpm = float(arg)
        elif label == "fadein":
            tr.fadein = (t0, t1)
        elif label == "fadeout":
            tr.fadeout = (t0, t1)
        elif label == "stop":
            tr.stop = t0
        elif label == "cutpoint":
            tr.cutpoint = t0
    return MixLabels(path, m["set"], int(m["mix"]), m["timescale"], m["effect"], int(m["idx"]), tracks)


def parse_refsong(path: Path) -> dict:
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    head = lines[0].split("\t")
    vals = lines[1].split("\t")
    row = dict(zip(head, vals))
    out = {"filename": row["filename"].strip('"')}
    for k in head[1:]:
        out[k] = float(row[k])
    return out


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()


def set_dirs(root: Path) -> list[Path]:
    return sorted({p.parent.parent for p in root.rglob("mixes/*.labels.txt")})


def build_manifest(root: Path, with_hashes: bool = True) -> pd.DataFrame:
    rows = []
    for sdir in set_dirs(root):
        lic = (sdir / "license_link.txt").read_text(encoding="utf-8").strip().replace("\n", " ") if (sdir / "license_link.txt").exists() else ""
        for ref in sorted((sdir / "refsongs").glob("*.excerpt40.mp3")):
            meta = parse_refsong(ref.with_suffix(".txt")) if ref.with_suffix(".txt").exists() else {}
            rows.append({"asset_id": f"unmixdb/{sdir.name}/refsongs/{ref.name}", "role": "excerpt", "set": sdir.name, "path": str(ref), "bytes": ref.stat().st_size, "sha256": sha256(ref) if with_hashes else None, "bpm_label": meta.get("bpm"), "track_licence": lic, "kind": "synthetic_reference_source_excerpt"})
        for lab in sorted((sdir / "mixes").glob("*.labels.txt")):
            ml = parse_mix_labels(lab)
            audio = ml.audio
            rows.append({"asset_id": f"unmixdb/{sdir.name}/mixes/{audio.name}", "role": "mix", "set": sdir.name, "path": str(audio) if audio.exists() else None, "bytes": audio.stat().st_size if audio.exists() else 0, "sha256": sha256(audio) if with_hashes and audio.exists() else None, "timescale": ml.timescale, "effect": ml.effect, "mix_no": ml.mix, "variant": ml.idx, "n_tracks": len(ml.tracks), "audio_present": audio.exists(), "labels_path": str(lab), "track_licence": lic, "kind": "synthetic_reference"})
    return pd.DataFrame(rows)
