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

<!-- results filled in from the runs below -->

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

<!-- RESULTS -->
