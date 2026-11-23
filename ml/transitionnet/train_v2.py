"""TransitionNet v2 — long-form performance proposer (strategy + stage/shape parameters + cue shift).

Data: evaluation/ml/synth_v2.eval.ts — synthetic KNOWN-CONTROL renders. For each long-form window
(16–64 bars, beat-matched pairs of the private evaluation corpora) several strategies × parameter
vectors × incoming cue shifts were rendered with the production renderer at 16 kHz and measured with
the explicit closed-loop audio metrics (src/mixgen/audio-quality.ts; lower = better, hard failures
ranked last). Splits are track-level (common.splitOf): no track appears in two splits.

Targets per window (imitation of the render-verified best controls):
  strategy  soft distribution over the strategies that were tried: p ∝ exp(−(best_s − best)/τ)
  params    the controls of the best render (neutral or randomised)
  cueShift  soft distribution over the tried incoming cue shifts {−8, 0, +8 bars}

Model: 2×32 ReLU trunk (weight decay 3e-2), heads strategy (7, linear), params (12, sigmoid), cueShift (3, linear).
Selection by validation loss; the held-out TEST verdict comes from actually rendering the proposals
(evaluation/ml/v2_holdout.eval.ts), not from this script.

    python -m ml.transitionnet.train_v2
"""
from __future__ import annotations

import glob
import json
import os
import random
import time

import numpy as np
import torch
import torch.nn as nn

ROOT = os.environ.get("CP_DATA_ROOT", r"C:\crowdpilot-data")
DATA = os.path.join(ROOT, "ml", os.environ.get("V2_DIR", "synth_v2"))
OUT = os.path.join(ROOT, "ml", "models", "transitionnet_v2")
PUBLIC = os.path.join(os.path.dirname(__file__), "..", "..", "public", "models", "ml")
STRATEGIES = ["layered_blend", "percussion_build", "vocal_handoff", "filter_ride", "echo_handoff", "stem_mashup", "drop_lock"]
SHIFTS = [-8, 0, 8]
TAU = 0.15


def load():
    rows = []
    for f in sorted(glob.glob(os.path.join(DATA, "shard*.jsonl"))):
        for line in open(f, encoding="utf8"):
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def rank(r):
    return r["score"] + (100.0 if r["hardFail"] else 0.0)


def build(rows):
    by = {}
    for r in rows:
        by.setdefault(r["window"], []).append(r)
    samples = []
    for w, vs in by.items():
        if len(vs) < 4:
            continue
        best = min(vs, key=rank)
        base = [v for v in vs if v["cueShift"] == 0]
        strat_best = {}
        for v in base:
            s = v["strategy"]
            strat_best[s] = min(strat_best.get(s, 1e9), rank(v))
        tried = np.zeros(len(STRATEGIES), dtype=np.float32)
        logits = np.full(len(STRATEGIES), -1e9, dtype=np.float64)
        m = min(strat_best.values())
        for s, rk in strat_best.items():
            i = STRATEGIES.index(s)
            tried[i] = 1
            logits[i] = -(rk - m) / TAU
        p = np.exp(logits - logits.max())
        p = p / p.sum()
        # cue shift: compare the shifted neutral renders with the unshifted neutral render of the same strategy
        ref = [v for v in base if v["strategy"] == vs[0]["feasible"][0] and all(abs(x - 0.5) < 1e-6 for x in v["params"])]
        shift_best = {0: rank(ref[0])} if ref else {}
        for v in vs:
            if v["cueShift"] != 0:
                shift_best[v["cueShift"]] = min(shift_best.get(v["cueShift"], 1e9), rank(v))
        sl = np.full(3, -1e9)
        if shift_best:
            ms = min(shift_best.values())
            for sh, rk in shift_best.items():
                sl[SHIFTS.index(sh)] = -(rk - ms) / TAU
        else:
            sl[1] = 0
        ps = np.exp(sl - sl.max())
        ps = ps / ps.sum()
        best_base = min(base, key=rank) if base else best
        samples.append({
            "window": w, "split": vs[0]["split"], "x": np.array(vs[0]["x"], dtype=np.float32),
            "p": p.astype(np.float32), "tried": tried, "params": np.array(best_base["params"], dtype=np.float32),
            "ps": ps.astype(np.float32), "best": rank(best), "n": len(vs),
        })
    return samples


class Net(nn.Module):
    def __init__(self, d_in, hid=32):
        super().__init__()
        self.trunk = nn.Sequential(nn.Linear(d_in, hid), nn.ReLU(), nn.Linear(hid, hid), nn.ReLU())
        self.strategy = nn.Linear(hid, len(STRATEGIES))
        self.par = nn.Linear(hid, 12)
        self.shift = nn.Linear(hid, 3)

    def forward(self, x):
        h = self.trunk(x)
        return self.strategy(h), torch.sigmoid(self.par(h)), self.shift(h)


def export_dense(lin: nn.Linear, act: str):
    return {"nIn": lin.in_features, "nOut": lin.out_features, "W": lin.weight.detach().numpy().reshape(-1).round(6).tolist(),
            "b": lin.bias.detach().numpy().round(6).tolist(), "act": act}


def main():
    torch.manual_seed(7)
    random.seed(7)
    rows = load()
    samples = build(rows)
    split = {k: [s for s in samples if s["split"] == k] for k in ("train", "val", "test")}
    print({k: len(v) for k, v in split.items()}, "windows;", len(rows), "renders")
    if len(split["train"]) < 20:
        raise SystemExit("not enough training windows")
    X = lambda ss: torch.tensor(np.stack([s["x"] for s in ss]))
    Xtr = X(split["train"])
    mean = Xtr.mean(0)
    std = Xtr.std(0).clamp_min(1e-3)
    norm = lambda x: (x - mean) / std

    def tensors(ss):
        return (norm(X(ss)), torch.tensor(np.stack([s["p"] for s in ss])), torch.tensor(np.stack([s["tried"] for s in ss])),
                torch.tensor(np.stack([s["params"] for s in ss])), torch.tensor(np.stack([s["ps"] for s in ss])))

    tr = tensors(split["train"])
    va = tensors(split["val"]) if split["val"] else tr
    net = Net(Xtr.shape[1])
    opt = torch.optim.AdamW(net.parameters(), lr=1e-3, weight_decay=3e-2)

    def loss_of(t):
        x, p, tried, par, ps = t
        lg, pp, sl = net(x)
        lg = lg.masked_fill(tried < 0.5, -1e9)
        l_s = -(p * torch.log_softmax(lg, -1).clamp_min(-1e4)).sum(-1).mean()
        l_p = ((pp - par) ** 2).mean()
        l_c = -(ps * torch.log_softmax(sl, -1)).sum(-1).mean()
        return l_s + 0.2 * l_p + 0.3 * l_c, (l_s.item(), l_p.item(), l_c.item())

    best = (1e9, None, 0)
    for ep in range(3000):
        net.train()
        opt.zero_grad()
        l, _ = loss_of(tr)
        l.backward()
        opt.step()
        net.eval()
        with torch.no_grad():
            lv, parts = loss_of(va)
        if lv.item() < best[0] - 1e-4:
            best = (lv.item(), {k: v.clone() for k, v in net.state_dict().items()}, ep)
        if ep - best[2] > 300:
            break
    net.load_state_dict(best[1])
    net.eval()

    # offline diagnostics: strategy agreement with the render-verified best (val/test), vs the rule order
    def agree(ss):
        if not ss:
            return None
        t = tensors(ss)
        with torch.no_grad():
            lg, _, _ = net(t[0])
            lg = lg.masked_fill(t[2] < 0.5, -1e9)
        pred = lg.argmax(-1).numpy()
        target = t[1].argmax(-1).numpy()
        return float((pred == target).mean())

    report = {
        "model": "transitionnet_v2", "version": time.strftime("%Y%m%d"), "trained": time.strftime("%Y-%m-%d %H:%M"),
        "hardware": "local CPU (Intel, no CUDA)", "renders": len(rows), "windows": {k: len(v) for k, v in split.items()},
        "best_epoch": best[2], "val_loss": round(best[0], 4),
        "strategy_agreement": {"val": agree(split["val"]), "test": agree(split["test"])},
        "note": "Offline agreement only; the held-out verdict is the rendered comparison in evaluation/ml/v2_holdout.eval.ts.",
    }
    os.makedirs(OUT, exist_ok=True)
    model = {
        "kind": "mlp", "name": "transitionnet_v2", "version": report["version"],
        "inputs": [f"f{i}" for i in range(Xtr.shape[1])],
        "inMean": mean.numpy().round(6).tolist(), "inStd": std.numpy().round(6).tolist(),
        "trunk": [export_dense(net.trunk[0], "relu"), export_dense(net.trunk[2], "relu")],
        "heads": {"strategy": [export_dense(net.strategy, "linear")], "params": [export_dense(net.par, "sigmoid")], "cueShift": [export_dense(net.shift, "linear")]},
        "strategies": STRATEGIES, "cueShifts": SHIFTS,
    }
    json.dump(model, open(os.path.join(OUT, "transitionnet_v2.json"), "w"))
    if os.environ.get("V2_PUBLISH") == "1":  # only after a held-out rendered comparison justifies it
        json.dump(model, open(os.path.join(PUBLIC, "transitionnet_v2.json"), "w"))
    # parity fixture for the TS runtime
    fx = {"x": split["train"][0]["x"].tolist()}
    with torch.no_grad():
        lg, pp, sl = net(norm(torch.tensor(split["train"][0]["x"])[None]))
    fx.update({"strategy": lg[0].numpy().round(6).tolist(), "params": pp[0].numpy().round(6).tolist(), "cueShift": sl[0].numpy().round(6).tolist()})
    fixdir = os.path.join(os.path.dirname(__file__), "..", "..", "src", "ml", "__fixtures__") if os.environ.get("V2_PUBLISH") == "1" else os.path.join(OUT, "fixtures")
    os.makedirs(fixdir, exist_ok=True)
    json.dump(fx, open(os.path.join(fixdir, "transitionnet_v2_parity.json"), "w"))
    json.dump(report, open(os.path.join(OUT, "report.json"), "w"), indent=1)
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
