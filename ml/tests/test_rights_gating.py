"""Rights gating: default-deny, per-use scope, evidence required, revocation, false claims."""
import pytest

from ml.datasets.rights import AssetRights, Decision, GateError, RightsStore, Status, Use, apply_cc_policy, gate_triplet_for_waveform_training

EVID = ["https://example.org/licence-page", "snapshot.json"]


def approved(asset_id: str, role: str) -> AssetRights:
    a = AssetRights(asset_id, role)
    for u in (Use.WAVEFORM_ANALYZE, Use.TRAIN_MODEL):
        a.set(u, Decision.APPROVED, "written grant (test)", EVID, "reviewer")
    return a


def test_default_is_denied_and_uses_are_never_inferred():
    a = AssetRights("x", "dj_reference")
    assert not a.allows(Use.WAVEFORM_ANALYZE)
    a.set(Use.WAVEFORM_ANALYZE, Decision.APPROVED, "grant", EVID, "reviewer")
    assert a.allows(Use.WAVEFORM_ANALYZE)
    assert not a.allows(Use.TRAIN_MODEL)
    assert not a.allows(Use.PUBLISH_DEMO)


def test_false_claim_of_approval_without_evidence_is_rejected():
    with pytest.raises(ValueError, match="evidence"):
        AssetRights("x", "dj_reference").set(Use.TRAIN_MODEL, Decision.APPROVED, "research use", [], "agent")


def test_expired_rights_do_not_allow():
    a = AssetRights("x", "source_outgoing")
    a.set(Use.WAVEFORM_ANALYZE, Decision.APPROVED, "time-limited grant", EVID, "reviewer", expires="2020-01-01")
    assert not a.allows(Use.WAVEFORM_ANALYZE)


def test_cc_policy_nc_nd_approves_analysis_but_not_training_or_release():
    a = apply_cc_policy(AssetRights("u", "synthetic_reference"), "cc-by-nc-nd-4.0", "https://creativecommons.org/licenses/by-nc-nd/4.0/", EVID)
    assert a.allows(Use.WAVEFORM_ANALYZE) and a.allows(Use.INVERSE_RECONSTRUCT)
    assert a.decision(Use.TRAIN_MODEL).decision is Decision.RIGHTS_REVIEW
    assert a.decision(Use.RENDER_PRIVATE_MIX).decision is Decision.RIGHTS_REVIEW
    assert a.decision(Use.REDISTRIBUTE_AUDIO).decision is Decision.DENIED
    assert a.decision(Use.COMMERCIALIZE).decision is Decision.DENIED


def test_non_cc_or_missing_evidence_gets_nothing():
    a = apply_cc_policy(AssetRights("y", "dj_reference"), "all-rights-reserved", "", EVID)
    assert not any(a.allows(u) for u in Use)
    b = apply_cc_policy(AssetRights("z", "dj_reference"), "cc-by-4.0", "", [])
    assert not any(b.allows(u) for u in Use)


def test_triplet_gate_requires_all_three_assets_audio_and_alignment():
    mix, out, inc = approved("mix", "dj_reference"), approved("a", "source_outgoing"), approved("b", "source_incoming")
    present = {"mix": True, "a": True, "b": True}
    assert gate_triplet_for_waveform_training(mix, out, inc, present, alignment_validated=True) is Status.TRAINABLE_TRIPLET
    # missing original track → not trainable
    assert gate_triplet_for_waveform_training(mix, out, inc, {**present, "b": False}, True) is Status.APPROVED_FOR_TARGET_USE
    # no mix waveform
    assert gate_triplet_for_waveform_training(mix, out, inc, {**present, "mix": False}, True) is Status.APPROVED_FOR_TARGET_USE
    # low-confidence alignment
    assert gate_triplet_for_waveform_training(mix, out, inc, present, alignment_validated=False) is Status.THREE_WAY_MATCH_CONFIRMED
    # one asset only under review
    inc2 = AssetRights("b", "source_incoming")
    inc2.set(Use.WAVEFORM_ANALYZE, Decision.APPROVED, "cc", EVID, "licence-policy:v1")
    inc2.set(Use.TRAIN_MODEL, Decision.RIGHTS_REVIEW, "unclear", EVID, "licence-policy:v1")
    assert gate_triplet_for_waveform_training(mix, out, inc2, present, True) is Status.RIGHTS_REVIEW
    # metadata-only (never reviewed) → discovered, never trainable
    assert gate_triplet_for_waveform_training(AssetRights("m", "dj_reference"), AssetRights("o", "x"), AssetRights("i", "x"), present, True) is Status.DISCOVERED


def test_revoked_permission_stops_everything(tmp_path):
    mix, out, inc = approved("mix", "dj_reference"), approved("a", "source_outgoing"), approved("b", "source_incoming")
    out.revoke("rightsholder withdrew permission", "reviewer")
    with pytest.raises(GateError, match="revoked"):
        gate_triplet_for_waveform_training(mix, out, inc, {"mix": True, "a": True, "b": True}, True)
    store = RightsStore(tmp_path / "r.json")
    store.put(out, "revoked")
    store.save()
    again = RightsStore(tmp_path / "r.json")
    assert again.assets["a"].decision(Use.TRAIN_MODEL).decision is Decision.REVOKED


def test_redacted_store_hides_reviewer_and_consent(tmp_path):
    a = approved("mix", "dj_reference")
    a.consent_ref = "C-2026-001 signed by Jane Doe"
    s = RightsStore(tmp_path / "private.json")
    s.put(a, "approve")
    s.save_redacted(tmp_path / "public.json")
    text = (tmp_path / "public.json").read_text()
    assert "Jane" not in text and "reviewer" not in text.replace("<human reviewer>", "")
