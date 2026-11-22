"""Negative tests: wrong recording version, missing originals, corrupted audio."""
import shutil
from pathlib import Path

import numpy as np
import pytest

from ml.datasets.unmixdb import parse_mix_labels
from ml.dsp.unmix import AudioDecodeError, align_full, load_mono, mag, onset_env, verify_mix

SET = Path(r"C:\crowdpilot-data\raw\unmixdb\extracted\mixotic-set222-excerpts\mixotic-set222-excerpts")
needs_data = pytest.mark.skipif(not (SET / "mixes").exists(), reason="UnmixDB set222 not downloaded")


@needs_data
def test_wrong_version_is_rejected_by_alignment_confidence(tmp_path):
    lab = parse_mix_labels(SET / "mixes" / "set222mix3-none-none-06.labels.txt")
    used = {t.file for t in lab.tracks.values()}
    other = next(p for p in sorted((SET / "refsongs").glob("*.excerpt40.mp3")) if p.name not in used)
    mix = load_mono(lab.audio)
    menv = onset_env(mag(mix))
    right = load_mono(SET / "refsongs" / lab.tracks[2].file)
    wrong = load_mono(other)
    a_ok, ncc_ok = align_full(mix, right, "none", menv, onset_env(mag(right)))
    a_bad, ncc_bad = align_full(mix, wrong, "none", menv, onset_env(mag(wrong)))
    assert ncc_ok > 0.5
    assert ncc_bad < 0.2, "a different recording must not pass as a match"
    assert not a_bad.confident or ncc_bad < 0.2


@needs_data
def test_slightly_different_edit_is_flagged(tmp_path):
    """Same recording but a different edit (2 s removed in the middle) must lose waveform match."""
    lab = parse_mix_labels(SET / "mixes" / "set222mix3-none-none-06.labels.txt")
    mix = load_mono(lab.audio)
    src = load_mono(SET / "refsongs" / lab.tracks[2].file)
    edit = np.concatenate([src[: len(src) // 2], src[len(src) // 2 + 2 * 22050 :]])
    _, ncc_edit = align_full(mix, edit, "none", onset_env(mag(mix)), onset_env(mag(edit)))
    _, ncc_true = align_full(mix, src, "none", onset_env(mag(mix)), onset_env(mag(src)))
    assert ncc_edit < ncc_true * 0.8


@needs_data
def test_missing_original_track_raises(tmp_path):
    lab = parse_mix_labels(SET / "mixes" / "set222mix3-none-none-06.labels.txt")
    with pytest.raises(AudioDecodeError):
        verify_mix(lab, tmp_path)  # refsongs directory without the source files


@needs_data
def test_corrupted_audio_is_detected(tmp_path):
    src = next((SET / "refsongs").glob("*.excerpt40.mp3"))
    bad = tmp_path / "corrupt.mp3"
    bad.write_bytes(b"\x00" * 1024 + src.read_bytes()[:2048][::-1])
    with pytest.raises(AudioDecodeError):
        load_mono(bad)
    empty = tmp_path / "empty.wav"
    shutil.copy(src, empty)
    empty.write_bytes(b"")
    with pytest.raises(AudioDecodeError):
        load_mono(empty)
