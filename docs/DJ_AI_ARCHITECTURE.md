# CrowdPilot Phase 2: AI DJ architecture

This page describes what exists and runs today. Planned work is marked as such.

```
Guests ─ search ─▶ YouTube (discovery, embed only) │ Audius │ Jamendo   (worker providers)
                       │ enqueue (server re-resolves metadata + licence basis)
                       ▼
DeepSpace room scope: queue_items (+mixTrackKey, rights, locked, targetStartAt) · playback ·
                      dj_state (settings, proposed/committed transition) · track_features (<4 KB summaries)
                       │ live sync to every device
                       ▼
Host browser (controller lease, Phase 1)
  HostPlaybackAgent ──▶ RoutingController ──┬─▶ YouTube IFrame player (standard playback)
                                            └─▶ HostDj ─▶ DjEngine (2 Web Audio decks)
  HostDj: fetch authorized audio (Audius direct / Jamendo pass-through) → decode → session LRU
          → Web Worker analysis (src/dsp) → saveAnalysis → MixGraph (src/dj) → proposed → committed
          → WSOLA pre-render (tempo) → scheduleTransition on the AudioContext clock
          → handoff → advance{nextItemId,startPositionSec}
```

## Modules

| Area | Path | Notes |
|---|---|---|
| DSP analyzer | `src/dsp/*` | Pure TypeScript. Same code runs in Node tests and the browser worker. |
| Time-stretch | `src/dsp/stretch.ts` | Variable-ratio WSOLA. `outputPosOf` / `inputPosAt` keep beat maps exact. |
| MixGraph transitions | `src/dj/transitions.ts` | Region-level, multi-edge candidates (cue pairs × styles × overlap lengths). Explicit costs, risks, reasons. |
| Queue planner | `src/dj/queue-planner.ts` | Beam search with hard constraints. Cross-checked against brute force. FIFO when AI reorder is off. |
| Offline renderer | `src/dj/render.ts` | Renders the same plan the engine plays (EQ/fader/WSOLA/limiter). Used for tests, A/B exports and WAV. |
| Engine | `src/dj/engine/deck-engine.ts` | Trim → low-shelf 250 Hz / peak 1 kHz / high-shelf 4 kHz → fader. Master limiter, safety shaper, meter. |
| Host controller | `src/dj/engine/host-dj.ts` | Analysis cache, autopilot, commit window (40 s), overrides, safe fallback. |
| Server | `src/server/dj-commands.ts` | `djSettings`, `djStatus` (controller + revision checked), `saveAnalysis`, `correctAnalysis`, `setMixSource`, `scheduleItem`, `lockItem`. |
| UI | `src/components/dj/*`, `src/pages/(app)/lab.tsx` | Host console, room status line, tier/BPM/key badges, DJ Lab. |
| Research | `ml/` | Python pipeline: rights, acquisition, UnmixDB and human-mix verification, capture toolkit. |

## Transition styles (all executable)

| Style | Needs beat-match | Overlap | Automation |
|---|---|---|---|
| Phrase-aligned cut | no | 0 | 25 ms anti-click ramps on a downbeat |
| Short beat-matched fade | yes | 4 bars | equal-power gain, low-band swap at the midpoint |
| Long phrase blend | yes | 16/32 bars | incoming rises over the first half; bass swap at the midpoint; outgoing mids/highs fade out |
| Bass swap | yes | 8/16 bars | incoming enters with lows killed; lows swap on a beat |
| Percussion-led | yes | 16 bars | incoming enters with highs only, then mids, then bass swap |
| Quick fade (no beat-match) | no | 2 bars | used when tempos are more than 6% apart or grids are unreliable |
| Standard playback | n/a | 0 | any YouTube item, or anything not analyzed or not permitted |

## States shown in the UI

`analyzing` · `ready` · `low confidence` (badge) · `cannot mix` · `proposed` · `committed` · `mixing` (playing) · `failed` · `safe fallback`

## Not implemented / not trained (honest status)

- Learned models: CuePointNet, transition ranker, MixGraph-GAT, TransitionNet and DJCritic have **no checkpoints**. The live app uses the deterministic baseline only. See `docs/MODEL_CARDS.md`.
- Downbeat detection on real music is weak (confidence about 0.1 on the two real tracks tested). The planner penalizes this and prefers cuts when downbeats are uncertain.
- Vocal activity is a heuristic and is labelled as such.
- Beat This! / CUE-DETR integration is not done. Both are MIT-licensed (verified via the GitHub API) and are listed as next steps.
