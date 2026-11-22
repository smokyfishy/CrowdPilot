"""Experiment 6 — DJCritic: objective transition-quality model trained on actual rendered transitions
with controlled defects (Experiment 4 data).

Inputs: mix-only features of the rendered transition (src/ml/critic-features.ts) + the technique
family (slam / beat-matched) + overlap length. Two heads (separate LightGBM models):
  * quality:  regression of the objective severity sObj (stem-measured alignment, bass collision,
              level dips/bumps, gaps, plus known severities of injected control errors),
  * artifact: probability that the render contains an injected control error.
These are OBJECTIVE / SYNTHETIC labels — not human aesthetic preference.

Split: by track (train / val / test tracks; pairs never cross splits). The test set therefore
contains different songs, not repeated transformations of training songs.

    python -m ml.critic.exp6_critic
"""
from __future__ import annotations

import glob
import json
import os
import time

import lightgbm as lgb
import numpy as np
from scipy.stats import spearmanr
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, roc_auc_score

from ml.export.export_models import fixture, gbdt_to_compact, write

ROOT = os.environ.get("CP_DATA_ROOT", r"C:\crowdpilot-data")
SYN = os.environ.get("CP_SYNTH", os.path.join(ROOT, "ml", "synth"))
OUT = os.path.join(ROOT, "ml", "models", "critic")
SEED = 20261122
CRITIC = ['dipDb', 'bumpDb', 'stepDb', 'prePostDb', 'lowDipDb', 'lowBumpDb', 'highDipDb', 'highBumpDb', 'flamTr', 'flamExcess', 'hatFlamExcess',
          'clarityTr', 'clarityRatio', 'silenceSec', 'gapCount', 'clipFrac', 'peakDb', 'chromaEntExcess', 'chromaChange', 'fluxSpike', 'centroidJump',
          'trSec', 'beatSec']
SLAM = {"echo_out", "loop_roll", "brake", "scratch_cut"}
MATCHED = {"short_fade", "long_blend", "bass_swap", "percussion_led", "drop_swap", "filter_sweep"}
FEATURES = CRITIC + ["slam", "beatmatched", "overlapBars"]


def load_rows():
    rows = []
    for f in sorted(glob.glob(os.path.join(SYN, "shard*.jsonl"))):
        rows += [json.loads(l) for l in open(f)]
    return rows


def featurize(r):
    return r["critic"] + [float(r["style"] in SLAM), float(r["style"] in MATCHED), float(r["overlapBars"])]


def main():
    rows = load_rows()
    X = np.asarray([featurize(r) for r in rows], np.float32)
    y = np.asarray([r["obj"]["sObj"] for r in rows], np.float32)
    art = np.asarray([int(len(r["defects"]) > 0) for r in rows])
    split = np.asarray([r["split"] for r in rows])
    tr, va, te = split == "train", split == "val", split == "test"
    rep = {"data": {"renders": len(rows), "train": int(tr.sum()), "val": int(va.sum()), "test": int(te.sum()),
                    "pairs": len({r["pair"] for r in rows}), "tracks_by_split": {s: len({r["a"] for r in rows if r["split"] == s} | {r["b"] for r in rows if r["split"] == s}) for s in ("train", "val", "test")},
                    "kinds": {k: int(sum(1 for r in rows if r["kind"] == k)) for k in ("template", "variant", "defect")}},
           "supervision": "objective/synthetic (stem metrics + known control errors); NOT human preference"}
    t0 = time.time()
    pq = dict(objective="regression", learning_rate=0.03, num_leaves=31, min_data_in_leaf=30, feature_fraction=0.85, bagging_fraction=0.8, bagging_freq=1, seed=SEED, verbose=-1)
    mq = lgb.train(pq, lgb.Dataset(X[tr], y[tr], feature_name=FEATURES), 3000, valid_sets=[lgb.Dataset(X[va], y[va])], callbacks=[lgb.early_stopping(150, verbose=False)])
    pa = dict(objective="binary", learning_rate=0.03, num_leaves=31, min_data_in_leaf=30, feature_fraction=0.85, bagging_fraction=0.8, bagging_freq=1, seed=SEED, verbose=-1)
    ma = lgb.train(pa, lgb.Dataset(X[tr], art[tr], feature_name=FEATURES), 3000, valid_sets=[lgb.Dataset(X[va], art[va])], callbacks=[lgb.early_stopping(150, verbose=False)])
    train_s = time.time() - t0
    pred = mq.predict(X[te], num_iteration=mq.best_iteration)
    pa_te = ma.predict(X[te], num_iteration=ma.best_iteration)
    # baselines: hand-written defect score and a linear model on the same features
    i = {n: k for k, n in enumerate(FEATURES)}
    rule = lambda Z: (np.clip((Z[:, i["dipDb"]] - 3) / 9, 0, 1) * (1 - Z[:, i["slam"]]) + np.clip((Z[:, i["bumpDb"]] - 2) / 6, 0, 1) + np.clip(Z[:, i["silenceSec"]], 0, 1)
                      + np.clip(Z[:, i["flamExcess"]] * 2, 0, 1) + 5 * Z[:, i["clipFrac"]])
    ridge = Ridge(alpha=1.0).fit(X[tr], y[tr])
    rep["quality_head"] = {
        "best_iteration": mq.best_iteration,
        "test_spearman": float(spearmanr(pred, y[te]).statistic),
        "test_mae": float(mean_absolute_error(y[te], pred)),
        "baseline_rule_spearman": float(spearmanr(rule(X[te]), y[te]).statistic),
        "baseline_ridge_spearman": float(spearmanr(ridge.predict(X[te]), y[te]).statistic),
        "baseline_ridge_mae": float(mean_absolute_error(y[te], ridge.predict(X[te]))),
    }
    rep["artifact_head"] = {"best_iteration": ma.best_iteration, "test_auc": float(roc_auc_score(art[te], pa_te)),
                            "baseline_rule_auc": float(roc_auc_score(art[te], rule(X[te])))}
    # per-defect detection AUC (defect kind vs clean renders), test tracks
    test_rows = [r for r, m in zip(rows, te) if m]
    clean = np.asarray([len(r["defects"]) == 0 for r in test_rows])
    per = {}
    for kind in ("offset", "tempo", "abrupt", "bass", "phrase", "stretch", "echo", "loop", "scratch", "clip"):
        has = np.asarray([any(d["kind"] == kind for d in r["defects"]) for r in test_rows])
        m = has | clean
        if has.sum() >= 10:
            per[kind] = {"n": int(has.sum()), "auc_quality": float(roc_auc_score(has[m], pred[m])), "auc_artifact": float(roc_auc_score(has[m], pa_te[m]))}
    rep["per_defect_test_auc"] = per
    # controlled pairs: same pair + candidate, template vs defective version → critic must rank the defect worse
    by = {}
    for r, p in zip(test_rows, pred):
        by.setdefault((r["pair"], r["cand"]), []).append((r, p))
    wins, total, byk = 0, 0, {}
    for items in by.values():
        tmpl = [p for r, p in items if r["kind"] == "template"]
        if not tmpl:
            continue
        for r, p in items:
            if r["kind"] != "defect":
                continue
            ok = p > tmpl[0]
            wins += ok
            total += 1
            for d in r["defects"]:
                a = byk.setdefault(d["kind"], [0, 0])
                a[0] += ok
                a[1] += 1
    rep["controlled_pairs"] = {"accuracy": wins / max(1, total), "n": total, "by_defect": {k: {"accuracy": a[0] / a[1], "n": a[1]} for k, a in byk.items()}}
    rep["train_seconds"] = round(train_s, 1)
    rep["importance_gain_quality"] = dict(sorted(zip(FEATURES, mq.feature_importance("gain").round(1).tolist()), key=lambda kv: -kv[1])[:12])
    os.makedirs(OUT, exist_ok=True)
    mq.save_model(os.path.join(OUT, "critic_quality.txt"), num_iteration=mq.best_iteration)
    ma.save_model(os.path.join(OUT, "critic_artifact.txt"), num_iteration=ma.best_iteration)
    version = time.strftime("%Y%m%d")
    rep["export"] = {
        "critic_quality": write(gbdt_to_compact(mq, "djcritic-quality", version, FEATURES), "critic_quality.json"),
        "critic_artifact": write(gbdt_to_compact(ma, "djcritic-artifact", version, FEATURES), "critic_artifact.json"),
    }
    sel = np.random.default_rng(0).choice(np.where(te)[0], 50, replace=False)
    fixture("critic_quality", X[sel], mq.predict(X[sel], num_iteration=mq.best_iteration))
    fixture("critic_artifact", X[sel], ma.predict(X[sel], num_iteration=ma.best_iteration))
    json.dump(rep, open(os.path.join(OUT, "exp6_report.json"), "w"), indent=1)
    print(json.dumps(rep, indent=1))


if __name__ == "__main__":
    main()
