"""Human-performed DJ triplets from Mixotic sets + netlabel masters.

  python -m ml.datasets.human_triplet register     # rights records (evidence chains) for candidate masters
  python -m ml.datasets.human_triplet fetch        # download masters whose waveform_analyze is approved
  python -m ml.datasets.human_triplet align        # locate both masters in the human mix, estimate the transition

Each candidate below lists its evidence. A master WITHOUT any licence evidence is recorded
(default deny) and never fetched — e.g. Pentagonik 007 "Dance Away" (Mixotic 044 track 05).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

from .acquire import REPO, ROOT, download, log, rights_store
from .rights import AssetRights, apply_cc_policy

UNMIX_ATTR = "UnmixDB v1 reftrack_attributions.txt (zenodo.org/records/1422385, set044)"

CANDIDATES = {
    # Mixotic 044 (Cotumo, Pentagonik Labelmix, 2006): playlist positions from the label's info.txt
    "044-12": {"item": "pntg005", "file": "pntg005-03-kairos-on_the_run.mp3", "md5": "c7c211316a60c1d5f0d4120dbfcc646d", "bytes": 8697984, "title": "Kairos - On The Run", "licence": "cc-by-nc-nd-2.0", "licence_url": "http://creativecommons.org/licenses/by-nc-nd/2.0/de/", "evidence": [UNMIX_ATTR + ": 'Licensed to the public under by-nc-nd/2.0/de'", "https://archive.org/details/pntg005 (community upload; no licence field — weaker provenance)"]},
    "044-13": {"item": "pntg006", "file": "pntg006-03-charles_tone-das_haus_im_wald.mp3", "md5": "1d52f9c562c2adf3dffd3e4e10126f3b", "bytes": 11612160, "title": "Charles Tone - Das Haus im Wald", "licence": "cc-by-nc-nd-2.5", "licence_url": "http://creativecommons.org/licenses/by-nc-nd/2.5/", "evidence": ["https://archive.org/details/pntg006 (label upload kai@pentagonik.de, licenseurl by-nc-nd/2.5)", UNMIX_ATTR + ": 'Licensed to the public under by-nc-nd/2.0/de'"]},
    "044-04": {"item": "pntg003", "file": "pntg003-04-ludwig_coenen_and_kareem-litchy_licker.mp3", "md5": "27a268965d7fe5f481f929afc31b1387", "bytes": 8142848, "title": "Ludwig Coenen & Kareem - Litchy Licker", "licence": "cc-by-nc-nd-2.5", "licence_url": "http://creativecommons.org/licenses/by-nc-nd/2.5/", "evidence": ["https://archive.org/details/pntg003 (label upload, licenseurl by-nc-nd/2.5)", "ID3 tag: creativecommons.org/licenses/by-nc-nd/2.0/de/", UNMIX_ATTR]},
    "044-05": {"item": "pntg007", "file": "pntg007-01-demir_feat._jesse-dance_away.mp3", "md5": "c4a5a4d9050741c55412f4f5f47eba9b", "bytes": 10117039, "title": "Demir feat. Jesse - Dance Away", "licence": "", "licence_url": "", "evidence": []},
}
MIX_044 = "Mixotic_044_-_Cotumo_-_Pentagonik_Labelmix_2006-06-27.mp3"
PLAYLIST_LEN_044 = 14  # official info.txt
POSITION = {"044-12": 12, "044-13": 13, "044-04": 4, "044-05": 5}
TRIPLETS = {"044:12>13": ("044-12", "044-13"), "044:04>05": ("044-04", "044-05")}


def register(_: argparse.Namespace) -> None:
    store = rights_store()
    for cid, c in CANDIDATES.items():
        a = AssetRights(asset_id=f"netlabel/{c['item']}/{c['file']}", role="source_master", platform_terms="Internet Archive netlabels collection")
        a.composition_rights = "same licence as recording (artist-released netlabel track)"
        if c["licence"] and c["evidence"]:
            apply_cc_policy(a, c["licence"], c["licence_url"], c["evidence"])
        store.put(a, f"candidate {cid}: " + ("licence policy from documented evidence" if c["evidence"] else "NO licence evidence — default deny"))
        log("register-master", candidate=cid, title=c["title"], licence=c["licence"] or None, analyze_allowed=a.allows(__import__("ml.datasets.rights", fromlist=["Use"]).Use.WAVEFORM_ANALYZE))
    store.save()
    store.save_redacted(REPO / "ml" / "data" / "registry" / "rights_redacted.json")


def fetch(_: argparse.Namespace) -> None:
    from .rights import Use

    store = rights_store()
    for cid, c in CANDIDATES.items():
        a = store.assets.get(f"netlabel/{c['item']}/{c['file']}")
        if not a or not a.allows(Use.WAVEFORM_ANALYZE):
            log("fetch-skip", candidate=cid, reason="no approved licence evidence (default deny) — permission request drafted in docs/RIGHTSHOLDER_REQUEST_TEMPLATES.md")
            continue
        download(f"https://archive.org/download/{c['item']}/{c['file']}", ROOT / "raw" / "netlabel" / c["item"] / c["file"], c["bytes"], c["md5"], 10**9)


def align(_: argparse.Namespace) -> None:
    from ml.dsp.unmix import SR, align_full, estimate_gains, load_mono, mag, onset_env, warp_mag

    mix_path = ROOT / "raw" / "mixotic" / "mixes" / MIX_044
    mix = load_mono(mix_path)
    M = mag(mix)
    menv = onset_env(M)
    out = {}
    for tid, (a_id, b_id) in TRIPLETS.items():
        paths = [ROOT / "raw" / "netlabel" / CANDIDATES[c]["item"] / CANDIDATES[c]["file"] for c in (a_id, b_id)]
        if not all(p.exists() for p in paths):
            out[tid] = {"status": "blocked", "reason": "a source master is not acquired (missing licence evidence)", "missing": [str(p.name) for p in paths if not p.exists()]}
            continue
        res = {"mix": MIX_044, "tracks": []}
        Ys = []
        prev = None
        for cid, p in zip((a_id, b_id), paths):
            x = load_mono(p)
            X = mag(x)
            if prev:
                window = (prev[0] + 0.2 * prev[1], prev[0] + prev[1] + 30)
            else:
                # playlist-position prior: track i of N starts within a broad band around (i-1)/N of the mix
                dur = len(mix) / SR
                i = POSITION[cid]
                window = (max(0.0, (i - 1) / PLAYLIST_LEN_044 * dur - 0.12 * dur), min(dur, (i - 1) / PLAYLIST_LEN_044 * dur + 0.12 * dur))
                res["position_prior_s"] = [round(window[0], 1), round(window[1], 1)]
            al, wncc = align_full(mix, x, "resample", menv, onset_env(X), window)
            prev = (al.start, len(x) / SR / al.speed)
            Ys.append(warp_mag(X, M.shape[1], al.start, al.speed))
            res["tracks"].append({"candidate": cid, "title": CANDIDATES[cid]["title"], "start_s": al.start, "speed": al.speed, "env_ncc": al.score, "waveform_ncc": wncc, "end_s": al.start + len(x) / SR / al.speed})
        # transition region: overlap of the two placements (± 20 s context)
        t0 = max(res["tracks"][1]["start_s"], 0) - 20
        t1 = min(res["tracks"][0]["end_s"], len(mix) / SR) + 20
        fps = SR / 512
        a, b = int(max(0, t0) * fps), int(min(M.shape[1], t1 * fps))
        G = estimate_gains(M[:, a:b], [Y[:, a:b] for Y in Ys])
        Mh = sum(G[k][None, :] * Ys[k][:, a:b] for k in range(2))
        sc = float(np.linalg.norm(M[:, a:b] - Mh) / (np.linalg.norm(M[:, a:b]) + 1e-12))
        g_out, g_in = G[0], G[1]
        thr = lambda g: (np.nonzero(g > 0.5 * np.percentile(g, 95))[0])  # noqa: E731
        res["transition"] = {
            "region_s": [round(max(0, t0), 2), round(t1, 2)],
            "overlap_s": round(res["tracks"][0]["end_s"] - res["tracks"][1]["start_s"], 2),
            "incoming_audible_from_s": round(a / fps + (thr(g_in)[0] / fps if len(thr(g_in)) else 0), 2),
            "outgoing_audible_until_s": round(a / fps + (thr(g_out)[-1] / fps if len(thr(g_out)) else 0), 2),
            "tempo_ratio_in_over_out": round(res["tracks"][1]["speed"] / res["tracks"][0]["speed"], 5),
            "spectral_convergence": round(sc, 3),
            "gain_curves_hz": round(fps, 3),
            "label_origin": "inferred_pseudo_label (inverse estimate from a human performance; not controller truth)",
        }
        conf = all((t["waveform_ncc"] or 0) > 0.2 or t["env_ncc"] >= 0.3 for t in res["tracks"])
        res["alignment_validated"] = bool(conf and sc < 0.5)
        np.save(ROOT / "derived" / f"human_{tid.replace(':', '_').replace('>', '-')}_gains.npy", G)
        out[tid] = res
    (ROOT / "derived" / "human_alignment.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    (REPO / "reports").mkdir(exist_ok=True)
    (REPO / "reports" / "human_triplet_alignment.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    log("human-align", **{k: (v.get("alignment_validated") if isinstance(v, dict) else None) for k, v in out.items()})
    print(json.dumps(out, indent=1))


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="python -m ml.datasets.human_triplet")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name, fn in (("register", register), ("fetch", fetch), ("align", align)):
        sub.add_parser(name).set_defaults(fn=fn)
    args = p.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
