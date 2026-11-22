"""Dataset registry: what each official source is, what it actually contains, and what
we may do with it. ``audio_available`` describes what the official source distributes
— NOT what links inside it point to. Values marked ``verified`` were read from the
official endpoint by ``acquire inventory``; everything else is a lead to check."""
from __future__ import annotations

DATA_ROOT = r"C:\crowdpilot-data"

SOURCES: dict[str, dict] = {
    "unmixdb": {
        "title": "UnmixDB: A Dataset for DJ-Mix Information Retrieval",
        "official": "https://zenodo.org/records/1422385",
        "api": "https://zenodo.org/api/records/1422385",
        "kind": "synthetic_reference",  # automatically generated mixes — NOT professional DJ performances
        "audio_available": "full: source excerpts + generated mixes (CC-licensed tracks from mixotic.net)",
        "labels": "ground-truth cue regions, time-scale factors, effects per mix",
        "licence_hint": "cc-by-nc-nd-4.0 (verify)",
        "quality_tier": "synthetic_gold",
    },
    "djmix-transitions": {
        "title": "DJ Mix Dataset — transitions (HF)",
        "official": "https://huggingface.co/datasets/djmix/transitions",
        "api": "https://huggingface.co/api/datasets/djmix/transitions",
        "kind": "professional_dj_metadata",
        "audio_available": "none in dataset: YouTube/1001Tracklists links only (links are NOT download rights)",
        "labels": "human-DJ transitions aligned automatically (weak supervision)",
        "licence_hint": "check dataset card",
        "quality_tier": "weak_pseudo_labels",
    },
    "djmix-dataset": {
        "title": "DJ Mix Dataset (code + metadata)",
        "official": "https://github.com/mir-aidj/djmix-dataset",
        "api": "https://api.github.com/repos/mir-aidj/djmix-dataset",
        "kind": "professional_dj_metadata",
        "audio_available": "none distributed; tooling references third-party platforms",
        "labels": "mix/tracklist metadata; alignment code",
        "licence_hint": "check repo licence",
        "quality_tier": "metadata",
    },
    "edm-cue": {
        "title": "EDM-CUE",
        "official": "https://huggingface.co/datasets/disco-eth/edm-cue",
        "api": "https://huggingface.co/api/datasets/disco-eth/edm-cue",
        "kind": "expert_cue_annotations",
        "audio_available": "unknown — verify per file",
        "labels": "expert cue points",
        "licence_hint": "check dataset card",
        "quality_tier": "expert_labels",
    },
    "raveform": {
        "title": "Raveform",
        "official": "https://mir-aidj.github.io/raveform/",
        "api": None,
        "kind": "professional_dj_metadata",
        "audio_available": "unknown — verify",
        "labels": "phrase/structure annotations",
        "licence_hint": "check page",
        "quality_tier": "expert_labels",
    },
    "cue-detr": {"title": "CUE-DETR", "official": "https://github.com/ETH-DISCO/cue-detr", "api": "https://api.github.com/repos/ETH-DISCO/cue-detr", "kind": "model", "audio_available": "none", "labels": "pretrained cue detector (weights licence to verify)", "licence_hint": "check repo", "quality_tier": "model"},
    "beat-this": {"title": "Beat This!", "official": "https://github.com/CPJKU/beat_this", "api": "https://api.github.com/repos/CPJKU/beat_this", "kind": "model", "audio_available": "none", "labels": "pretrained beat/downbeat tracker", "licence_hint": "check repo", "quality_tier": "model"},
    "dj-mix-evaluation-dataset": {"title": "DJ mix evaluation dataset", "official": "https://github.com/werthen/dj-mix-evaluation-dataset", "api": "https://api.github.com/repos/werthen/dj-mix-evaluation-dataset", "kind": "unknown", "audio_available": "unknown — inspect", "labels": "unknown", "licence_hint": "check repo", "quality_tier": "unknown"},
    "mixxx": {"title": "Mixxx DJ software (capture platform)", "official": "https://manual.mixxx.org/", "api": "https://api.github.com/repos/mixxxdj/mixxx", "kind": "capture_platform", "audio_available": "n/a", "labels": "n/a", "licence_hint": "GPL-2.0 (local tool only)", "quality_tier": "tool"},
}
