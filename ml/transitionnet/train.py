"""Experiment 5 — technique-conditioned TransitionNet (Stages B and C).

Context: the candidate-transition features (src/ml/edge-features.ts: tempo/key/energy/vocal
relations, cue positions and phrase alignment, technique one-hot, overlap length, rule costs).

Heads:
  * B-traj   continuous automation: 11 beat-aligned trajectories × 33 points over the overlap
             (out/in fader, out/in low/mid/high EQ, out/in bipolar filter, echo send) — used for
             the blend techniques (fades, bass swap, long blend, percussion-led, filter sweep).
  * B-param  continuous technique parameters (echo feedback/send/lead, roll riser depth, brake
             start/length, scratch start/length/strokes, drop-swap filter) for the creative
             techniques; event timing (the slam beat) stays structural.
  * A-echo   discrete echo subdivision (¼, ½, ¾, 1 beat); A-roll discrete roll slice pattern.

Stage B (synthetic supervised): teacher = the render-verified best control set among the
template and its musically constrained variants for each candidate (Experiment 4), soft-weighted
by objective severity; only candidates whose best render passes the quality gate (sObj < 0.6)
teach. Stage C (render-aware): a differentiable surrogate Q(context, controls) → sObj is fitted
to every rendered control set; TransitionNet is then fine-tuned to minimise Q(context, TN(context))
while staying close to the teacher (control realism). Both stages are verified by actually
rendering the predicted controls on held-out tracks (evaluation/ml/pipeline.eval.ts).

    python -m ml.transitionnet.train
"""
from __future__ import annotations

import glob
import json
import os
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

ROOT = os.environ.get("CP_DATA_ROOT", r"C:\crowdpilot-data")
SYN = os.environ.get("CP_SYNTH", os.path.join(ROOT, "ml", "synth"))
OUT = os.path.join(ROOT, "ml", "models", "transitionnet")
PUBLIC = os.path.join(os.path.dirname(__file__), "..", "..", "public", "models", "ml")
SEED = 20261122
torch.manual_seed(SEED)

CH = ["outGain", "inGain", "outLow", "inLow", "outMid", "inMid", "outHigh", "inHigh", "filterOut", "filterIn", "echoSend"]
NP = 33
PARAMS = [("echoDelayBeats", 0.25, 1), ("echoFeedback", 0.2, 0.85), ("echoSend", 0.3, 1), ("echoLead", 0.5, 3.5), ("rollFilter", 0, 0.95), ("rollPattern", 0, 3),
          ("brakeAt", 0, 3), ("brakeBeats", 0.5, 3.5), ("scratchAt", 0, 2.5), ("scratchBeats", 1, 3.5), ("scratchStrokes", 2, 10), ("dropFilter", -0.95, 0)]
ECHO_SUBS = [0.25, 0.5, 0.75, 1.0]
TRAJ_STYLES = {"short_fade", "long_blend", "bass_swap", "percussion_led", "unmatched_fade", "filter_sweep"}
PARAM_STYLES = {"echo_out", "loop_roll", "brake", "scratch_cut", "drop_swap"}
GATE = 0.6
TAU = 0.05


def load():
    rows = []
    for f in sorted(glob.glob(os.path.join(SYN, "shard*.jsonl"))):
        rows += [json.loads(l) for l in open(f)]
    return rows


def traj_vec(t):
    return np.concatenate([np.asarray(t[c], np.float32) for c in CH])


def param_vec(p):
    lo = np.asarray([a for _, a, _ in PARAMS], np.float32)
    hi = np.asarray([b for _, _, b in PARAMS], np.float32)
    v = np.asarray([p[n] for n, _, _ in PARAMS], np.float32)
    return (v - lo) / (hi - lo)  # normalised 0..1


SMOOTH = 4.0  # weight of the trajectory roughness penalty (second differences, faders/EQ)


def rough(t):
    """Mean |second difference| of the 8 fader/EQ channels — same metric as controls.ts roughness()."""
    v = t.view(-1, len(CH), NP)[:, :8]
    return (v[:, :, 2:] - 2 * v[:, :, 1:-1] + v[:, :, :-2]).abs().mean((1, 2))


def build(rows):
    groups = {}
    for r in rows:
        if r["kind"] == "defect" or r["style"] not in TRAJ_STYLES | PARAM_STYLES:
            continue
        groups.setdefault((r["pair"], r["cand"]), []).append(r)
    ctx, tgt_traj, tgt_par, tgt_echo, tgt_roll, m_traj, m_par, split, best_s, tmpl_s, styles = [], [], [], [], [], [], [], [], [], [], []
    sur_x, sur_c, sur_y, sur_split = [], [], [], []
    for items in groups.values():
        style = items[0]["style"]
        s = np.asarray([r["obj"]["sObj"] for r in items], np.float32)
        for r in items:  # surrogate data: every rendered control set
            tv = traj_vec(r["traj"]) if r["traj"] else np.zeros(len(CH) * NP, np.float32)
            pv = param_vec(r["params"]) if r["params"] else np.zeros(len(PARAMS), np.float32)
            sur_x.append(r["edge"])
            sur_c.append(np.concatenate([tv, pv, [float(style in TRAJ_STYLES)]]).astype(np.float32))
            sur_y.append(r["obj"]["sObj"])
            sur_split.append(r["split"])
        if s.min() >= GATE:
            continue  # no control set passes the quality gate → this candidate does not teach
        w = np.exp(-(s - s.min()) / TAU)
        w /= w.sum()
        tmpl = [r for r in items if r["kind"] == "template"]
        ctx.append(items[0]["edge"])
        split.append(items[0]["split"])
        styles.append(style)
        best_s.append(float(s.min()))
        tmpl_s.append(float(tmpl[0]["obj"]["sObj"]) if tmpl else np.nan)
        if style in TRAJ_STYLES:
            tgt_traj.append(sum(wi * traj_vec(r["traj"]) for wi, r in zip(w, items)))
            m_traj.append(1.0)
        else:
            tgt_traj.append(np.zeros(len(CH) * NP, np.float32))
            m_traj.append(0.0)
        if style in PARAM_STYLES and all(r["params"] for r in items):
            tgt_par.append(sum(wi * param_vec(r["params"]) for wi, r in zip(w, items)))
            best = items[int(np.argmin(s))]["params"]
            tgt_echo.append(int(np.argmin([abs(e - best["echoDelayBeats"]) for e in ECHO_SUBS])))
            tgt_roll.append(int(round(min(3, max(0, best["rollPattern"])))))
            m_par.append(1.0)
        else:
            tgt_par.append(np.zeros(len(PARAMS), np.float32))
            tgt_echo.append(0)
            tgt_roll.append(0)
            m_par.append(0.0)
    T = lambda a, dt=torch.float32: torch.tensor(np.asarray(a), dtype=dt)
    data = dict(ctx=T(ctx), traj=T(tgt_traj), par=T(tgt_par), echo=T(tgt_echo, torch.long), roll=T(tgt_roll, torch.long), m_traj=T(m_traj), m_par=T(m_par),
                split=np.asarray(split), best_s=np.asarray(best_s), tmpl_s=np.asarray(tmpl_s), styles=np.asarray(styles))
    sur = dict(x=T(sur_x), c=T(sur_c), y=T(sur_y), split=np.asarray(sur_split))
    return data, sur


class TransitionNet(nn.Module):
    def __init__(self, d_in, hid=128):
        super().__init__()
        self.trunk = nn.Sequential(nn.Linear(d_in, hid), nn.ReLU(), nn.Linear(hid, hid), nn.ReLU())
        self.traj = nn.Linear(hid, len(CH) * NP)
        self.par = nn.Linear(hid, len(PARAMS))
        self.echo = nn.Linear(hid, len(ECHO_SUBS))
        self.roll = nn.Linear(hid, 4)

    def forward(self, x):
        h = self.trunk(x)
        t = self.traj(h).view(-1, len(CH), NP)
        # channel ranges: faders/EQ/echo in [0,1] (sigmoid), filters in [−1,1] (tanh)
        filt = torch.zeros(len(CH), dtype=torch.bool)
        filt[CH.index("filterOut")] = True
        filt[CH.index("filterIn")] = True
        t = torch.where(filt[None, :, None], torch.tanh(t), torch.sigmoid(t)).reshape(-1, len(CH) * NP)
        return t, torch.sigmoid(self.par(h)), self.echo(h), self.roll(h)


class Surrogate(nn.Module):
    def __init__(self, d_in, d_c, hid=256):
        super().__init__()
        self.net = nn.Sequential(nn.Linear(d_in + d_c, hid), nn.ReLU(), nn.Linear(hid, hid), nn.ReLU(), nn.Linear(hid, 1))

    def forward(self, x, c):
        return torch.sigmoid(self.net(torch.cat([x, c], -1))).squeeze(-1)


def export_dense(lin: nn.Linear, act: str):
    return {"nIn": lin.in_features, "nOut": lin.out_features, "W": lin.weight.detach().numpy().reshape(-1).round(6).tolist(),
            "b": lin.bias.detach().numpy().round(6).tolist(), "act": act}


def main():
    rows = load()
    data, sur = build(rows)
    x = data["ctx"]
    mean, std = x[data["split"] == "train"].mean(0), x[data["split"] == "train"].std(0) + 1e-6
    xn = (x - mean) / std
    sx = (sur["x"] - mean) / std
    tr, va, te = (data["split"] == s for s in ("train", "val", "test"))
    rep = {"data": {"teaching_candidates": int(len(x)), "by_split": {s: int((data["split"] == s).sum()) for s in ("train", "val", "test")},
                    "traj_candidates": int(data["m_traj"].sum()), "param_candidates": int(data["m_par"].sum()), "surrogate_renders": int(len(sur["y"])),
                    "quality_gate_sObj_lt": GATE, "teacher_temperature": TAU}}

    # ── Stage B: supervised on render-verified teachers ──
    model = TransitionNet(x.shape[1])
    opt = torch.optim.AdamW(model.parameters(), lr=2e-3, weight_decay=1e-4)

    def loss_b(idx):
        t, p, e, r = model(xn[idx])
        mt, mp = data["m_traj"][idx], data["m_par"][idx]
        lt = ((t - data["traj"][idx]) ** 2).mean(1)
        lp = ((p - data["par"][idx]) ** 2).mean(1)
        le = F.cross_entropy(e, data["echo"][idx], reduction="none")
        lr = F.cross_entropy(r, data["roll"][idx], reduction="none")
        return ((lt * mt).sum() + SMOOTH * 0.01 * (rough(t) * mt).sum() + (lp * mp).sum() + 0.05 * ((le + lr) * mp).sum()) / max(1.0, float(len(idx)))

    tri, vai = np.where(tr)[0], np.where(va)[0]
    best, state, bad = 1e9, None, 0
    t0 = time.time()
    for ep in range(400):
        model.train()
        perm = np.random.default_rng(ep).permutation(tri)
        for k in range(0, len(perm), 128):
            l = loss_b(torch.tensor(perm[k:k + 128]))
            opt.zero_grad()
            l.backward()
            opt.step()
        model.eval()
        with torch.no_grad():
            v = float(loss_b(torch.tensor(vai)))
        if v < best - 1e-5:
            best, state, bad = v, {k: t.clone() for k, t in model.state_dict().items()}, 0
        else:
            bad += 1
            if bad > 25:
                break
    model.load_state_dict(state)
    rep["stage_b"] = {"epochs": ep + 1, "best_val_loss": best, "seconds": round(time.time() - t0, 1)}

    # baseline: how far the teachers are from the hand templates (does the teacher even differ?)
    # ── Stage C: surrogate quality model and render-aware fine-tuning ──
    sur_model = Surrogate(x.shape[1], sur["c"].shape[1])
    so = torch.optim.AdamW(sur_model.parameters(), lr=1e-3, weight_decay=1e-4)
    s_tr, s_va = np.where(sur["split"] == "train")[0], np.where(sur["split"] == "val")[0]
    sb, sstate, bad = 1e9, None, 0
    for ep in range(300):
        perm = np.random.default_rng(ep + 1000).permutation(s_tr)
        sur_model.train()
        for k in range(0, len(perm), 256):
            i = torch.tensor(perm[k:k + 256])
            l = F.mse_loss(sur_model(sx[i], sur["c"][i]), sur["y"][i])
            so.zero_grad()
            l.backward()
            so.step()
        sur_model.eval()
        with torch.no_grad():
            v = float(F.mse_loss(sur_model(sx[s_va], sur["c"][s_va]), sur["y"][s_va]))
        if v < sb - 1e-6:
            sb, sstate, bad = v, {k: t.clone() for k, t in sur_model.state_dict().items()}, 0
        else:
            bad += 1
            if bad > 20:
                break
    sur_model.load_state_dict(sstate)
    s_te = np.where(sur["split"] == "test")[0]
    with torch.no_grad():
        ps = sur_model(sx[s_te], sur["c"][s_te]).numpy()
    from scipy.stats import spearmanr
    rep["surrogate"] = {"val_mse": sb, "test_spearman": float(spearmanr(ps, sur["y"][s_te].numpy()).statistic)}

    for p in sur_model.parameters():
        p.requires_grad_(False)
    base_state = {k: t.clone() for k, t in model.state_dict().items()}

    def controls(t, p, styles_mask):
        return torch.cat([t * styles_mask[:, None], p * (1 - styles_mask[:, None]), styles_mask[:, None]], -1)

    is_traj = data["m_traj"]
    lam = 2.0
    opt = torch.optim.AdamW(model.parameters(), lr=3e-4)

    def loss_c(idx):
        t, p, e, r = model(xn[idx])
        q = sur_model(xn[idx], controls(t, p, is_traj[idx])).mean()
        stay = (((t - data["traj"][idx]) ** 2).mean(1) * is_traj[idx]).mean() + (((p - data["par"][idx]) ** 2).mean(1) * data["m_par"][idx]).mean()
        smooth = (rough(t) * is_traj[idx]).mean()
        return q + lam * stay + SMOOTH * smooth, q

    with torch.no_grad():
        _, q_before = loss_c(torch.tensor(vai))
    best_c, cstate = 1e9, None
    for ep in range(60):
        model.train()
        perm = np.random.default_rng(ep + 5000).permutation(tri)
        for k in range(0, len(perm), 128):
            l, _ = loss_c(torch.tensor(perm[k:k + 128]))
            opt.zero_grad()
            l.backward()
            opt.step()
        model.eval()
        with torch.no_grad():
            lv, qv = loss_c(torch.tensor(vai))
        if float(lv) < best_c:
            best_c, cstate, q_after = float(lv), {k: t.clone() for k, t in model.state_dict().items()}, float(qv)
    model.load_state_dict(cstate)
    with torch.no_grad():
        tt, *_ = model(xn[torch.tensor(vai)])
        rep["val_roughness"] = {"teacher": float((rough(data["traj"][torch.tensor(vai)]) * is_traj[torch.tensor(vai)]).sum() / max(1, is_traj[torch.tensor(vai)].sum())),
                                "model": float((rough(tt) * is_traj[torch.tensor(vai)]).sum() / max(1, is_traj[torch.tensor(vai)].sum()))}
    rep["stage_c"] = {"surrogate_val_quality_before": float(q_before), "surrogate_val_quality_after": q_after, "realism_weight": lam,
                      "note": "surrogate-predicted severity on validation contexts (lower is better); verified by real renders in pipeline.eval.ts"}

    os.makedirs(OUT, exist_ok=True)
    torch.save({"stage_b": base_state, "stage_c": model.state_dict(), "mean": mean, "std": std}, os.path.join(OUT, "transitionnet.pt"))
    torch.save(sstate, os.path.join(OUT, "surrogate.pt"))
    version = time.strftime("%Y%m%d")

    def export(state, name):
        model.load_state_dict(state)
        m = {"kind": "mlp", "name": name, "version": version, "inputs": [f"edge{i}" for i in range(x.shape[1])],
             "inMean": mean.numpy().round(6).tolist(), "inStd": std.numpy().round(6).tolist(),
             "trunk": [export_dense(model.trunk[0], "relu"), export_dense(model.trunk[2], "relu")],
             "heads": {"traj": [export_dense(model.traj, "linear")], "params": [export_dense(model.par, "sigmoid")],
                       "echoSub": [export_dense(model.echo, "linear")], "rollPattern": [export_dense(model.roll, "linear")]},
             "channels": CH, "points": NP, "paramSpec": PARAMS, "echoSubs": ECHO_SUBS}
        os.makedirs(PUBLIC, exist_ok=True)
        s = json.dumps(m, separators=(",", ":"))
        open(os.path.join(PUBLIC, f"{name}.json"), "w").write(s)
        import hashlib
        # parity fixture: raw inputs → python outputs
        sel = np.where(te)[0][:20]
        with torch.no_grad():
            t, p, e, r = model(xn[sel])
        fx = os.path.join(os.path.dirname(__file__), "..", "..", "src", "ml", "__fixtures__")
        os.makedirs(fx, exist_ok=True)
        json.dump({"X": x[sel].numpy().round(6).tolist(), "traj": t.numpy().round(6).tolist(), "params": p.numpy().round(6).tolist(),
                   "echoSub": e.numpy().round(6).tolist()}, open(os.path.join(fx, f"{name}.json"), "w"))
        return hashlib.sha256(s.encode()).hexdigest()

    rep["export"] = {"transitionnet_b": export(base_state, "transitionnet_b"), "transitionnet": export(cstate, "transitionnet")}
    json.dump(rep, open(os.path.join(OUT, "exp5_report.json"), "w"), indent=1)
    print(json.dumps(rep, indent=1))


if __name__ == "__main__":
    main()
