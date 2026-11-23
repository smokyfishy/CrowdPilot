# Professional DJ planning, long-form performances and closed-loop evaluation

Branch `feat/pro-dj-closed-loop`. This document records what was built, what is learned versus rule-based, how it was evaluated, and what the evidence does and does not show.

## Pipeline

```
Music analysis (existing: Beat This! grid, bars, phrases, sections, local keys, heuristic vocals; stems on the local worker)
  → bar-level profiles                         src/mixgen/profile.ts
  → global set planning                        src/mixgen/setplan.ts
  → long-form staged performances              src/mixgen/longform.ts  (+ TransitionNet v2 proposals, src/ml/transitionnet-v2.ts)
  → candidate preview rendering                src/mixgen/closedloop.ts → src/dj/render.ts (the production renderer)
  → audio-quality evaluation                   src/mixgen/audio-quality.ts (+ DJCritic as a capped term)
  → re-planning / refinement                   closedloop.ts → setplan.ts (measured edge costs, pair penalties)
  → final mix                                  src/mixgen/mix-render.ts
```

The orchestrator `src/mixgen/prodj.ts` (`planProDj`) is the single entry point. It is used by:

- `runPipeline` (`planner: 'global'`, the new default);
- the browser host, Node worker and research host;
- the comparison harness `evaluation/mixgen.prodj.eval.ts`.

The previous planner remains available as `planner: 'legacy'`.

## 1. Global DJ planning (rule-based search, with MixGraph as a learned term)

**Bar-level profiles** (`profile.ts`). Each bar gets activity values (0..1) for bass, mids, highs and percussion. These are each band's energy relative to the track's own loud bars, plus onset density.

- **Vocal activity** comes from the vocal stem when stems exist. Otherwise it comes from the analyzer's heuristic, and is flagged as such.
- **Chroma:** a 12-bin vector per bar.
- **Local Camelot key** per bar.
- **Regions:** intro, outro, breakdown and drop come from the analyzer. "Build" covers the 8 bars that lead into a drop.
- **Vocal phrases:** runs of vocal activity, snapped to the 4-bar grid.
- **Groove proxy:** onset density and its variance, high and bass activity, spectral centroid, vocal share. It is not a learned embedding.

**Phrase-aware cues** (`cueCandidates`). Each track offers up to 10 exits and 10 entries. They sit on phrase boundaries, every 8 bars, and at every region change. Each carries its region and vocal activity.

**Overlap compatibility** (`overlapCompat`). This is evaluated bar by bar over the whole 16/32/48/64-bar window:

- **Bass:** the cost of the best bass-swap bar. The bar must be phrase-aligned, the incoming bassline must be present after it and the outgoing one before it, with a bonus for an incoming drop.
- **Vocals:** both vocals active where both decks are layered. The handoff bar is where the outgoing vocal phrase ends before the incoming one starts.
- **Harmony:** chroma correlation of the bars that sound together, weighted by mid activity.
- **Percussion overload.**
- **Energy match:** the 8 bars before against the 8 bars after.
- **Run-out:** bars where the outgoing has no audio left.

**Search** (`planSet`). This is a beam search over subset and order in which each state also carries the last track's actual entry point and tempo recovery.

- Expanding to the next track chooses a concrete edge, meaning a cue pair, an overlap length and a technique.
- The chosen exit cue must leave the current track at least 8 solo bars after its own entry. Each track's incoming and outgoing cues are therefore planned together, and every transition constrains the next one.

Edge costs:

- the legacy rule cost, with the same style, energy and genre terms for every edge type;
- bar-level compatibility;
- an overlap-length prior. For house, techno and EDM: 32 bars −0.45, 16 bars −0.15, 48 and 64 bars cheaper only when compatibility is high;
- MixGraph's predicted severity, at weight 4. Windows longer than 32 bars are scored as 32-bar blends, because it was trained up to 32 bars;
- measured closed-loop quality, once an edge has been rendered.

Set-level terms:

- narrative fit: per-slot target energy and roles (opening, groove, build, peak, recovery, finale) from the prompt's energy curve and features;
- BPM drift and zig-zag;
- genre overlap;
- groove similarity;
- vocal-heavy runs;
- key repetition;
- technique variety;
- artist repeats;
- duration fit.

The search returns up to 5 complete arrangements.

## 2. Long-form staged performances (rule solver + TransitionNet v2)

`buildPerformance` turns a beat-matched window into five stages: introduce → layer → develop → transfer → resolve.

**Stage boundaries come from `overlapCompat`:**

- the bass-swap bar;
- the vocal-handoff bar;
- whether harmony allows melodic layering;
- percussion overload;
- an incoming drop at the window end.

These are not fixed fractions of a template.

**Strategies:**

- `layered_blend`
- `percussion_build`
- `vocal_handoff`: the outgoing mids/vocal leave at the end of their phrase, then the incoming mids are unmasked.
- `echo_handoff`: an echo-out of the outgoing vocal when the vocals overlap.
- `stem_mashup`: an acapella over an instrumental (clean stems only).
- `filter_ride`
- `drop_lock`: the incoming build plays under the outgoing track, with the bass on the drop.

`feasibleStrategies` lists the strategies the window supports.

**Executable controls:**

- per-deck channel faders;
- a new dipless crossfader lane;
- 3-band EQ: amplitude-domain ramps, and a linear-amplitude bass handoff so the summed low band stays constant;
- bipolar filters on both decks;
- echo sends on both decks (incoming echo is new);
- a new incoming tempo lane;
- a new outgoing loop, used when the outgoing runs out of audio inside the window;
- new cue triggers: incoming start, incoming drop, loop in;
- stem gain lanes. With clean 4-stem separations these become element-level: drums first, then melody (other) layered when the harmony fits, then the incoming vocal after the outgoing one.

**Renderer changes** (`src/dj/render.ts`):

- Every control is now interpolated per sample. Before, values were stepped every 128 samples.
- New lanes: crossfader, tempo lane, incoming echo, outgoing loop.
- `validPlan` bounds-checks every lane. The tempo lane must equal the planned ratio over the overlap, so the timeline stays exact. Effective end gains include the crossfader.

**TransitionNet v2** proposes the strategy, 12 continuous shape parameters and an incoming cue shift for a window. It is described below under "Training".

## 3. Closed-loop evaluation (measurement, plus DJCritic as a capped term)

`closedLoop` works on the planner's current best set. For every transition it does the following:

1. Choose up to 5 candidate slots: the planned edge, the best 32/16/48/64-bar alternatives and the best short technique.
2. Give each long-form slot 2–3 performances: the TransitionNet v2 proposal (if loaded), then the rule-feasible strategies.
3. Render each one with the production renderer as a 16 kHz preview, covering 8 bars before, the overlap and 8 bars after.
4. Measure each preview (see below).
5. Reject hard failures.
6. Refine the winner:
   - targeted parameter changes from the faults that were measured;
   - incoming cue ±8 bars;
   - outgoing cue +8 bars;
   - overlap ±16 bars.

7. Write the measured cost of every evaluated slot back into the planner. The cost is the planner's prediction plus λ(score − mean measured score), plus 6 for a hard failure.
8. Penalise pairs whose best candidate is still poor, then re-plan the whole set.

The re-plan may change cues, overlap, technique, neighbours or order. There are up to 3 rounds and a preview budget: 64 in the browser, 160 in the Node worker, 200 on the research host. Previews are cached.

A final verification pass renders any transition in the final set that was never rendered.

**Metrics** (`audio-quality.ts`). These are explicit signal measurements with conservative thresholds, not a model of taste:

- **Beat alignment:** kick-band onset cross-correlation between the post-fader decks, on a 5 ms grid with parabolic refinement. When the decks share too little bass, it falls back to the hi-hat band.
- **Phrase alignment:** the cue offset from each track's analysed bar and phrase grid.
- **Harmony:** chroma correlation of the two decks over the overlap.
- **Vocal clash:** per-bar vocal-band level of each deck × its vocal activity. It is labelled heuristic when no stems exist.
- **Bass masking:** the shared low-band energy share.
- **Percussion:** flam excess and pulse clarity, which are DJCritic features.
- **Energy and loudness:** dip, bump and pre/post level.
- **Clipping, limiter and silence.**
- **Time-stretch:** ratio size and transient-crest loss.
- **Stem bleed.**
- **Effect rules:** for example, an echo tail over the incoming vocal, or a filtered incoming drop.
- **Overcrowding.**
- **Level steps:** steps beyond the music's own steps before the transition.

**Hard failures:**

- clipping;
- limiter reduction over 6 dB;
- silence of 0.5 s or more;
- a beat offset over 50 ms;
- bass doubling over 0.2;
- vocal clash over 0.45;
- a level step more than 6 dB above the music's own (9 dB for a drop landing);
- an energy dip over 9 dB.

**There is no length bonus anywhere in the score.** A test checks that a clean 16-bar handoff and a clean 64-bar handoff score alike, and that a 64-bar handoff with doubled bass hard-fails.

**DJCritic** (LightGBM, unpromoted) adds at most 0.6 to the score. It models synthetic objective severity, not listener preference.

## Training and model integration

| Model | Status in the new system | Evidence |
|---|---|---|
| MixGraph quality ranker (LightGBM, existing, unpromoted) | **used**: a learned term in every edge cost (weight 4). Windows longer than 32 bars are scored as 32-bar blends. | Existing held-out ablation. It is not re-trained here. |
| DJCritic quality + artifact (LightGBM, existing, unpromoted) | **used**: a capped term (≤ 0.6) in the closed-loop preview score | Existing held-out metrics. Trained on synthetic objective severity, so it says nothing about human taste. |
| TransitionNet v1 (MLP, existing) | **not used** by the global planner. The UI no longer forces it on, and the manifest says it was not used. | It raised bass doubling 11× in the earlier ablation. |
| **TransitionNet v2** (new MLP: strategy + 12 stage/shape parameters + incoming cue shift) | **trained, evaluated, not promoted, not shipped**. The runtime and loader exist but are off by default. | See below. |

### TransitionNet v2: what was done and what it showed

- **Data** (`evaluation/ml/synth_v2.eval.ts`): synthetic known-control renders on the private evaluation corpora (74 Jamendo tracks), with track-level splits (train 52 / val 8 / test 14 tracks; no track appears in two splits).
  - Long-form windows come from the planner's own window generator: 316 windows in total (220 / 36 / 60).
  - Each window was performed several ways, 3,678 renders in all:
    - every feasible strategy with neutral parameters;
    - two random parameter vectors per strategy;
    - incoming cue shifts of ±8 bars.
  - Each render was measured with the closed-loop metrics.
- **Model** (`ml/transitionnet/train_v2.py`): a 2×32 MLP that imitates the render-verified best controls.
- **Result: it did not generalise.**
  - Validation loss was best at epoch 0–2.
  - On the **held-out test windows** it chose the render-verified best strategy 22 % of the time. A constant rule ("layered_blend") managed 43 %.
  - Random shape parameters did not beat neutral ones (median gain 0).
  - Shifting the incoming cue did not help (median gain 0).
- **What the sweep shows:**
  - Within a window, strategies differ by small amounts (regret 0.02–0.05 score units).
  - Hard failures are properties of the window: cue placement and beat-grid alignment fail at the same rate whatever the strategy.
  - Window choice is exactly what the global planner and the closed loop optimise.
  - A learned performance proposer is therefore not justified by this data, and the rule solver stays.
- **An earlier sweep (`synth_v2`) is discarded.** It was labelled with a rendered onset cross-correlation alignment metric that turned out to be invalid (see below).

### Negative finding: rendered-deck alignment metric

The first closed-loop beat-alignment metric was an onset cross-correlation of the two post-fader decks. Run against Beat This! on the same renders (`evaluation/ml/align_check.eval.ts`), it disagreed in both directions:

- 200+ ms where Beat This! found 0–20 ms;
- about 0 ms where Beat This! found 140 ms.

It was replaced by **grid alignment**: both tracks' Beat This! beats mapped through the executed cue and tempo controls. On the same 10 windows this agrees with Beat This! on the renders:

| Grid alignment | Beat This! on renders |
|---|---|
| 136 ms | 120–140 ms |
| 126 ms | 140 ms |
| 133 ms | 140–180 ms |
| 59 ms | 40–60 ms |
| 6–22 ms | 0–20 ms |

Strictly, this is an analysis-based prediction and not a measurement of the rendered audio. The planner now rejects windows predicted above 60 ms before rendering. All results below use the corrected metric.

## Evaluation protocol

- **Same recordings for every variant:** cached audio and analyses of finished research sets.
- **Five variants:**
  1. existing: production as deployed — MixGraph ordering and ranking, TransitionNet v1 forced on by the UI, DJCritic same-slot selection;
  2. global planning only;
  3. long-form only: production's exact order, cues and overlap lengths, with eligible transitions re-performed;
  4. global planning + long-form;
  5. full closed loop.
- **Rendering:** every transition at 44.1 kHz with the production renderer, covering 8 bars before, the overlap and 8 bars after.
- **Two metric families, reported separately:**
  - the closed-loop metrics. Variant 5 optimises these, so they are circular for it.
  - independent checks it does not optimise:
    - Beat This! beat offsets on each deck;
    - the legacy proxies (bass doubling, maximum level step);
    - level change 8 bars before against 8 bars after;
    - DJCritic as a referee (partly circular for variant 5).
- **Dev and held-out split:** tuning used the dev sets only. Held-out sets share no tracks with techhouse-4. house-2 and heldout-misc share none with either dev set. techhouse-1 shares 2 tracks with the electronic dev set.

| Role | Set | Notes |
|---|---|---|
| dev | research-techhouse-4 | used while debugging the metrics |
| dev | research-2026-11-23T04-15-55 (electronic, creative) | |
| held-out | research-techhouse-1 | no tracks shared with techhouse-4 |
| held-out | research-house-2 | house / EDM / pop, smooth_creative |
| held-out | heldout-misc | 10 distinct songs from the large cache that appear in no other set |

All research sets are local research audio (owner's private, noncommercial research mode). The renders are never deployed or uploaded.

## Results

All numbers use the corrected alignment metric. "Quality" is the closed-loop explicit score (lower = better). The full system optimises that score, so it is **circular for "full"**. The independent checks are:

- **Beat This! > 40 ms:** transitions where Beat This! run on the rendered decks finds a median offset over 40 ms;
- **bass doubling** and **level step:** legacy proxies;
- **level change:** 8 bars before against 8 bars after;
- **DJCritic:** a fixed referee, partly circular for "full".

### Held-out sets (never used for tuning)

| Set | Variant | Quality median | Hard fails | Beat This! > 40 ms | Bass doubling | Vocal clash | Max level step (dB) | Level change (dB) | Dip (dB) | Mean bars | DJCritic quality / artifact | Duration (min) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| techhouse-1 | existing | 1.42 | 4 / 11 | 2 | 0.014 | 0.012 | 6.6 | 4.3 | 3.2 | 11.3 | 0.421 / 0.326 | 39.8 / 40 |
| | global | 0.94 | 3 | 0 | 0.004 | 0.008 | 7.5 | 1.0 | 6.3 | 26.2 | 0.495 / 0.257 | 39.1 |
| | longform | 1.51 | 4 | 2 | 0.012 | 0.009 | 6.8 | 4.3 | 3.4 | 11.3 | 0.410 / 0.325 | 39.8 |
| | global+longform | 0.94 | 1 | 0 | 0.002 | 0.010 | 6.8 | 1.0 | 3.9 | 26.2 | 0.392 / 0.278 | 39.1 |
| | **full** | **0.49** | **0** | **0** | 0.002 | 0.011 | **5.8** | **0.9** | 3.2 | 20.7 | 0.374 / 0.310 | 39.0 |
| house-2 | existing | 1.21 | 3 / 11 | 2 | 0.019 | 0.049 | 5.5 | 3.7 | 2.7 | 11.1 | 0.343 / 0.304 | 43.2 / 45 |
| | global | 1.14 | 1 | 1 | 0.007 | 0.011 | 6.9 | 1.7 | 4.6 | 16.5 | 0.395 / 0.292 | 42.2 |
| | longform | 1.36 | 3 | 2 | 0.013 | 0.049 | 5.6 | 3.7 | 2.9 | 11.1 | 0.340 / 0.288 | 43.2 |
| | global+longform | 1.10 | 2 | 1 | 0.004 | 0.007 | 6.8 | 1.7 | 3.8 | 16.5 | 0.354 / 0.287 | 42.2 |
| | **full** | **0.57** | **0** | 1 | 0.003 | **0.008** | **5.2** | 2.2 | **1.5** | 17.1 | **0.279** / 0.291 | 40.8 |
| misc (8 songs) | existing | 1.54 | 3 / 7 | 2 | 0.026 | 0.010 | 6.9 | 3.8 | 3.4 | 15.4 | 0.315 / 0.254 | 27.6 / 30 |
| | global | 0.82 | 0 | 2 | 0.011 | 0.005 | 5.0 | 3.4 | 2.1 | 12.3 | 0.367 / 0.252 | 27.9 |
| | longform | 1.29 | 3 | 2 | 0.002 | 0.001 | 7.3 | 3.8 | 4.4 | 15.4 | 0.371 / 0.258 | 27.6 |
| | global+longform | 0.68 | 1 | 2 | 0.010 | 0.005 | 5.2 | 3.4 | 2.9 | 12.3 | 0.408 / 0.247 | 27.9 |
| | **full** | **0.23** | **0** | 1 | 0.006 | 0.003 | **4.2** | 2.3 | **1.4** | 18.6 | **0.403 / 0.379 (worse)** | 26.7 |

### Dev sets (round 3, after metric correction)

| Set | Variant | Quality median | Hard fails | Beat This! > 40 ms | Bass doubling | Level change (dB) | Dip (dB) | Mean bars | DJCritic |
|---|---|---|---|---|---|---|---|---|---|
| techhouse-4 | existing | 1.10 | 3 | 1 | 0.024 | 1.3 | 6.7 | 24.7 | 0.485 |
| | full | 0.55 | 1 | 0 | 0.002 | 0.5 | 5.5 | 33.5 | 0.379 |
| electronic (creative) | existing | 1.25 | 1 | 2 | 0.002 | 4.0 | 6.6 | 6.5 | 0.236 |
| | full | 0.62 | 0 | 1 | 0.002 | 3.0 | 3.8 | 4.5 | 0.213 |

### What the evidence supports

- **Better on every held-out set:**
  - **The full system beats production on every held-out set** for the closed-loop score (circular) and for independent hard-failure counts: 10 failing transitions → 0 across 29.
  - Beat This! offsets over 40 ms: 6 → 2.
  - Bass doubling: 3–8× lower.
  - Vocal clash: lower or equal.
  - Maximum level step: lower.
  - Level change between the 8 bars before and after: lower.
  - Energy dips: lower on 2 of 3 sets, equal on 1.
- **Overlaps are longer and phrase-planned:** about 11–15 bars before, 17–21 bars after. The system uses 16, 32, 48 and 64 bars where compatible, and short techniques where the brief or the music calls for them (the creative brief keeps 2-bar creative moves).
- **Each component contributes:**
  - Global planning alone gives most of the hard-failure and level-continuity gain.
  - Long-form performances alone, on production's cues, barely help: their windows were chosen for template blends.
  - Together, plus the closed loop, gives the best result on every set.
- **DJCritic referee is mixed:** better on techhouse-1, house-2 and both dev sets, but **worse on misc** (quality 0.315 → 0.403, artifact 0.254 → 0.379). DJCritic models synthetic severity, not taste. This disagreement is unresolved without listening.
- **Durations run short:** 26.7 / 30 min on misc (−11 %) and 40.8 / 45 on house-2 (−9 %). Longer overlaps shorten the set when the pool has few spare tracks.
- **No listening evidence yet.** Blind A/B pages (existing vs full, global+longform vs full) are generated per set in `C:\crowdpilot-data\mixgen\prodj\<set>\index.html`, with the keys stored separately in `prodj\keys\`. Full mixes for listening are `prodj\<set>\{existing,full}\*.mp3`. **No claim of professional-level quality is made.**


### Changes made after the held-out runs (disclosed)

- **Duration:** a set more than 9 % off the requested length is near-hard-penalised in the planner. The mix validator fails sets outside ±10 %, and the held-out misc set had come out −11 %.
  - Re-running misc gave 27.4 / 30 min (−8.7 %), with 0 hard fails and median quality 0.25 (was 0.23).
  - DJCritic moved to 0.354 / 0.328. It is still worse than production's 0.315 / 0.254 on that set.
- **Validator:**
  - Level jumps in the seconds before a transition starts are the outgoing track alone and are no longer counted.
  - An abrupt cut is justified when the planner had no clean beat-matched window for the pair, and the plan says so.
  - Both were found in the real-audio end-to-end. The −16 dB break at 360–362 s is in the outgoing recording itself.

### Real-audio end-to-end (production Node pipeline)

`evaluation/mixgen.e2e.eval.ts`, job `prodj-e2e-2`: the default prompt (40-minute tech house, 12 tracks), using Jamendo audio.

- Result: 39.7 min, 12 tracks, 11 transitions. 10 are long-form staged blends (16–48 bars); 1 is an echo-out on a pair with no clean beat-matched window.
- The closed loop rendered 94 previews over 4 rounds.
- **Every `validateMix` check passed:**
  - no silence, no clipping;
  - peak −1 dBFS, −11.9 LUFS;
  - level jumps and loudness matching within limits;
  - all splices sample-aligned;
  - no unintended cuts;
  - all rendered transitions passed.
