"""CrowdPilot stem separation job (Azure Container Apps Job, event-driven by an Azure Storage queue).

One execution = one queue message = one recording:
  1. download the recording from the URL in the message (Jamendo hosts only — the site's server
     resolved it after re-checking the licence allows derivatives);
  2. separate with Demucs htdemucs (4 stems: vocals, drums, bass, other) on CPU (or GPU when present);
  3. measure: vocal-stem RMS envelope (20 Hz), bass bleed into the vocal stem, and the stem-sum
     reconstruction residual against the original (decoder delay aligned first);
  4. upload each stem as Ogg Opus 160 kb/s plus info.json to the private blob container;
  5. delete the message.
Stems are cached by track key: if info.json already exists the message is just deleted.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

import numpy as np
from scipy.signal import lfilter
from azure.storage.blob import BlobServiceClient, ContentSettings
from azure.storage.queue import QueueClient

CONN = os.environ["STORAGE_CONNECTION"]
QUEUE = os.environ.get("STEMS_QUEUE", "stems")
CONTAINER = os.environ.get("STEMS_CONTAINER", "stems")
ALLOWED_HOST = re.compile(r"(^|\.)jamendo\.com$")
SR = 44100
VERSION = "htdemucs-4stem-v1"


def safe_key(key: str) -> str:
    if not re.fullmatch(r"jamendo:\d{1,12}", key):
        raise ValueError(f"unsupported key {key!r}")
    return key.replace(":", "_")


def run(cmd: list[str]) -> None:
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed: {r.stderr[-800:]}")


def read_wav(path: str) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).T.copy()


def measures(mix: np.ndarray, stems: dict[str, np.ndarray]) -> dict:
    v = stems["vocals"].mean(0)
    hop = SR // 20
    n = len(v) // hop
    env = [round(float(10 * np.log10(np.mean(v[i * hop:(i + 1) * hop] ** 2) + 1e-12)), 1) for i in range(n)]
    # bass bleed: share of vocal-stem energy below ~120 Hz (2nd-order low-pass twice)
    k = np.exp(-2 * np.pi * 120 / SR)
    lp2 = lfilter([1 - k], [1, -k], lfilter([1 - k], [1, -k], v))
    bleed = float(np.sum(lp2 ** 2) / max(1e-12, np.sum(v ** 2)))
    # reconstruction residual, aligned (decoders add different priming delays)
    s = sum(stems[x] for x in ("vocals", "drums", "bass", "other"))[0]
    m = mix[0]
    L = min(len(s), len(m))
    c0 = max(0, min(L // 3, L - 20 * SR))
    c1 = min(L, c0 + 20 * SR)
    best, lag = -1e30, 0
    for d in range(-int(0.05 * SR), int(0.05 * SR) + 1, 4):
        a0, a1 = max(c0, -d), min(c1, L - max(0, d))
        c = float(np.dot(m[a0:a1:8], s[a0 + d:a1 + d:8]))
        if c > best:
            best, lag = c, d
    a0, a1 = max(0, -lag), L - max(0, lag)
    e = float(np.sum((m[a0:a1] - s[a0 + lag:a1 + lag]) ** 2))
    p = float(np.sum(m[a0:a1] ** 2))
    residual = round(10 * np.log10(e / max(1e-12, p) + 1e-12), 1)
    return {"vocalRmsDb": env, "envRateHz": 20, "bleed": round(bleed, 4), "residualDb": residual, "durationSec": round(len(v) / SR, 2)}


def process(msg: dict, blobs) -> None:
    key = msg["key"]
    prefix = safe_key(key)
    info_blob = blobs.get_blob_client(f"{prefix}/info.json")
    if info_blob.exists():
        print(f"{key}: cached")
        return
    url = msg["url"]
    host = urllib.parse.urlparse(url).hostname or ""
    if not ALLOWED_HOST.search(host):
        raise ValueError(f"refusing host {host}")
    t0 = time.time()
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "src")
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "CrowdPilot-stems/1"}), timeout=120) as r, open(src, "wb") as f:
            f.write(r.read(200_000_000))
        wav = os.path.join(tmp, "in.wav")
        run(["ffmpeg", "-v", "error", "-y", "-i", src, "-ac", "2", "-ar", str(SR), wav])
        out = os.path.join(tmp, "out")
        run([sys.executable, "-m", "demucs", "-n", "htdemucs", "-o", out, "--filename", "{stem}.{ext}", wav])
        found = {}
        for root, _d, files in os.walk(out):
            for fn in files:
                stem = fn.rsplit(".", 1)[0]
                if stem in ("vocals", "drums", "bass", "other"):
                    found[stem] = os.path.join(root, fn)
        if set(found) != {"vocals", "drums", "bass", "other"}:
            raise RuntimeError(f"demucs produced {sorted(found)}")
        mix = read_wav(wav)
        stems = {k: read_wav(p) for k, p in found.items()}
        info = measures(mix, stems)
        for stem, path in found.items():
            opus = os.path.join(tmp, f"{stem}.opus")
            run(["ffmpeg", "-v", "error", "-y", "-i", path, "-c:a", "libopus", "-b:a", "160k", opus])
            with open(opus, "rb") as f:
                blobs.upload_blob(f"{prefix}/{stem}.opus", f, overwrite=True, content_settings=ContentSettings(content_type="audio/ogg", cache_control="private, max-age=604800"))
        info.update({"key": key, "elements": ["vocals", "drums", "bass", "other"], "model": "htdemucs", "version": VERSION, "seconds": round(time.time() - t0, 1)})
        info_blob.upload_blob(json.dumps(info), overwrite=True, content_settings=ContentSettings(content_type="application/json"))
    print(f"{key}: separated in {time.time() - t0:.0f}s (residual {info['residualDb']} dB, bleed {info['bleed']})")


def main() -> int:
    q = QueueClient.from_connection_string(CONN, QUEUE)
    blobs = BlobServiceClient.from_connection_string(CONN).get_container_client(CONTAINER)
    msgs = list(q.receive_messages(messages_per_page=1, visibility_timeout=1800, max_messages=1))
    if not msgs:
        print("no message")
        return 0
    m = msgs[0]
    try:
        process(json.loads(m.content), blobs)
        q.delete_message(m)
    except Exception as e:  # leave the message for a retry unless it is hopeless
        print(f"failed: {e}")
        if m.dequeue_count >= 3 or isinstance(e, ValueError):
            q.delete_message(m)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
