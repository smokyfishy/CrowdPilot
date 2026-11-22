"""Reference beats/downbeats from the official Beat This! (CPJKU, MIT) for the eval corpus."""
import json, time
from pathlib import Path
import numpy as np
from beat_this.inference import File2Beats
from ml.datasets.acquire import ROOT
OUT = ROOT / "raw" / "jamendo_eval"


def main():
    rows = json.loads((OUT / "corpus.json").read_text())
    res = {}
    for ck in ("final0", "small0"):
        f2b = File2Beats(checkpoint_path=ck, device="cpu", dbn=False)
        for r in rows:
            t0 = time.time()
            beats, downs = f2b(r["wav"])
            res.setdefault(str(r["id"]), {})[ck] = {"beats": np.round(beats, 4).tolist(), "downbeats": np.round(downs, 4).tolist(), "seconds": round(time.time() - t0, 2)}
        print(ck, "done", flush=True)
    (OUT / "beatthis_ref.json").write_text(json.dumps(res), encoding="utf-8")
    # agreement small vs final (F-measure ±70 ms) and median IBI→BPM
    def f1(ref, est, tol=0.07):
        ref, est = np.array(ref), np.array(est)
        if not len(ref) or not len(est): return 0.0
        hit = sum(np.min(np.abs(ref - e)) <= tol for e in est)
        p, rc = hit / len(est), hit / len(ref)
        return 2 * p * rc / (p + rc + 1e-9)
    s = [f1(v["final0"]["beats"], v["small0"]["beats"]) for v in res.values()]
    d = [f1(v["final0"]["downbeats"], v["small0"]["downbeats"]) for v in res.values()]
    sec = {ck: float(np.mean([v[ck]["seconds"] for v in res.values()])) for ck in ("final0", "small0")}
    print(json.dumps({"small_vs_final_beatF1_median": float(np.median(s)), "small_vs_final_downbeatF1_median": float(np.median(d)), "mean_seconds_per_track_cpu": sec}))


if __name__ == "__main__":
    main()
