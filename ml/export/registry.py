"""Model registry: public/models/ml/registry.json (what the browser loads) + docs-grade details in
C:\\crowdpilot-data\\ml\\models\\registry_full.json (architecture, data, splits, metrics, latency,
deployment status, limitations).

`promoted` decides what production uses ("promoted" mode). A component is promoted only when the
held-out ablation (evaluation/ml/pipeline.eval.ts) shows it improves on the deterministic
baseline; otherwise it stays available in the experimental mode only.

    python -m ml.export.registry --promote mixgraph_quality,critic_quality,...
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import time

ROOT = os.environ.get("CP_DATA_ROOT", r"C:\crowdpilot-data")
PUBLIC = os.path.join(os.path.dirname(__file__), "..", "..", "public", "models", "ml")
MODELS = os.path.join(ROOT, "ml", "models")

FILES = {
    "mixgraph_quality": "mixgraph_quality.json",
    "mixgraph_human_cue": "mixgraph_human_cue.json",
    "transitionnet": "transitionnet.json",
    "critic_quality": "critic_quality.json",
    "critic_artifact": "critic_artifact.json",
}


def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--promote", default="")
    ap.add_argument("--details", default="")
    a = ap.parse_args()
    promote = {x for x in a.promote.split(",") if x}
    reg = {}
    for k, f in FILES.items():
        p = os.path.join(PUBLIC, f)
        if not os.path.exists(p):
            continue
        m = json.load(open(p))
        reg[k] = {"file": f, "sha256": sha(p), "promoted": k in promote, "version": m.get("version", "?"), "bytes": os.path.getsize(p)}
    json.dump(reg, open(os.path.join(PUBLIC, "registry.json"), "w"), indent=1)
    if a.details:
        full = json.load(open(a.details))
        full["generated"] = time.strftime("%Y-%m-%d %H:%M")
        full["public_registry"] = reg
        json.dump(full, open(os.path.join(MODELS, "registry_full.json"), "w"), indent=1)
    print(json.dumps(reg, indent=1))


if __name__ == "__main__":
    main()
