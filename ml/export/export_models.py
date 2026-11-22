"""Export trained models to the compact JSON formats evaluated by src/ml/gbdt.ts and src/ml/mlp.ts,
and write parity fixtures (inputs + Python outputs) used by the TypeScript parity tests.

    python -m ml.export.export_models
"""
from __future__ import annotations

import hashlib
import json
import os

import lightgbm as lgb
import numpy as np

ROOT = os.environ.get("CP_DATA_ROOT", r"C:\crowdpilot-data")
MODELS = os.path.join(ROOT, "ml", "models")
PUBLIC = os.path.join(os.path.dirname(__file__), "..", "..", "public", "models", "ml")
FIXTURES = os.path.join(os.path.dirname(__file__), "..", "..", "src", "ml", "__fixtures__")


def gbdt_to_compact(booster: lgb.Booster, name: str, version: str, features: list[str]) -> dict:
    d = booster.dump_model()
    trees = []
    for ti in d["tree_info"]:
        f, t, l, r, v = [], [], [], [], []

        def walk(node):
            if "leaf_value" in node or "leaf_index" in node and "split_feature" not in node:
                v.append(float(node.get("leaf_value", 0.0)))
                return ~(len(v) - 1)
            if node.get("decision_type", "<=") != "<=":
                raise ValueError("only numerical <= splits are supported")
            i = len(f)
            f.append(int(node["split_feature"]))
            t.append(float(node["threshold"]))
            l.append(0)
            r.append(0)
            l[i] = walk(node["left_child"])
            r[i] = walk(node["right_child"])
            return i

        root = ti["tree_structure"]
        if "split_feature" not in root:
            v.append(float(root.get("leaf_value", 0.0)))
        else:
            walk(root)
        trees.append({"f": f, "t": t, "l": l, "r": r, "v": v})
    return {"kind": "gbdt", "name": name, "version": version, "objective": d.get("objective", "regression").split(" ")[0],
            "numClass": int(d.get("num_class", 1)), "features": features, "trees": trees}


def write(model: dict, fname: str) -> str:
    os.makedirs(PUBLIC, exist_ok=True)
    s = json.dumps(model, separators=(",", ":"))
    p = os.path.join(PUBLIC, fname)
    open(p, "w").write(s)
    return hashlib.sha256(s.encode()).hexdigest()


def fixture(name: str, X: np.ndarray, y: np.ndarray) -> None:
    os.makedirs(FIXTURES, exist_ok=True)
    json.dump({"X": np.round(X, 6).tolist(), "y": np.asarray(y, float).tolist()}, open(os.path.join(FIXTURES, f"{name}.json"), "w"))
