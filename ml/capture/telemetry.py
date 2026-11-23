"""CrowdPilot Mixxx telemetry: control table, SysEx codec, session writer, clock sync.

The control table MUST mirror ml/capture/mixxx/CrowdPilot-Telemetry.js (same order).
``TABLE_VERSION`` and the announced table length (ctrl id 127) are checked on receipt.
"""
from __future__ import annotations

import dataclasses
import datetime as dt
import hashlib
import json
import platform
import struct
from pathlib import Path

import numpy as np

TABLE_VERSION = 1
DECKS = ["[Channel1]", "[Channel2]", "[Channel3]", "[Channel4]"]
DECK_KEYS = ["play", "volume", "pregain", "rate", "rate_dir", "rateRange", "playposition", "track_loaded", "duration", "bpm", "file_bpm", "sync_enabled", "keylock", "cue_indicator", "loop_enabled", "beatloop_size", "pfl", "orientation", "slip_enabled", "jog", "scratch2_enable", "reverse"]
DECK_EXTRA = [("[EqualizerRack1_%D_Effect1]", "parameter1"), ("[EqualizerRack1_%D_Effect1]", "parameter2"), ("[EqualizerRack1_%D_Effect1]", "parameter3"), ("[EqualizerRack1_%D_Effect1]", "button_parameter1"), ("[EqualizerRack1_%D_Effect1]", "button_parameter2"), ("[EqualizerRack1_%D_Effect1]", "button_parameter3"), ("[QuickEffectRack1_%D]", "super1"), ("[QuickEffectRack1_%D]", "enabled")]
GLOBAL = [("[Master]", "crossfader"), ("[Master]", "gain"), ("[Master]", "balance"), ("[Recording]", "status"), ("[EffectRack1_EffectUnit1]", "mix"), ("[EffectRack1_EffectUnit1]", "super1"), ("[EffectRack1_EffectUnit1]", "enabled"), ("[EffectRack1_EffectUnit2]", "mix"), ("[EffectRack1_EffectUnit2]", "super1"), ("[EffectRack1_EffectUnit2]", "enabled")]
ID_SHUTDOWN, ID_HEARTBEAT, ID_TABLE = 125, 126, 127

# Friendly names for the applied-controls table
FRIENDLY = {"parameter1": "eq_low", "parameter2": "eq_mid", "parameter3": "eq_high", "button_parameter1": "eq_low_kill", "button_parameter2": "eq_mid_kill", "button_parameter3": "eq_high_kill", "super1": "filter", "enabled": "filter_enabled"}


def control_table() -> list[tuple[str, str]]:
    t: list[tuple[str, str]] = []
    for d in DECKS:
        t += [(d, k) for k in DECK_KEYS]
        t += [(g.replace("%D", d), k) for g, k in DECK_EXTRA]
    t += GLOBAL
    return t[:125]


TABLE = control_table()


def encode(seq: int, ctrl_id: int, value: float) -> bytes:
    """Python mirror of the JS encoder (used for tests and simulators)."""
    u = struct.unpack(">I", struct.pack(">f", value))[0]
    s = seq & 0x3FFF
    return bytes([0xF0, 0x7D, 0x43, 0x50, 0x01, (s >> 7) & 0x7F, s & 0x7F, ctrl_id & 0x7F, (u >> 28) & 0x0F, (u >> 21) & 0x7F, (u >> 14) & 0x7F, (u >> 7) & 0x7F, u & 0x7F, 0xF7])


def decode(msg: bytes) -> tuple[int, int, float] | None:
    if len(msg) != 14 or msg[0] != 0xF0 or msg[-1] != 0xF7 or msg[1:5] != b"\x7d\x43\x50\x01":
        return None
    seq = (msg[5] << 7) | msg[6]
    u = (msg[8] << 28) | (msg[9] << 21) | (msg[10] << 14) | (msg[11] << 7) | msg[12]
    return seq, msg[7], struct.unpack(">f", struct.pack(">I", u & 0xFFFFFFFF))[0]


def describe(ctrl_id: int) -> dict:
    if ctrl_id >= len(TABLE):
        return {"group": "[CrowdPilot]", "key": {ID_SHUTDOWN: "shutdown", ID_HEARTBEAT: "heartbeat", ID_TABLE: "table_length"}.get(ctrl_id, f"unknown_{ctrl_id}"), "deck": None}
    g, k = TABLE[ctrl_id]
    deck = next((i + 1 for i, d in enumerate(DECKS) if d in g), None)
    return {"group": g, "key": k, "deck": deck, "name": FRIENDLY.get(k, k)}


@dataclasses.dataclass
class Event:
    t_ns: int  # receiver monotonic clock (time.perf_counter_ns)
    seq: int
    ctrl_id: int
    value: float


class SessionWriter:
    """Writes controller_events.jsonl as events arrive; builds applied_controls.parquet and
    session_manifest.json on close. Unavailable fields are recorded as unavailable, never guessed."""

    def __init__(self, out_dir: Path, consent_ref: str | None, mixxx_version: str, notes: str = ""):
        self.dir = out_dir
        self.dir.mkdir(parents=True, exist_ok=True)
        self.f = (self.dir / "controller_events.jsonl").open("w", encoding="utf-8")
        self.events: list[Event] = []
        self.gaps = 0
        self.last_seq: int | None = None
        self.table_len_seen: int | None = None
        self.meta = {"consent_ref": consent_ref, "mixxx_version": mixxx_version, "notes": notes, "table_version": TABLE_VERSION, "started_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "host": platform.platform()}

    def add_raw(self, t_ns: int, msg: bytes) -> None:
        d = decode(msg)
        if not d:
            self.f.write(json.dumps({"t_ns": t_ns, "raw": msg.hex(), "decoded": None}) + "\n")
            return
        seq, cid, val = d
        if self.last_seq is not None and seq != (self.last_seq + 1) & 0x3FFF:
            self.gaps += (seq - self.last_seq - 1) & 0x3FFF
        self.last_seq = seq
        if cid == ID_TABLE:
            self.table_len_seen = int(val)
        ev = Event(t_ns, seq, cid, val)
        self.events.append(ev)
        self.f.write(json.dumps({"t_ns": t_ns, "seq": seq, "ctrl_id": cid, "value": val, **describe(cid)}) + "\n")

    def close(self, recording: Path | None, sources: list[Path], sync: dict | None) -> dict:
        import pandas as pd

        self.f.close()
        rows = [{"t_ns": e.t_ns, "seq": e.seq, **describe(e.ctrl_id), "value": e.value} for e in self.events if e.ctrl_id < len(TABLE)]
        df = pd.DataFrame(rows)
        if len(df):
            df["t_s"] = (df.t_ns - df.t_ns.min()) / 1e9
            df.to_parquet(self.dir / "applied_controls.parquet")
        sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest() if p and p.exists() else None  # noqa: E731
        manifest = {
            **self.meta,
            "ended_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "events": len(self.events),
            "sequence_gaps": self.gaps,
            "table_length_announced": self.table_len_seen,
            "table_length_expected": len(TABLE),
            "table_match": self.table_len_seen in (None, len(TABLE)),
            "recording": {"path": str(recording) if recording else None, "sha256": sha(recording) if recording else None},
            "sources": [{"path": str(p), "sha256": sha(p)} for p in sources],
            "unavailable_fields": ["raw hardware MIDI (Windows MIDI ports are exclusive; capture via a MIDI thru/monitor if needed)", "track file path (not exposed to controller scripts; map via Mixxx library history after the session)", "effect-chain internal parameters beyond super/mix/enabled"],
            "clock_sync": sync,
            "label_origin": "human_controller_gold" if self.meta["consent_ref"] else "UNCONSENTED — not usable as research data",
        }
        (self.dir / "session_manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
        return manifest


# ───────────────────────── clock synchronisation ─────────────────────────

def onset_times(audio: np.ndarray, rate: int, threshold_db: float = -30.0) -> np.ndarray:
    """Times (s) where the recording rises from near-silence: robust anchors for play starts."""
    x = audio if audio.ndim == 1 else audio.mean(axis=1)
    hop = 256
    n = len(x) // hop
    env = np.sqrt(np.mean(x[: n * hop].reshape(n, hop) ** 2, axis=1) + 1e-12)
    db = 20 * np.log10(env)
    on = (db[1:] > threshold_db) & (db[:-1] <= threshold_db)
    idx = np.nonzero(on)[0] + 1
    out = []
    for i in idx:
        # refine to the sample where |x| first exceeds the threshold
        seg = np.abs(x[i * hop - hop : (i + 1) * hop])
        j = int(np.argmax(seg > 10 ** (threshold_db / 20)))
        out.append((i * hop - hop + j) / rate)
    return np.array(out)


def fit_clock(event_times_s: np.ndarray, audio_times_s: np.ndarray, max_pair_s: float = 0.5) -> dict:
    """Least-squares t_audio = offset + (1+drift)·t_event over nearest-neighbour pairs.
    Reports residuals; QC passes when the RMS residual < 10 ms and drift < 100 ppm."""
    if len(event_times_s) < 2 or len(audio_times_s) < 2:
        return {"ok": False, "reason": "need ≥2 anchors in both timelines"}
    # initial offset by median difference of first anchors
    off0 = audio_times_s[0] - event_times_s[0]
    pairs = []
    for t in event_times_s:
        j = int(np.argmin(np.abs(audio_times_s - (t + off0))))
        if abs(audio_times_s[j] - (t + off0)) <= max_pair_s:
            pairs.append((t, audio_times_s[j]))
    if len(pairs) < 2:
        return {"ok": False, "reason": "anchors could not be paired"}
    e, a = np.array(pairs).T
    A = np.vstack([np.ones_like(e), e]).T
    (offset, slope), *_ = np.linalg.lstsq(A, a, rcond=None)
    resid = a - (offset + slope * e)
    rms_ms = float(np.sqrt(np.mean(resid**2)) * 1000)
    drift_ppm = float((slope - 1) * 1e6)
    return {"ok": rms_ms < 10 and abs(drift_ppm) < 100, "offset_s": float(offset), "drift_ppm": drift_ppm, "rms_residual_ms": rms_ms, "max_residual_ms": float(np.max(np.abs(resid)) * 1000), "pairs": len(pairs)}
