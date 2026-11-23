"""Integration: three ACTUAL recordings (UnmixDB mix + its source excerpts) are hashed,
decoded, aligned, reconstructed and compared numerically with the reference.

UnmixDB mixes are synthetic references (automatic mixes of CC-licensed tracks), not
professional DJ performances. A human-performed triplet test is added once one exists
(see docs/PROFESSIONAL_DJ_CORPUS_STATUS.md); until then it is skipped explicitly.
"""
from pathlib import Path

import pytest

from ml.datasets.unmixdb import parse_mix_labels, sha256
from ml.dsp.unmix import MP3_ENCODER_DELAY_S, verify_mix

SET = Path(r"C:\crowdpilot-data\raw\unmixdb\extracted\mixotic-set222-excerpts\mixotic-set222-excerpts")
needs_data = pytest.mark.skipif(not (SET / "mixes").exists(), reason="UnmixDB set222 not downloaded (python -m ml.datasets.acquire fetch-approved unmixdb --only set222)")


@needs_data
def test_three_real_recordings_align_and_reconstruct():
    lab = parse_mix_labels(SET / "mixes" / "set222mix3-none-none-06.labels.txt")
    files = [lab.audio] + [SET / "refsongs" / t.file for t in lab.tracks.values()]
    assert len(files) == 4 and all(f.exists() for f in files)
    hashes = {f.name: sha256(f) for f in files}
    assert all(len(h) == 64 for h in hashes.values())
    r = verify_mix(lab, SET / "refsongs")
    assert r["mix_sha256"] == hashes[lab.audio.name]
    for t in r["tracks"]:
        # constant MP3 encoder delay between files; after correcting it alignment is sample-accurate
        assert t["start_err_codec_corrected_ms"] < 2.0, t
        assert t["speed_err"] < 1e-6
        assert t["gain_corr"] > 0.95
    assert r["spectral_convergence"] < 0.15
    assert r["time_domain_snr_db"] > 15
    assert r["alignment_validated"] is True


@needs_data
def test_resample_variant_recovers_speed_factors():
    lab = parse_mix_labels(SET / "mixes" / "set222mix3-resample-none-06.labels.txt")
    r = verify_mix(lab, SET / "refsongs")
    for t in r["tracks"]:
        assert t["speed_err"] < 0.001, t
        assert t["start_err_ms"] < 50, t


@pytest.mark.skip(reason="No human-performed triplet with mix + both exact masters + rights has been acquired yet (blocker documented).")
def test_human_performed_triplet():
    raise AssertionError("must be implemented against a real, permitted human triplet")


def test_codec_delay_constant():
    assert abs(MP3_ENCODER_DELAY_S * 1000 - 25.06) < 0.01
