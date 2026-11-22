"""Private listening/evaluation corpus: Jamendo house/techno tracks whose CC licence permits
adaptations (no ND), downloads enabled by the artist. Rights records + provenance per track.

  python -m ml.evalcorpus.build --n 30
"""
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path
import numpy as np, requests, soundfile as sf
from scipy.signal import resample_poly
from ml.datasets.acquire import PRIVATE, REPO, ROOT, log, rights_store
from ml.datasets.rights import AssetRights, apply_cc_policy, Use

OUT = ROOT / "raw" / "jamendo_eval"  # overridden by --name
UA = {"User-Agent": "CrowdPilot-research-pipeline/1.0 (noncommercial research)"}


def query(cid: str, tags: str, offset: int) -> list[dict]:
    r = requests.get("https://api.jamendo.com/v3.0/tracks/", params={"client_id": cid, "format": "json", "limit": 200, "offset": offset, "fuzzytags": tags, "audiodownload_allowed": "true", "include": "musicinfo licenses", "durationbetween": "180_540", "order": "popularity_total"}, headers=UA, timeout=60)
    r.raise_for_status()
    return r.json().get("results", [])


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--n", type=int, default=30)
    p.add_argument("--name", default="jamendo_eval")
    p.add_argument("--tags", nargs="*", default=["techno", "house", "techhouse", "deephouse", "minimal"])
    p.add_argument("--genres", nargs="*", default=["techno", "house", "electronic", "minimal", "dance"])
    p.add_argument("--allow-nd", action="store_true", help="also fetch CC ND tracks (analysis only until the owner approves private renders)")
    p.add_argument("--per-artist", type=int, default=99)
    a = p.parse_args(argv)
    global OUT
    OUT = ROOT / "raw" / a.name
    cid = json.loads((PRIVATE / "jamendo.json").read_text())["client_id"]
    store = rights_store()
    OUT.mkdir(parents=True, exist_ok=True)
    picked, seen = [], set()
    per_artist: dict[str, int] = {}
    for tags in a.tags:
        for off in (0, 200):
            for t in query(cid, tags, off):
                lic = t.get("license_ccurl") or ""
                if not lic or t["id"] in seen or not t.get("audiodownload"):
                    continue
                if ("/nd" in lic or "-nd" in lic) and not a.allow_nd:
                    continue
                g = " ".join((t.get("musicinfo") or {}).get("tags", {}).get("genres", []))
                if not any(k in g for k in a.genres):
                    continue
                if per_artist.get(t["artist_name"], 0) >= a.per_artist:
                    continue
                per_artist[t["artist_name"]] = per_artist.get(t["artist_name"], 0) + 1
                seen.add(t["id"])
                picked.append(t)
            if len(picked) >= a.n * 2:
                break
    rows = []
    for t in picked:
        if len(rows) >= a.n:
            break
        mp3 = OUT / f"jamendo_{t['id']}.mp3"
        if not mp3.exists():
            r = requests.get(t["audiodownload"], headers=UA, timeout=120)
            if r.status_code != 200 or len(r.content) < 500_000:
                continue
            mp3.write_bytes(r.content)
        x, sr = sf.read(str(mp3), always_2d=True, dtype="float32")
        if sr != 44100:
            g = np.gcd(sr, 44100)
            x = resample_poly(x, 44100 // g, sr // g, axis=0).astype(np.float32)
        wav = mp3.with_suffix(".wav")
        sf.write(str(wav), x[:, :2] if x.shape[1] >= 2 else np.repeat(x, 2, 1), 44100, subtype="FLOAT")
        lic = t["license_ccurl"]
        code = lic.rstrip("/").split("/licenses/")[1].split("/")
        aid = f"jamendo/{t['id']}"
        ar = AssetRights(aid, "eval_track", platform_terms="Jamendo API Terms §3.3 (non-commercial); artist enabled downloads")
        apply_cc_policy(ar, f"cc-{code[0]}-{code[1]}", lic, [f"https://www.jamendo.com/track/{t['id']}", lic, "Jamendo API v3 tracks response (license_ccurl, audiodownload_allowed=true)"])
        store.put(ar, "eval corpus" + (" (ND: analysis only until owner approves private renders)" if "nd" in code[0] else " (adaptations permitted)"))
        rows.append({"id": t["id"], "title": t["name"], "artist": t["artist_name"], "duration": t["duration"], "licence": lic, "sha256": hashlib.sha256(mp3.read_bytes()).hexdigest(), "wav": str(wav), "render_private_mix": ar.allows(Use.RENDER_PRIVATE_MIX), "genres": (t.get("musicinfo") or {}).get("tags", {}).get("genres", [])})
    store.save(); store.save_redacted(REPO / "ml" / "data" / "registry" / "rights_redacted.json")
    (OUT / "corpus.json").write_text(json.dumps(rows, indent=1), encoding="utf-8")
    log("evalcorpus", tracks=len(rows), licences=sorted({r["licence"] for r in rows}))
    print(len(rows), "tracks")


if __name__ == "__main__":
    main()
