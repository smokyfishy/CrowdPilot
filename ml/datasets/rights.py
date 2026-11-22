"""Per-asset, per-use rights registry with default-deny gating.

Every asset (a DJ reference performance, an outgoing source recording, an incoming
source recording, a controller session, ...) carries a separate decision for each
scoped use. No use is ever inferred from another, and a research/noncommercial
label is not an authorization. Agents may record *objective licence evidence*
(e.g. the CC licence URL on the dataset's official page) and apply a documented
*user policy*; anything ambiguous stays ``RIGHTS_REVIEW`` until a human decides.
Private agreements and reviewer identities live in the gitignored private store.
"""
from __future__ import annotations

import dataclasses
import datetime as dt
import enum
import json
from pathlib import Path
from typing import Iterable


class Use(str, enum.Enum):
    WAVEFORM_ANALYZE = "waveform_analyze"
    TRAIN_MODEL = "train_model"
    INVERSE_RECONSTRUCT = "inverse_reconstruct"
    RENDER_PRIVATE_MIX = "render_private_mix"
    RETAIN_DERIVED = "retain_derived_artifacts"
    REDISTRIBUTE_AUDIO = "redistribute_audio"
    PUBLISH_DEMO = "publish_demo"
    COMMERCIALIZE = "commercialize"


class Decision(str, enum.Enum):
    DENIED = "denied"  # default
    RIGHTS_REVIEW = "rights_review"  # evidence exists but a human must decide
    APPROVED = "approved"
    REVOKED = "revoked"


class Status(str, enum.Enum):
    DISCOVERED = "DISCOVERED"
    RIGHTS_REVIEW = "RIGHTS_REVIEW"
    APPROVED_FOR_TARGET_USE = "APPROVED_FOR_TARGET_USE"
    AUDIO_PRESENT = "AUDIO_PRESENT"
    THREE_WAY_MATCH_CONFIRMED = "THREE_WAY_MATCH_CONFIRMED"
    ALIGNMENT_VALIDATED = "ALIGNMENT_VALIDATED"
    TRAINABLE_TRIPLET = "TRAINABLE_TRIPLET"
    BLOCKED = "BLOCKED"
    REVOKED = "REVOKED"


@dataclasses.dataclass
class UseDecision:
    decision: Decision = Decision.DENIED
    basis: str = ""  # e.g. "CC BY-NC-ND 4.0 §2(a)(1)(A) private noncommercial reproduction"
    evidence: list[str] = dataclasses.field(default_factory=list)  # URLs / snapshot paths
    decided_by: str = ""  # 'licence-policy:v1' for automatic application, or a reviewer handle (private store)
    decided_at: str = ""
    expires: str | None = None


@dataclasses.dataclass
class AssetRights:
    asset_id: str
    role: str  # 'dj_reference' | 'source_outgoing' | 'source_incoming' | 'controller_session' | 'source_excerpt' | 'synthetic_reference'
    licence: str = ""
    licence_url: str = ""
    platform_terms: str = ""
    composition_rights: str = "unknown"  # underlying musical work
    consent_ref: str | None = None  # for human performers
    uses: dict[str, UseDecision] = dataclasses.field(default_factory=dict)

    def decision(self, use: Use) -> UseDecision:
        return self.uses.get(use.value, UseDecision())

    def allows(self, use: Use, today: dt.date | None = None) -> bool:
        d = self.decision(use)
        if d.decision is not Decision.APPROVED:
            return False
        if d.expires:
            return (today or dt.date.today()) <= dt.date.fromisoformat(d.expires)
        return True

    def set(self, use: Use, decision: Decision, basis: str, evidence: Iterable[str], decided_by: str, expires: str | None = None) -> None:
        if decision is Decision.APPROVED and not list(evidence):
            raise ValueError(f"{self.asset_id}: an approval needs at least one evidence reference")
        self.uses[use.value] = UseDecision(decision, basis, list(evidence), decided_by, dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), expires)

    def revoke(self, reason: str, decided_by: str) -> None:
        for k in list(self.uses):
            self.uses[k] = UseDecision(Decision.REVOKED, reason, [], decided_by, dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"))

    def to_json(self) -> dict:
        d = dataclasses.asdict(self)
        d["uses"] = {k: {**dataclasses.asdict(v), "decision": v.decision.value} for k, v in self.uses.items()}
        return d

    @staticmethod
    def from_json(d: dict) -> "AssetRights":
        uses = {k: UseDecision(Decision(v["decision"]), v.get("basis", ""), v.get("evidence", []), v.get("decided_by", ""), v.get("decided_at", ""), v.get("expires")) for k, v in d.get("uses", {}).items()}
        return AssetRights(**{**{k: d[k] for k in ("asset_id", "role")}, **{k: d.get(k, "") for k in ("licence", "licence_url", "platform_terms")}, "composition_rights": d.get("composition_rights", "unknown"), "consent_ref": d.get("consent_ref"), "uses": uses})


# ───────────────────────── licence policy (user-documented) ─────────────────────────

POLICY_ID = "licence-policy:v1"
"""Policy proposed to the user (docs/DATA_RIGHTS_AND_PROVENANCE.md). Applied automatically
ONLY to explicit, machine-readable Creative Commons licences on the official source page.
ND licences never auto-approve adaptations; any training approval under NC/ND licences
is left to human review because model weights may later be distributed."""


def apply_cc_policy(a: AssetRights, licence_id: str, licence_url: str, evidence: list[str]) -> AssetRights:
    lid = licence_id.lower().replace("_", "-")
    a.licence, a.licence_url = licence_id, licence_url
    is_cc = lid.startswith("cc-") or lid.startswith("cc0")
    if not is_cc or not evidence:
        for u in Use:
            a.uses.setdefault(u.value, UseDecision())
        return a
    nc = "nc" in lid.split("-")
    nd = "nd" in lid.split("-")
    ok = lambda use, why: a.set(use, Decision.APPROVED, why, evidence, POLICY_ID)  # noqa: E731
    review = lambda use, why: a.set(use, Decision.RIGHTS_REVIEW, why, evidence, POLICY_ID)  # noqa: E731
    ok(Use.WAVEFORM_ANALYZE, f"{licence_id}: private reproduction for analysis")
    ok(Use.INVERSE_RECONSTRUCT, f"{licence_id}: private analysis; reconstructions are not distributed")
    ok(Use.RETAIN_DERIVED, f"{licence_id}: derived features retained privately")
    if nd:
        review(Use.RENDER_PRIVATE_MIX, f"{licence_id}: ND — rendering a mix is an adaptation; keep private only after human review")
    else:
        ok(Use.RENDER_PRIVATE_MIX, f"{licence_id}: adaptation permitted (private)")
    review(Use.TRAIN_MODEL, f"{licence_id}: model training not addressed explicitly; weights may be distributed later — human review")
    if nd or nc:
        a.set(Use.REDISTRIBUTE_AUDIO, Decision.DENIED, f"{licence_id}: no redistribution by CrowdPilot (dataset is already public at source)", evidence, POLICY_ID)
        a.set(Use.PUBLISH_DEMO, Decision.DENIED, f"{licence_id}: no public demo of adapted audio", evidence, POLICY_ID)
    else:
        review(Use.REDISTRIBUTE_AUDIO, f"{licence_id}: permitted with attribution — human review before any release")
        review(Use.PUBLISH_DEMO, f"{licence_id}: permitted with attribution — human review")
    a.set(Use.COMMERCIALIZE, Decision.DENIED, f"{licence_id}: project is noncommercial", evidence, POLICY_ID)
    return a


# ───────────────────────── gates ─────────────────────────

TRAINING_USES = (Use.WAVEFORM_ANALYZE, Use.TRAIN_MODEL)


class GateError(Exception):
    pass


def gate_triplet_for_waveform_training(mix: AssetRights, out: AssetRights, inc: AssetRights, audio_present: dict[str, bool], alignment_validated: bool) -> Status:
    """Returns TRAINABLE_TRIPLET only if every asset is approved for every training use, the
    audio files are actually present, and alignment passed QC. Otherwise the highest status
    reached. Never raises for 'not yet'; raises GateError for revoked assets."""
    assets = (mix, out, inc)
    if any(a.decision(u).decision is Decision.REVOKED for a in assets for u in Use):
        raise GateError("an asset in this triplet has been revoked — remove derived data and exclude it")
    if any(a.decision(u).decision is Decision.DENIED for a in assets for u in TRAINING_USES):
        return Status.BLOCKED if any(a.uses for a in assets) else Status.DISCOVERED
    if not all(a.allows(u) for a in assets for u in TRAINING_USES):
        return Status.RIGHTS_REVIEW
    if not all(audio_present.get(a.asset_id, False) for a in assets):
        return Status.APPROVED_FOR_TARGET_USE
    if not alignment_validated:
        return Status.THREE_WAY_MATCH_CONFIRMED
    return Status.TRAINABLE_TRIPLET


class RightsStore:
    """JSON store. The repo keeps a REDACTED copy (no reviewer identities, no private grant refs)."""

    def __init__(self, path: Path):
        self.path = path
        self.assets: dict[str, AssetRights] = {}
        self.audit: list[dict] = []
        if path.exists():
            raw = json.loads(path.read_text(encoding="utf-8"))
            self.assets = {k: AssetRights.from_json(v) for k, v in raw.get("assets", {}).items()}
            self.audit = raw.get("audit", [])

    def put(self, a: AssetRights, action: str) -> None:
        self.assets[a.asset_id] = a
        self.audit.append({"at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "asset": a.asset_id, "action": action})

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps({"assets": {k: v.to_json() for k, v in self.assets.items()}, "audit": self.audit}, indent=1), encoding="utf-8")

    def save_redacted(self, path: Path) -> None:
        red = {}
        for k, v in self.assets.items():
            j = v.to_json()
            j["consent_ref"] = "<private>" if j.get("consent_ref") else None
            for u in j["uses"].values():
                if u["decided_by"] and u["decided_by"] != POLICY_ID:
                    u["decided_by"] = "<human reviewer>"
            red[k] = j
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"assets": red, "audit_entries": len(self.audit)}, indent=1), encoding="utf-8")
