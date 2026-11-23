"""Experiment 1 — MixGraph LightGBM rankers trained on human DJ transitions (djmix).

Two ranking tasks, both evaluated on held-out DJs (split by DJ identity, so no DJ/mix appears in
both train and test):

  A. CUE/OVERLAP PLAUSIBILITY — given an outgoing/incoming track pair, rank the DJ's observed
     (incoming cue beat, outgoing transition-start beat, overlap length) against hard negatives
     from the same pair (shifted cues, other overlap lengths, phrase-misaligned variants).
     Features exist identically at runtime in CrowdPilot (beat indices from the beat grid).

  B. NEXT-TRACK SEQUENCING — given the outgoing track, rank the DJ's actual next track against
     hard negatives: other tracks from the same mix (positive-unlabelled: not "bad", just not
     chosen there) and tempo-matched tracks from other mixes.

Supervision is weak human evidence: positions come from the dataset authors' automatic
mix-to-track alignment; examples are weighted by alignment confidence (match rate).

Baselines: random, a hand rule, logistic regression (lightweight learned ranker), LightGBM
lambdarank. Calibration: a LightGBM binary model's expected calibration error.

    python -m ml.mixgraph.exp1_lgbm
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import time
from collections import defaultdict

import lightgbm as lgb
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

ROOT = os.environ.get("CP_DATA_ROOT", r"C:\crowdpilot-data")
DJM = os.path.join(ROOT, "ml", "djmix")
OUT = os.path.join(ROOT, "ml", "models", "mixgraph")
SEED = 20261122
MIN_MATCH = 0.6

CUE_FEATURES = [
    "in_beat_log", "in_frac", "in_m4", "in_m8", "in_m16", "in_m32",
    "out_start_frac", "out_m4", "out_m16", "out_m32",
    "tail_beats_log", "tail_frac", "overlap_log", "ov_m16", "ov_m32", "ov_neg",
    "bpm_prev", "tempo_dev", "n_beats_prev_log", "n_beats_next_log",
]


def split_of(key: str) -> str:
    h = int(hashlib.sha256(f"cp-dj-split-v1:{key}".encode()).hexdigest()[:8], 16) / 2**32
    return "train" if h < 0.7 else "val" if h < 0.8 else "test"


def tempo_dev(a: float, b: float) -> float:
    r = min((abs(a / (b * o) - 1) for o in (0.5, 1, 2)))
    return r


def cue_feats(in_beat: float, out_start: float, overlap: float, nprev: int, nnext: int, bpm_prev: float, bpm_next: float) -> list[float]:
    tail = nprev - (out_start + max(0.0, overlap))
    ib = round(in_beat)
    ob = round(out_start)
    ov = round(overlap)
    return [
        math.log1p(max(0, in_beat)), in_beat / max(1, nnext),
        float(ib % 4 == 0), float(ib % 8 == 0), float(ib % 16 == 0), float(ib % 32 == 0),
        out_start / max(1, nprev), float(ob % 4 == 0), float(ob % 16 == 0), float(ob % 32 == 0),
        math.log1p(max(0, tail)), tail / max(1, nprev), math.log1p(max(0, overlap)),
        float(ov % 16 == 0), float(ov % 32 == 0), float(overlap < 0),
        bpm_prev, tempo_dev(bpm_prev, bpm_next), math.log1p(nprev), math.log1p(nnext),
    ]


def cue_groups(rows, rng):
    """Two groups per human transition: the observed configuration + 15 HARD negatives (cue
    shifts of 1–64 beats, other overlap lengths ending at the same point), and the observed
    configuration + 15 UNIFORM negatives (anywhere plausible in the two tracks). Negatives copy
    the positive's fractional beat parts and obey the same bounds, so rounding or range artefacts
    cannot identify the positive."""
    X, y, w, gid, split, gkind = [], [], [], [], [], []
    g = 0
    for r in rows:
        nprev, nnext = r["n_beats_prev"], r["n_beats_next"]
        in_b = float(r["track_cue_in_beat_next"])
        ov = float(r["overlap_beats"])
        out_end = float(r["track_cue_out_beat_prev"])
        out_s = out_end - max(0.0, ov)
        ok = lambda ni, no, nv: 0 <= ni < nnext * 0.6 and nprev * 0.3 <= no < nprev and no + max(0.0, nv) <= nprev and -32 <= nv <= 512
        if not ok(in_b, out_s, ov):
            continue
        fo = ov - math.floor(ov)
        wt = min(r["match_rate_prev"], r["match_rate_next"])
        for kind in ("hard", "uniform"):
            cands = [(in_b, out_s, ov, 1)]
            seen = {(round(in_b), round(out_s), round(ov))}
            tries = 0
            while len(cands) < 16 and tries < 300:
                tries += 1
                ni, no, nv = in_b, out_s, ov
                if kind == "hard":
                    k = rng.integers(0, 3)
                    if k == 0:
                        ni = in_b + rng.choice([-64, -32, -16, -8, -4, -2, -1, 1, 2, 4, 8, 16, 32, 64])
                    elif k == 1:
                        no = out_s + rng.choice([-64, -32, -16, -8, -4, -2, -1, 1, 2, 4, 8, 16, 32, 64])
                    else:
                        nv = float(rng.choice([8, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384])) + fo
                        no = out_end - max(0.0, nv)
                else:
                    ni = float(rng.integers(0, max(1, int(nnext * 0.6))))
                    nv = float(rng.integers(-32, 512)) + fo
                    no = float(rng.integers(int(nprev * 0.3), nprev)) + (out_s - math.floor(out_s))
                if not ok(ni, no, nv):
                    continue
                key = (round(ni), round(no), round(nv))
                if key in seen:
                    continue
                seen.add(key)
                cands.append((ni, no, nv, 0))
            if len(cands) < 8:
                continue
            for ni, no, nv, lab in cands:
                X.append(cue_feats(ni, no, nv, nprev, nnext, r["bpm_prev"], r["bpm_next"]))
                y.append(lab)
                w.append(wt)
                gid.append(g)
                split.append(r["_split"])
                gkind.append(kind)
            g += 1
    return np.asarray(X, np.float32), np.asarray(y), np.asarray(w, np.float32), np.asarray(gid), np.asarray(split), np.asarray(gkind)


def group_sizes(gid):
    _, idx, counts = np.unique(gid, return_index=True, return_counts=True)
    order = np.argsort(idx)
    return counts[order]


def rank_metrics(scores, y, gid):
    """Ties are broken PESSIMISTICALLY (the positive ranks below every equal-scored negative)."""
    top1, rr, ndcg3 = [], [], []
    for g in np.unique(gid):
        m = gid == g
        s, t = scores[m], y[m]
        if t.sum() != 1:
            continue
        sp = s[t == 1][0]
        pos = int((s[t == 0] >= sp).sum())
        top1.append(pos == 0)
        rr.append(1 / (pos + 1))
        ndcg3.append(1 / math.log2(pos + 2) if pos < 3 else 0.0)
    return {"groups": len(top1), "top1": float(np.mean(top1)), "mrr": float(np.mean(rr)), "ndcg@3": float(np.mean(ndcg3)),
            "chance_top1": float(np.mean([1 / max(1, (gid == g).sum()) for g in np.unique(gid)]))}


def ece(p, y, bins=10):
    e = 0.0
    for b in range(bins):
        m = (p >= b / bins) & (p < (b + 1) / bins + (1e-9 if b == bins - 1 else 0))
        if m.sum():
            e += m.mean() * abs(p[m].mean() - y[m].mean())
    return float(e)


def shuffle_within_groups(X, y, w, gid, split, *extra, seed=SEED):
    """Random order inside each group (groups stay contiguous) so no model or metric can exploit
    the position of the positive."""
    rng = np.random.default_rng(seed)
    keys = rng.random(len(y))
    order = np.lexsort((keys, gid))
    return (X[order], y[order], w[order], gid[order], split[order], *[e[order] for e in extra])


def fit_rankers(X, y, w, gid, split, names, rule_fn, tag):
    res = {}
    tr, va, te = split == "train", split == "val", split == "test"
    # baselines
    rs = np.random.default_rng(0).random(len(y))
    res["random"] = rank_metrics(rs[te], y[te], gid[te])
    res["rule"] = rank_metrics(rule_fn(X[te]), y[te], gid[te])
    sc = StandardScaler().fit(X[tr])
    lr = LogisticRegression(max_iter=2000, C=1.0).fit(sc.transform(X[tr]), y[tr], sample_weight=w[tr])
    res["logreg"] = rank_metrics(lr.decision_function(sc.transform(X[te])), y[te], gid[te])
    params = dict(objective="lambdarank", metric="ndcg", eval_at=[1, 3], learning_rate=0.05, num_leaves=31, min_data_in_leaf=50,
                  feature_fraction=0.9, bagging_fraction=0.8, bagging_freq=1, lambdarank_truncation_level=8, seed=SEED, verbose=-1)
    dtr = lgb.Dataset(X[tr], y[tr], weight=w[tr], group=group_sizes(gid[tr]), feature_name=names)
    dva = lgb.Dataset(X[va], y[va], weight=w[va], group=group_sizes(gid[va]), reference=dtr)
    t0 = time.time()
    bst = lgb.train(params, dtr, 2000, valid_sets=[dva], callbacks=[lgb.early_stopping(100, verbose=False)])
    train_s = time.time() - t0
    res["lightgbm"] = rank_metrics(bst.predict(X[te], num_iteration=bst.best_iteration), y[te], gid[te])
    res["lightgbm"]["best_iteration"] = bst.best_iteration
    res["lightgbm"]["train_seconds"] = round(train_s, 1)
    # calibrated probability model (binary) for runtime use + calibration report
    pb = dict(objective="binary", learning_rate=0.05, num_leaves=31, min_data_in_leaf=50, feature_fraction=0.9, seed=SEED, verbose=-1)
    bb = lgb.train(pb, lgb.Dataset(X[tr], y[tr], weight=w[tr], feature_name=names), 2000,
                   valid_sets=[lgb.Dataset(X[va], y[va], weight=w[va])], callbacks=[lgb.early_stopping(100, verbose=False)])
    p = bb.predict(X[te], num_iteration=bb.best_iteration)
    res["lightgbm_binary"] = {**rank_metrics(p, y[te], gid[te]), "ece": ece(p, y[te]), "base_rate": float(y[te].mean())}
    imp = dict(zip(names, bst.feature_importance("gain").round(1).tolist()))
    res["importance_gain"] = dict(sorted(imp.items(), key=lambda kv: -kv[1])[:12])
    os.makedirs(OUT, exist_ok=True)
    bst.save_model(os.path.join(OUT, f"{tag}_lambdarank.txt"), num_iteration=bst.best_iteration)
    json.dump(bst.dump_model(num_iteration=bst.best_iteration), open(os.path.join(OUT, f"{tag}_lambdarank.json"), "w"))
    bb.save_model(os.path.join(OUT, f"{tag}_binary.txt"), num_iteration=bb.best_iteration)
    json.dump(bb.dump_model(num_iteration=bb.best_iteration), open(os.path.join(OUT, f"{tag}_binary.json"), "w"))
    return res, bst


# ───────────────────────── sequencing ─────────────────────────
SEQ_FEATURES = ["tempo_dev", "bpm_prev", "bpm_next", "len_ratio_log", "n_beats_next_log", "tempo_cv_next",
                "genre_cos", "genre_known", "cooc_ab", "cooc_mix", "deg_b_log", "adamic_adar", "b_seen"]


def seq_data(rows, tracks, rng):
    # Graph statistics come from the GRAPH half of the training mixes only; training examples
    # come from the other half (otherwise every training positive would see its own edge).
    gh = lambda mid: int(hashlib.sha256(f"cp-graph-half:{mid}".encode()).hexdigest()[:8], 16) % 2 == 0
    for r in rows:
        if r["_split"] == "train" and gh(r["mix_id"]):
            r["_split"] = "graph"
    train_rows = [r for r in rows if r["_split"] == "graph"]
    # graph statistics from TRAIN mixes only
    trans = defaultdict(int)
    mixmates = defaultdict(set)
    deg = defaultdict(int)
    nbr = defaultdict(set)
    tgen = defaultdict(lambda: np.zeros(20))
    by_mix = defaultdict(list)
    for r in rows:
        by_mix[r["mix_id"]].append(r)
    for r in train_rows:
        a, b = r["track_id_prev"], r["track_id_next"]
        trans[(a, b)] += 1
        deg[a] += 1
        deg[b] += 1
        nbr[a].add(b)
        nbr[b].add(a)
        g = np.asarray(r["genres"], float)
        tgen[a] += g
        tgen[b] += g
    for m, rs in by_mix.items():
        if rs[0]["_split"] != "graph":
            continue
        ids = {x["track_id_prev"] for x in rs} | {x["track_id_next"] for x in rs}
        for t in ids:
            mixmates[t] |= ids - {t}
    catalog = list(tracks.keys())
    cat_bpm = np.asarray([tracks[t]["bpm"] for t in catalog])

    def feats(a, b, mix_genre):
        ta, tb = tracks[a], tracks[b]
        ga, gb = tgen.get(a), tgen.get(b)
        gvec_b = gb if gb is not None and gb.sum() > 0 else None
        gq = np.asarray(mix_genre, float)
        cos = float(gq @ gvec_b / (np.linalg.norm(gq) * np.linalg.norm(gvec_b) + 1e-9)) if gvec_b is not None and gq.sum() > 0 else 0.0
        aa = sum(1 / math.log(1 + deg[z]) for z in (nbr.get(a, set()) & nbr.get(b, set())) if deg[z] > 0)
        return [tempo_dev(ta["bpm"], tb["bpm"]), ta["bpm"], tb["bpm"], abs(math.log(tb["n_beats"] / ta["n_beats"])), math.log1p(tb["n_beats"]),
                tb["tempo_cv"], cos, float(gvec_b is not None), float(trans.get((a, b), 0)), float(b in mixmates.get(a, set())),
                math.log1p(deg.get(b, 0)), aa, float(deg.get(b, 0) > 0)]

    X, y, gid, split, cold, ids = [], [], [], [], [], []
    for gi, r in enumerate(rows):
        if r["_split"] == "graph" or (r["_split"] == "train" and rng.random() > 0.7):  # graph half never yields examples
            continue
        a, b = r["track_id_prev"], r["track_id_next"]
        mates = [x for x in ({q["track_id_next"] for q in by_mix[r["mix_id"]]} | {q["track_id_prev"] for q in by_mix[r["mix_id"]]}) if x not in (a, b) and x in tracks]
        rng.shuffle(mates)
        negs = mates[:9]
        bpm = tracks[a]["bpm"]
        near = np.where(np.abs(cat_bpm / bpm - 1) < 0.08)[0]
        while len(negs) < 19 and len(near):
            c = catalog[int(near[rng.integers(0, len(near))])]
            if c not in (a, b) and c not in negs:
                negs.append(c)
        for c, lab in [(b, 1)] + [(n, 0) for n in negs]:
            X.append(feats(a, c, r["genres"]))
            y.append(lab)
            gid.append(gi)
            split.append(r["_split"])
            cold.append(deg.get(b, 0) == 0)
            ids.append((a, c))
    return np.asarray(X, np.float32), np.asarray(y), np.ones(len(y), np.float32), np.asarray(gid), np.asarray(split), np.asarray(cold), np.asarray(ids)


def main():
    rng = np.random.default_rng(SEED)
    rows = [json.loads(l) for l in open(os.path.join(DJM, "transitions.jsonl"), encoding="utf8")]
    rows = [r for r in rows if min(r["match_rate_prev"], r["match_rate_next"]) >= MIN_MATCH]
    for r in rows:
        r["_split"] = split_of(r["dj"])
    tracks = json.load(open(os.path.join(DJM, "tracks.json")))
    report = {"source": "djmix/transitions (HF) + beats-tracks + djmix-dataset.json", "min_match_rate": MIN_MATCH,
              "transitions_used": len(rows), "split_by": "DJ (first MixesDB category)",
              "split_counts": {s: sum(1 for r in rows if r["_split"] == s) for s in ("train", "val", "test")},
              "djs": {s: len({r["dj"] for r in rows if r["_split"] == s}) for s in ("train", "val", "test")}}

    X, y, w, gid, split, gkind = shuffle_within_groups(*cue_groups(rows, rng))
    i = {n: k for k, n in enumerate(CUE_FEATURES)}

    def cue_rule(Xt):  # CrowdPilot-style prior: phrase-aligned cues, ~32-bar overlap, little skipped
        return Xt[:, i["in_m32"]] + Xt[:, i["out_m32"]] - np.abs(Xt[:, i["overlap_log"]] - math.log1p(128)) - 0.3 * Xt[:, i["tail_frac"]]
    res_cue, bc = fit_rankers(X, y, w, gid, split, CUE_FEATURES, cue_rule, "cue")
    te = split == "test"
    sc = StandardScaler().fit(X[split == "train"])
    lr = LogisticRegression(max_iter=2000).fit(sc.transform(X[split == "train"]), y[split == "train"], sample_weight=w[split == "train"])
    for kind in ("hard", "uniform"):
        m = te & (gkind == kind)
        res_cue[f"by_negatives_{kind}"] = {
            "random": rank_metrics(np.random.default_rng(1).random(m.sum()), y[m], gid[m]),
            "rule": rank_metrics(cue_rule(X[m]), y[m], gid[m]),
            "logreg": rank_metrics(lr.decision_function(sc.transform(X[m])), y[m], gid[m]),
            "lightgbm": rank_metrics(bc.predict(X[m], num_iteration=bc.best_iteration), y[m], gid[m]),
        }
    report["cue_task"] = {"examples": int(len(y)), "groups": int(len(np.unique(gid))), "negatives_per_group": 15, **res_cue}
    print(json.dumps(report["cue_task"], indent=1))

    Xs, ys, ws, gs, ss, cold, ids = shuffle_within_groups(*seq_data(rows, tracks, rng))
    j = {n: k for k, n in enumerate(SEQ_FEATURES)}

    def seq_rule(Xt):  # tempo proximity only (what a rule-based planner knows about unseen tracks)
        return -Xt[:, j["tempo_dev"]]
    res_seq, bst = fit_rankers(Xs, ys, ws, gs, ss, SEQ_FEATURES, seq_rule, "seq")
    te = ss == "test"
    sc = bst.predict(Xs[te], num_iteration=bst.best_iteration)
    cold_g = np.unique(gs[te][cold[te]])
    m = np.isin(gs[te], cold_g)
    res_seq["lightgbm_cold_start_next_track"] = rank_metrics(sc[m], ys[te][m], gs[te][m])
    res_seq["rule_cold_start_next_track"] = rank_metrics(seq_rule(Xs[te][m]), ys[te][m], gs[te][m])
    report["seq_task"] = {"examples": int(len(ys)), "groups": int(len(np.unique(gs))), "negatives_per_group": 19, **res_seq}
    print(json.dumps(report["seq_task"], indent=1))
    os.makedirs(OUT, exist_ok=True)
    json.dump(report, open(os.path.join(OUT, "exp1_report.json"), "w"), indent=1)
    np.savez_compressed(os.path.join(OUT, "seq_eval_data.npz"), X=Xs, y=ys, gid=gs, split=ss, cold=cold, ids=ids)
    json.dump({"graph_mixes": sorted({r["mix_id"] for r in rows if r["_split"] == "graph"})}, open(os.path.join(OUT, "graph_half.json"), "w"))


if __name__ == "__main__":
    main()
