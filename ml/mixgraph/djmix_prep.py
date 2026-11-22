"""Normalise the DJ Mix Dataset (djmix/transitions + beats-tracks + mix metadata) into a compact
human-transition table for MixGraph training.

Source: https://huggingface.co/datasets/djmix/transitions, https://github.com/mir-aidj/djmix-dataset
(no licence stated; metadata only, used for private noncommercial research under the owner's
direction; no audio is downloaded — the dataset's audio links point to YouTube/SoundCloud,
which are not download rights).

The transitions were aligned AUTOMATICALLY (DTW of mix vs track audio) by the dataset authors:
cue/overlap values are weak human-derived labels with alignment confidences (match rates).

    python -m ml.mixgraph.djmix_prep
"""
from __future__ import annotations

import glob
import json
import os
import re

import numpy as np
import pyarrow.parquet as pq

ROOT = os.environ.get("CP_DATA_ROOT", r"C:\crowdpilot-data")
RAW = os.path.join(ROOT, "raw", "djmix")
OUT = os.path.join(ROOT, "ml", "djmix")

COLS = [
    "tran_id", "mix_id", "i_tran", "track_id_prev", "track_id_next",
    "match_rate_prev", "match_rate_next", "overlap_beats", "key_change_prev", "key_change_next",
    "track_cue_in_beat_prev", "track_cue_out_beat_prev", "track_cue_in_beat_next", "track_cue_out_beat_next",
    "track_cue_in_time_next", "track_cue_out_time_prev", "mix_cue_in_time_next", "mix_cue_out_time_prev",
]

GENRES = ["tech house", "deep house", "progressive house", "house", "techno", "trance", "drum & bass", "dubstep", "breaks",
          "electro", "minimal", "disco", "garage", "hard", "ambient", "downtempo", "edm", "big room", "bass", "acid"]


def genre_vec(tags: list[str]) -> list[int]:
    low = " | ".join(t.lower() for t in tags)
    return [1 if g in low else 0 for g in GENRES]


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    mixes = json.load(open(os.path.join(RAW, "djmix-dataset.json"), encoding="utf8"))
    mix_meta = {}
    for m in mixes:
        tags = [t["key"].replace("Category:", "") for t in (m.get("tags") or [])]
        # the first category on MixesDB is the artist (DJ) page; venues/series/genres follow
        dj = tags[0] if tags else "unknown"
        mix_meta[m["id"]] = {"dj": dj, "genres": genre_vec(tags), "tags": tags}

    bt = pq.read_table(os.path.join(RAW, "beats-tracks.parquet"))
    track = {}
    for tid, beats in zip(bt.column("track_id").to_pylist(), bt.column("beats").to_pylist()):
        b = np.asarray(beats, dtype=np.float64)
        if len(b) < 32:
            continue
        ibi = np.diff(b)
        track[tid] = {"bpm": float(60.0 / np.median(ibi)), "n_beats": int(len(b)), "dur": float(b[-1]),
                      "tempo_cv": float(np.std(ibi) / max(1e-6, np.mean(ibi)))}

    rows = []
    for f in sorted(glob.glob(os.path.join(RAW, "transitions", "*.parquet"))):
        t = pq.read_table(f, columns=COLS).to_pylist()
        rows.extend(t)
    print("transitions:", len(rows), "tracks with beats:", len(track))

    out = []
    for r in rows:
        a, b = track.get(r["track_id_prev"]), track.get(r["track_id_next"])
        if a is None or b is None:
            continue
        mm = mix_meta.get(r["mix_id"], {"dj": "unknown", "genres": [0] * len(GENRES)})
        out.append({
            **{k: r[k] for k in COLS},
            "dj": mm["dj"],
            "genres": mm["genres"],
            "bpm_prev": a["bpm"], "bpm_next": b["bpm"],
            "n_beats_prev": a["n_beats"], "n_beats_next": b["n_beats"],
            "tempo_cv_prev": a["tempo_cv"], "tempo_cv_next": b["tempo_cv"],
        })
    with open(os.path.join(OUT, "transitions.jsonl"), "w", encoding="utf8") as fh:
        for o in out:
            fh.write(json.dumps(o) + "\n")
    with open(os.path.join(OUT, "tracks.json"), "w", encoding="utf8") as fh:
        json.dump(track, fh)
    stats = {
        "transitions_total": len(rows),
        "transitions_with_track_beats": len(out),
        "mixes": len({o["mix_id"] for o in out}),
        "djs": len({o["dj"] for o in out}),
        "tracks": len({o["track_id_prev"] for o in out} | {o["track_id_next"] for o in out}),
        "match_rate_both_ge_0.5": sum(1 for o in out if min(o["match_rate_prev"], o["match_rate_next"]) >= 0.5),
        "overlap_beats_median": float(np.median([o["overlap_beats"] for o in out])),
        "genres": GENRES,
    }
    json.dump(stats, open(os.path.join(OUT, "stats.json"), "w"), indent=1)
    print(json.dumps(stats, indent=1))


if __name__ == "__main__":
    main()
