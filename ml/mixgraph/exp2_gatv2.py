"""Experiment 2 — edge-aware GATv2 MixGraph vs the Experiment-1 LightGBM ranker.

Graph: every djmix track is a node; edges are observed transitions from the GRAPH half of the
training DJs' mixes (the same edges LightGBM's co-occurrence features used; never test DJs).
Node features: tempo, length, tempo stability, genre profile (from graph-half mixes), degree.
Model: 2 × GATv2 layers (Brody et al. 2022, implemented here in plain PyTorch — no
PyTorch Geometric dependency) → node embeddings; an edge scorer MLP over
[h_out, h_in, h_out ⊙ h_in, Exp-1 pair features] produces the transition score.
Training: listwise softmax cross-entropy over the SAME candidate groups as Experiment 1
(true next track vs 19 hard negatives), early stopping on the validation DJs.
Evaluation: the same test groups (held-out DJs), overall and cold-start (true next track not in
the training graph), against LightGBM.

    python -m ml.mixgraph.exp1_lgbm   (writes the shared candidate groups)
    python -m ml.mixgraph.exp2_gatv2
"""
from __future__ import annotations

import json
import math
import os
import time
from collections import defaultdict

import lightgbm as lgb
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from ml.mixgraph.exp1_lgbm import DJM, OUT, SEED, rank_metrics

torch.manual_seed(SEED)


class GATv2Layer(nn.Module):
    """GATv2: e_ij = aᵀ LeakyReLU(W [h_i ‖ h_j]) — attention computed after the nonlinearity."""

    def __init__(self, d_in: int, d_out: int, heads: int = 4):
        super().__init__()
        self.h = heads
        self.d = d_out // heads
        self.wl = nn.Linear(d_in, d_out)
        self.wr = nn.Linear(d_in, d_out)
        self.att = nn.Parameter(torch.randn(heads, self.d) * 0.1)
        self.res = nn.Linear(d_in, d_out)

    def forward(self, x, src, dst):
        n = x.size(0)
        xl = self.wl(x).view(n, self.h, self.d)
        xr = self.wr(x).view(n, self.h, self.d)
        e = F.leaky_relu(xl[src] + xr[dst], 0.2)
        logits = (e * self.att).sum(-1)  # [E, h]
        # softmax over incoming edges of each destination node
        mx = torch.full((n, self.h), -1e9).scatter_reduce(0, dst[:, None].expand(-1, self.h), logits, reduce="amax", include_self=True)
        a = torch.exp(logits - mx[dst])
        den = torch.zeros(n, self.h).index_add_(0, dst, a)
        a = a / (den[dst] + 1e-9)
        msg = xl[src] * a[..., None]
        out = torch.zeros(n, self.h, self.d).index_add_(0, dst, msg).reshape(n, -1)
        return F.elu(out + self.res(x))


class MixGraphGNN(nn.Module):
    def __init__(self, d_node: int, d_edge: int, hid: int = 64):
        super().__init__()
        self.g1 = GATv2Layer(d_node, hid)
        self.g2 = GATv2Layer(hid, hid)
        self.edge_norm = nn.LayerNorm(d_edge)
        self.score = nn.Sequential(nn.Linear(3 * hid + d_edge, 128), nn.ReLU(), nn.Dropout(0.1), nn.Linear(128, 1))

    def forward(self, x, src, dst, a_idx, b_idx, ef):
        h = self.g2(self.g1(x, src, dst), src, dst)
        ha, hb = h[a_idx], h[b_idx]
        return self.score(torch.cat([ha, hb, ha * hb, self.edge_norm(ef)], -1)).squeeze(-1)


def main():
    d = np.load(os.path.join(OUT, "seq_eval_data.npz"), allow_pickle=True)
    X, y, gid, split, cold, ids = d["X"], d["y"], d["gid"], d["split"], d["cold"], d["ids"]
    graph_mixes = set(json.load(open(os.path.join(OUT, "graph_half.json")))["graph_mixes"])
    tracks = json.load(open(os.path.join(DJM, "tracks.json")))
    rows = [json.loads(l) for l in open(os.path.join(DJM, "transitions.jsonl"), encoding="utf8")]
    node_ids = sorted(set(tracks.keys()))
    nid = {t: i for i, t in enumerate(node_ids)}
    deg = defaultdict(int)
    gen = defaultdict(lambda: np.zeros(20, np.float32))
    src, dst = [], []
    for r in rows:
        if r["mix_id"] not in graph_mixes:
            continue
        a, b = r["track_id_prev"], r["track_id_next"]
        if a in nid and b in nid:
            src += [nid[a], nid[b]]
            dst += [nid[b], nid[a]]
            deg[a] += 1
            deg[b] += 1
            gen[a] += np.asarray(r["genres"], np.float32)
            gen[b] += np.asarray(r["genres"], np.float32)
    xs = []
    for t in node_ids:
        tr = tracks[t]
        g = gen.get(t)
        gv = g / max(1.0, g.sum()) if g is not None else np.zeros(20, np.float32)
        xs.append([tr["bpm"] / 200, math.log1p(tr["n_beats"]) / 7, min(1.0, tr["tempo_cv"] * 10), math.log1p(deg.get(t, 0)), *gv])
    # self loops so every node attends at least to itself
    n = len(node_ids)
    src = torch.tensor(src + list(range(n)))
    dst = torch.tensor(dst + list(range(n)))
    x = torch.tensor(np.asarray(xs, np.float32))
    a_idx = torch.tensor([nid[a] for a, _ in ids])
    b_idx = torch.tensor([nid[b] for _, b in ids])
    ef = torch.tensor(X)
    yt = torch.tensor(y, dtype=torch.float32)
    print(f"nodes {n}, graph edges {len(src) - n}, candidate rows {len(y)}")

    groups = {s: [np.where(gid == g)[0] for g in np.unique(gid[split == s])] for s in ("train", "val", "test")}
    model = MixGraphGNN(x.size(1), X.shape[1])
    opt = torch.optim.AdamW(model.parameters(), lr=2e-3, weight_decay=1e-4)

    def scores_for(idx):
        return model(x, src, dst, a_idx[idx], b_idx[idx], ef[idx])

    def evaluate(s):
        model.eval()
        with torch.no_grad():
            allidx = np.concatenate(groups[s])
            sc = np.zeros(len(y), np.float32)
            sc[allidx] = scores_for(torch.tensor(allidx)).numpy()
        m = np.isin(gid, np.unique(gid[split == s]))
        return sc, rank_metrics(sc[m], y[m], gid[m])

    best, best_state, bad = -1, None, 0
    t0 = time.time()
    rng = np.random.default_rng(SEED)
    for epoch in range(60):
        model.train()
        order = rng.permutation(len(groups["train"]))
        for k in range(0, len(order), 256):
            batch = [groups["train"][i] for i in order[k:k + 256]]
            idx = torch.tensor(np.concatenate(batch))
            s = scores_for(idx)
            loss, off = 0.0, 0
            for gidx in batch:
                ss = s[off:off + len(gidx)]
                tt = yt[idx[off:off + len(gidx)]]
                loss = loss - (F.log_softmax(ss, 0) * tt).sum()
                off += len(gidx)
            loss = loss / len(batch)
            opt.zero_grad()
            loss.backward()
            opt.step()
        _, vm = evaluate("val")
        print(f"epoch {epoch} val mrr {vm['mrr']:.4f} top1 {vm['top1']:.4f} ({time.time() - t0:.0f}s)")
        if vm["mrr"] > best + 1e-4:
            best, bad = vm["mrr"], 0
            best_state = {k: v.clone() for k, v in model.state_dict().items()}
        else:
            bad += 1
            if bad >= 6:
                break
    model.load_state_dict(best_state)
    sc, tm = evaluate("test")
    te = split == "test"
    cg = np.unique(gid[te & cold & (y == 1)])
    mc = np.isin(gid, cg)
    # LightGBM (Exp 1) on the identical groups
    bst = lgb.Booster(model_file=os.path.join(OUT, "seq_binary.txt"))
    lg = bst.predict(X)
    rep = {
        "graph": {"nodes": n, "edges_directed": int(len(src) - n), "source": "graph half of training-DJ mixes"},
        "gatv2": {"test": tm, "test_cold_start": rank_metrics(sc[mc], y[mc], gid[mc]), "best_val_mrr": best, "train_seconds": round(time.time() - t0, 1),
                  "params": sum(p.numel() for p in model.parameters())},
        "lightgbm_binary": {"test": rank_metrics(lg[te], y[te], gid[te]), "test_cold_start": rank_metrics(lg[mc], y[mc], gid[mc])},
    }
    torch.save(best_state, os.path.join(OUT, "gatv2_seq.pt"))
    json.dump(rep, open(os.path.join(OUT, "exp2_report.json"), "w"), indent=1)
    print(json.dumps(rep, indent=1))


if __name__ == "__main__":
    main()
