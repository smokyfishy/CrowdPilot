"""Capture toolkit tests with SIMULATED telemetry (never labelled as human data)."""
import json

import numpy as np
import pytest

from ml.capture.telemetry import TABLE, SessionWriter, decode, encode, fit_clock, onset_times


def test_sysex_roundtrip_matches_js_encoding():
    for seq, cid, val in [(0, 0, 1.0), (16383, 5, -0.25), (42, 124, 0.123456)]:
        s, c, v = decode(encode(seq, cid, val))
        assert (s, c) == (seq, cid)
        assert v == pytest.approx(val, rel=1e-6)
    assert decode(b"\xf0\x00\xf7") is None


def test_table_mirrors_the_mapping_script():
    js = open("ml/capture/mixxx/CrowdPilot-Telemetry.js", encoding="utf-8").read()
    for key in ["parameter1", "super1", "crossfader", "playposition", '"status"']:
        assert key in js
    assert len(TABLE) <= 125
    assert TABLE[0] == ("[Channel1]", "play")


def test_session_writer_logs_events_gaps_and_unconsented_label(tmp_path):
    w = SessionWriter(tmp_path, consent_ref=None, mixxx_version="test")
    for i, (cid, val) in enumerate([(0, 1.0), (1, 0.8), (2, 1.0)]):
        w.add_raw(1_000_000 * i, encode(i, cid, val))
    w.add_raw(5_000_000, encode(10, 1, 0.5))  # seqs 3..9 missing → gap of 7
    m = w.close(None, [], None)
    assert m["events"] == 4
    assert m["sequence_gaps"] == 7
    assert m["label_origin"].startswith("UNCONSENTED")
    lines = (tmp_path / "controller_events.jsonl").read_text().splitlines()
    assert json.loads(lines[1])["name"] == "volume"


def test_clock_fit_recovers_offset_and_drift_and_flags_mismatch():
    rate = 8000
    events = np.array([2.0, 31.5, 63.2, 95.0, 121.7])
    offset, drift = 0.137, 40e-6
    audio = np.zeros(int(rate * 130))
    true_audio_t = offset + (1 + drift) * events
    for t in true_audio_t:
        i = int(t * rate)
        audio[i : i + 4000] = 0.5 * np.sin(np.arange(4000) * 0.3)
    fit = fit_clock(events, onset_times(audio, rate))
    assert fit["ok"]
    assert fit["offset_s"] == pytest.approx(offset, abs=0.003)
    assert fit["drift_ppm"] == pytest.approx(40, abs=30)
    # controller timing mismatch: events that do not correspond to audio → QC fails
    bad = fit_clock(events + np.array([0, 0.3, -0.25, 0.4, 0]), onset_times(audio, rate))
    assert not bad["ok"]


def test_receiver_refuses_research_session_without_consent(monkeypatch):
    from ml.capture import receiver

    with pytest.raises(SystemExit, match="consent"):
        receiver.main(["listen", "--out", "x"])
