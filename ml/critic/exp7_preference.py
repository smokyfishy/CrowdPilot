"""Experiment 7 — external human preference data (listener-mix-preference, Gallegos Villarreal MSc).

What the data is: 990 ratings (0–100) by 33 listeners of 20 professionally produced ALTERNATIVE
MIXES of 4 songs (multitrack mix balance), under 3 listening contexts, with per-stimulus acoustic
descriptors (z-scored RMS level, crest factor, stereo width). No audio is distributed in the
repository; no licence is stated (used privately, tables only).

What it is NOT: DJ-transition preferences. We therefore only test whether a pairwise
(Bradley–Terry / pairwise-logistic) preference model over the descriptors it provides predicts
held-out listeners' preferred mix, and whether that signal is strong enough to be a DJCritic
auxiliary output.

    python -m ml.critic.exp7_preference
"""
from __future__ import annotations

import hashlib
import itertools
import json
import os

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression

ROOT = os.environ.get("CP_DATA_ROOT", r"C:\crowdpilot-data")
SRC = os.path.join(ROOT, "raw", "listener_mix_pref")
OUT = os.path.join(ROOT, "ml", "models", "critic")
FEATS = ["z_RMS", "z_CF", "z_SW"]


def main():
    r = pd.read_csv(os.path.join(SRC, "ratings_final.csv"))
    r = r.dropna(subset=["human_rating"] + FEATS)
    parts = sorted(r["participant_id"].unique())
    test_p = {p for p in parts if int(hashlib.sha256(p.encode()).hexdigest()[:8], 16) % 5 == 0}
    # pairwise examples within each trial: x = f(i) − f(j), y = rating_i > rating_j (ties dropped)
    X, y, is_test, trials = [], [], [], []
    for (pid, tid), g in r.groupby(["participant_id", "trial_id"]):
        rows = g[FEATS + ["human_rating"]].to_numpy()
        for i, j in itertools.combinations(range(len(rows)), 2):
            if rows[i, -1] == rows[j, -1]:
                continue
            d = rows[i, :-1] - rows[j, :-1]
            lab = int(rows[i, -1] > rows[j, -1])
            X += [d, -d]
            y += [lab, 1 - lab]
            is_test += [pid in test_p] * 2
            trials += [tid] * 2
    X, y, is_test = np.asarray(X, float), np.asarray(y), np.asarray(is_test)
    bt = LogisticRegression(fit_intercept=False, C=1.0).fit(X[~is_test], y[~is_test])
    pair_acc = float((bt.predict(X[is_test]) == y[is_test]).mean())
    # held-out winner accuracy: highest BT utility vs the listener's top-rated mix per trial
    w = bt.coef_[0]
    hit, n = 0, 0
    for (pid, tid), g in r[r["participant_id"].isin(test_p)].groupby(["participant_id", "trial_id"]):
        u = g[FEATS].to_numpy() @ w
        top = g["human_rating"].to_numpy()
        if (top == top.max()).sum() > 1:
            continue
        hit += int(np.argmax(u) == np.argmax(top))
        n += 1
    rep = {
        "data": {"ratings": int(len(r)), "participants": len(parts), "test_participants": len(test_p), "stimuli": int(r["stimulus_id"].nunique()),
                 "pairwise_examples": int(len(y))},
        "bradley_terry_coefficients": dict(zip(FEATS, w.round(4).tolist())),
        "heldout_pairwise_accuracy": pair_acc,
        "heldout_winner_accuracy": hit / max(1, n),
        "heldout_trials": n,
        "chance_winner_accuracy": 0.2,
        "reference_author_mixed_model_winner_accuracy": 0.302,
        "decision": "",
    }
    strong = rep["heldout_winner_accuracy"] > 0.35 and pair_acc > 0.6
    rep["decision"] = (
        "Not used to rank DJ transitions: the signal is weak (near the authors' own 30 % winner accuracy vs 20 % chance), "
        "it concerns whole-song multitrack mix balance rather than transitions, and only 20 stimuli / 3 global descriptors exist. "
        "Kept as a documented auxiliary result; DJCritic remains an objective-quality model."
        if not strong else
        "Signal strong enough to keep as an auxiliary loudness/crest preference output (domain mismatch noted)."
    )
    os.makedirs(OUT, exist_ok=True)
    json.dump(rep, open(os.path.join(OUT, "exp7_report.json"), "w"), indent=1)
    print(json.dumps(rep, indent=1))


if __name__ == "__main__":
    main()
