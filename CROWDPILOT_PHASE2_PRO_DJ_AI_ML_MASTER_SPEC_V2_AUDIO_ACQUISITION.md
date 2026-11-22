> **V2 DATA-ACQUISITION EDITION — 2026-11-21:** This edition preserves the entire original master specification verbatim and adds **Appendix A: Full-Triplet DJ Audio Acquisition, Rights, and Ground-Truth Capture**. The new appendix is **mandatory**, takes precedence over weaker optional acquisition language, and demands actual usable audio and auditable permission records before any waveform-training success claim. It cannot confer third-party rights or guarantee access to famous commercial DJ sets.

# CrowdPilot Phase 2 — Professional DJ Intelligence: Complete AI/ML and Backend Specification

**Status:** Engineering/research specification; not a claim that any model is trained, that any catalog is licensed, or that any application feature works yet.  
**Updated:** 2026-11-21  
**Existing application:** CrowdPilot Phase 1, a DeepSpace-hosted multiplayer music room with search, queue, voting, host roles, playback control, and permissions. **Extend this repository; do not replace or break Phase 1.**  
**Goal:** Build the most rigorous *practically defensible* DJ research and production system possible: measure real audio; reconstruct professional DJ decisions; train specialized musical and performance models; plan constraints-aware sets; perform genuine, enjoyable, reliable transitions; improve with blinded human judgments. **Maximize measured quality and robustness, not model count or unverified claims.**

---

## 0. Critical product and engineering contracts

1. **Guests choose music; host maintains final authority.** Preserve the existing hybrid Jam queue: guests request and vote; the host can pin queue positions or schedule songs; MixGraph may reorder only eligible, unlocked requests and must account for fairness. Add a mode switch for strict FIFO if Phase 1 already supports one, but never silently change an explicit host setting.
2. **Music source and mixing rights are separate from DSP capability.** Train and perform fully featured waveform analysis on actual audio from sources whose acquisition and use are authorized, including relevant research audio with documented rights or lawful basis. A private, noncommercial project does not itself grant access to DRM-protected files, authorize stream extraction, or override providers' terms. **Do not implement DRM bypasses, YouTube/Spotify audio ripping, hidden player interception, or unauthorized catalogs.** If a queued item is a YouTube iframe or other protected player, display it in normal playback mode and mark `waveformMixable=false`; do not claim FFT, EQ, stemming, or crossfading works on its stream. Support host-imported DRM-free files and properly licensed collections for full DJ research. Make the source interface provider-agnostic.
3. **Raw audio is the analytical input.** Never pretend a metadata-only API yields reliable waveform-level beat grids, pitch, LUFS, cue points, or transitions. Every measured field must include algorithm version, data provenance, confidence/quality flags, and, where relevant, uncertainty and correction history.
4. **Learning, not magic.** A pretrained model is not equivalent to a fine-tuned model; a designed GAT is not a trained GAT; weak labels are not human truth; DJ popularity is not a transition-quality label. Never invent data counts, scores, benchmarks, model improvements, or demo outcomes.
5. **Safety of live audio.** No missing track, failed model, stale queue revision, overload, or API outage may crash the session. Use committed plans, preloading, clipping prevention, bounded gain/EQ and fallback to safe playback at musically sensible boundaries.
6. **Deployment separation.** DeepSpace/Cloudflare Workers handle auth, room state, permissions, jobs for orchestration, status, queues and inference requests. GPU-heavy ML training and big-batch waveform inference run *outside* Workers (local Python/GPU or a separately deployed opt-in compute service). The host browser renders latency-sensitive audio with Web Audio / AudioWorklet / approved WASM. Precompute per-track features offline when possible.
7. **Professional DJ creativity is contextual.** Learn technique, timing, tension/release, novelty, journey, groove, dynamics, and deliberate cuts, not solely smooth harmonic mixing. Permit multiple valid styles for the same transition; never maximize smoothness at the cost of variety or user queue commitments.
8. **No premature freeze on scope:** implement the deepest feasible vertical slice first; all advanced models must have usable interfaces and honest status, not decorative toggles. Report budget, dataset access, training hardware, trained checkpoints, and completed tests precisely.

## 1. Desired end-to-end user experiences

### 1.1 Crowd guest
- Join a live room, search and queue catalog items actually available to the room; vote, inspect queued order, observe host locks and committed next song, view playback metadata and reactions.
- Make optional natural-language vibe requests. LLM parses intent into a validated structured preference object; deterministic planner decides; no direct AI mutation of playback state.
- Watch an optional *Vibe Map*: current and proposed energy trajectory, upcoming sections, why tracks were chosen, fairness/explanation notices, estimated arrival of pinned moments. No pseudoscientific emotion inference.

### 1.2 Host/DJ
- Import authorized audio or select a mixable catalog; analyze tracks; see processing progress, per-feature confidence, error messages and manual correction tools.
- Toggle **Standard Jam** (provider-supported handoff, no false mixing claims) vs **AI DJ Research Mode** (fully playable, authorized PCM). A room can include both but a protected-stream track must use its permitted player and safe inter-track handling; never crossfade restricted media.
- Create/lock queue slots, schedule tracks at times, choose DJ persona (smooth, club, exploratory, open-format), mixing aggressiveness, energy target, maximum permissible tempo shift, clean/explicit preference if supported by real metadata, maximum request delay, request fairness, and transition approval mode.
- See dual-deck display: beat grids, waveforms, cues, structure and confidence overlays; preview proposed transitions; compare several candidates; override cue points/techniques, approve/commit or select fallback.
- Optional **Research Inspector**: inspect model versions, retrieved source evidence, edge-cost breakdown, plan feasibility, audio rendering status, confidence, loudness and alignment telemetry.

### 1.3 Research/annotation operator
- Dataset registry with provenance/license/use scope; query source tracks vs reference mixes; inspect alignment overlays; mark reconstructed controls uncertain; annotate cue/downbeat/phrase; conduct blinded transition A/B tests; export versioned labels.
- Model runs dashboard: data version, train/validation/test split, seed, hyperparameters, hardware, metrics, evaluation audio, annotation agreement, known failure modes; deploy/canary/rollback models.

### 1.4 Signature flow
1. Guest adds song X; other guests request Y/Z; host pins Z to upcoming position 4.
2. `queueRevision` changes; immutable plan snapshot is computed with pinned slot and any time lock as hard constraints.
3. Existing track features are fetched; missing mixable audio gets analysis; candidate **region-to-region** transitions are generated.
4. MixGraph jointly selects a feasible ordering, candidate edges, performance technique and timing. Proposed plan explains tempo, phrase, harmony, bass/vocal interference, music direction, fairness, and estimated times.
5. Host authorizes next transition or autopilot commits it within a guarded cutoff. Browser preloads incoming track and executes precisely scheduled Web Audio automation.
6. Clients observe authoritative metadata, not duplicated audio. Outcome and opt-in feedback are logged. Failed ML inference falls back to deterministic DSP.

---

## 2. Systems architecture

```text
AUTHORIZED RAW PCM SOURCES                  RESEARCH DATA / EXPERT LABELS
 local WAV/FLAC/MP3 | permitted files         DJ mixes + source pairs | cue labels | controller logs
                 \                          /
                  AUDIO INGEST + DATA GOVERNANCE
                     -> validated, hashed, versioned assets
                     -> resample/normalize analysis copy (not destructive master)
                     -> MIR/DSP features + beat/downbeat/phrase/metadata confidence
                     -> DJ mix alignment / inverse mix reconstruction
                     -> verified transitions + uncertainty + human annotations
                                   |
                       OFFLINE GPU TRAINING
             cue model | transition scorer | GNN | control model | critic
                                   |
                       MODEL REGISTRY / EXPORT
                        ONNX/weights + schema + versions
                                   |
          DEEPSPACE CONTROL PLANE       <--->  HOST BROWSER AUDIO PLANE
  rooms, queue, votes, locks, presence            playback sources, preloading,
  AI intents, jobs/status, records                AudioContext, worklet, EQ,
  proposed/committed plan, audit                  gains, tempo, effects, meters
                      |                               |
          constraints-aware MixGraph  ------------> executable mix instructions
```

**DeepSpace primitives:** typed collections, `useQuery`, `useMutations`, auth, role validation, `usePresenceRoom`, server actions, background-job orchestration, R2 app files when appropriate, official `.app.space` deployment. Confirm exact signatures from https://docs.deep.space/ at implementation time. Jobs are orchestration, not a GPU platform. Avoid placing large spectrograms/weights/audio blobs in real-time record collections. Use per-room access control and an authoritative commitment coordinator for race-sensitive playback transitions.

**Code separation:** `src/` existing React/DeepSpace app; `packages/audio-contracts/` shared schemas; `packages/mixgraph/` deterministic TypeScript planner; `packages/audio-engine/` browser renderer; `ml/` Python research; `services/inference/` optional remote inference with explicit security and hosting plan; `docs/` provenance, methodology, evaluation and model cards. No redundant database or alternate realtime system unless concretely justified.

---

## 3. Acquisition, provenance, and large-scale dataset program

### 3.1 Priority research resources (verify latest dataset cards, schemas, licenses before ingestion)

| Resource | Official reference | What it contributes | Limitation / verification |
|---|---|---|---|
| DJ Mix Dataset | https://github.com/mir-aidj/djmix-dataset ; https://huggingface.co/datasets/djmix/transitions | Real-world transition metadata, track alignment, cue-in/out and beat indices; associated DAFx study reports 5,040 mixes / 50,742 transitions | Dataset metadata does not imply rights to every linked audio track; inspect fields and per-sample confidence. |
| Raveform (2026) | https://mir-aidj.github.io/raveform/ ; https://reference-global.com/article/10.5334/tismir.288 | 4,902 mix links, 56,873 track links, 1,423 expert structurally annotated tracks (paper counts); phrase/functional structure | Mix links and structural annotations are not a ready-to-train licensed audio corpus. Confirm available download files. |
| EDM-CUE / CUE-DETR | https://huggingface.co/datasets/disco-eth/edm-cue ; https://github.com/ETH-DISCO/cue-detr | ~21k expert cue marks over ~4.7k EDM tracks; pretrained cue-prediction architecture/checkpoints | Primarily metadata/annotations; raw audio licensing and checkpoint terms require separate checks. |
| UnmixDB | https://zenodo.org/records/1422385 | Open-licensed excerpts and synthetic DJ mixtures with known source/mix alignments for reproducible regression tests | Limited excerpts and synthetic mixtures do not capture full expert creativity. Check each license/asset. |
| Beat This! | https://github.com/CPJKU/beat_this | Pretrained beat/downbeat tracker useful as a reference or ensemble member | Verify checkpoint license, version, setup and generalization. |
| Essentia | https://essentia.upf.edu/ | Rhythm, tonal, spectral, loudness and structure-related extractors | Verify library license and runtime availability; compare algorithms rather than blindly combine. |
| MERT (optional) | https://github.com/yizhilll/MERT ; https://huggingface.co/m-a-p/MERT-v2-30s | Music representations for candidate ranking | Check individual checkpoints and noncommercial/commercial terms; costly inference. |
| MixWeaver (ISMIR 2026) | https://ismir2026program.ismir.net/poster_428.html | Structured stem-aware transition optimization; interpretable benchmark inspiration | A research method, not a plug-and-play licensed music source. |
| DAFx 2022 fader/EQ estimation | https://dafx.de/paper-archive/details/f2sQEJSkwA4mhZ83iKqc4A | Model-based recovery of time-varying DJ mixer gains from source tracks + reference | Inverse reconstruction has ambiguity and alignment error; pseudo-labels only until checked. |
| PyTorch Geometric GATv2 | https://pytorch-geometric.readthedocs.io/en/latest/generated/torch_geometric.nn.conv.GATv2Conv.html | Edge-aware graph model implementation (`edge_dim`) | Requires supervised/reliably weak-labeled data; cannot promise quality gains. |

### 3.2 Additional dataset channels, prioritized by label quality

**Tier A — Direct multitrack and controller-capture sessions (best supervision):** Recruit consenting DJs, record authorized source assets and the mix output, simultaneously logging MIDI/HID device events, faders, EQ, filters, loop triggers, FX settings, beatgrid edits, jog nudges, controller timestamps, BPM/pitch adjustments, deck source timeline, scene context, any human ratings. Build a small expert core dataset and anonymize performer identifiers as appropriate. This is the only reliable way to know the *actual* control trajectories rather than infer them.

**Tier B — Aligned professional mixes with matching source tracks:** Ingest verified metadata and authorized reference+source audio; align songs to set; recover cue placement and mixing parameters with confidence; human audit. High volume but weaker parameter labels.

**Tier C — Open/synthetic generated mixes:** Using licensed/owned songs, render hundreds/thousands of known transitions with parameter sweeps across beat timing, cue offsets, bass-swap positions, crossfade curves, time-stretch ratios, EQ shapes, effects. Ground truth known exactly. Use to pretrain the inverse model and detection tests; avoid biasing final critic toward obviously artificial templates.

**Tier D — Human pairwise judgment and room feedback:** Provide blind A/B comparison, multi-criteria ratings, DJ reasons, preference rater reliability, uncertainty labels and context. Live guest votes are preference signals about songs, not evidence of mix quality; don't conflate them.

### 3.3 Scalable collection strategy

- Registry-first ingestion from official source files, with **no automated unauthorized audio downloads**. Support `metadata_only`, `authorized_audio_attached`, `training_permitted`, `evaluation_only`, `no_redistribution` statuses. For unclear rights, keep metadata only.
- Normalize identifiers: source dataset, recording/video IDs, title/artist/ISRC if truly known, release/version, fingerprint only where permitted, sample hashes, acoustic edit IDs. Don't conflate remixes, edits, live versions or repeated songs.
- Create a **quality cascade**: imported → checksum/duration verified → tracklist matched → audio aligned → alignment confidence gate → control reconstruction → reviewer approval → labeled for a specific training task.
- Deduplicate across datasets, DJs, venues, mixes, work IDs, artist aliases, remasters, bootlegs, and track excerpts. Record why each pair matched.
- Stratified diversity sampling: techno/house, drum & bass, hip-hop, open-format, funk/disco, pop, Latin, mixed meter, live drumming, syncopation, transitions with vocals; balance long vs short blends, EQ swaps, cuts, bridges, echo outs and deliberate tempo jumps.
- Curate performance **quality** from expert panel and reliable recording/annotation quality, not celebrity/popularity alone. Maintain a diversity and difficulty curriculum.
- Use active learning: identify high-uncertainty transitions, disagreement among models, underrepresented tempos/styles; request human annotations first on those samples.
- Data budgets/logistics: keep raw audio in access-controlled object store or local dataset mounts; version training manifests and derived features in Parquet; models as artifacts; never git-commit copyrighted songs or sensitive user uploads.
- Document source URLs, citation, author/DJ, retrieval date, license, permitted uses, consent, transformation lineage, and takedown process. Allow withdrawal and dataset rebuild.

### 3.4 Data contracts (suggested, versioned)

`tracks`: `track_id`, `work_id`, `recording_id`, `artist`, `title`, `version`, `duration_sec`, `audio_sha256`, `source_adapter`, `license_status`, `waveform_mixable`, `sample_rate`, `channels`, `bit_depth`, `provenance_id`.

`mix_sessions`: `mix_id`, `dj_id_or_anonymous`, `style`, `source`, `date`, `rights_scope`, `mix_audio_ref`, `tempo_profile`, `estimated_tracklist_quality`, `annotation_quality`.

`transition_labels`: `transition_id`, `mix_id`, `source_a`, `source_b`, `a_exit_cue_sec`, `b_entry_cue_sec`, `mix_start_sec`, `mix_end_sec`, `overlap_sec`, `beat_phase_ms`, `tempo_ratio_a/b`, `technique`, `mixing_controls_ref`, `label_kind` (`human_controller`, `human_annotated`, `inverse_estimated`, `synthetic`), `confidence`, `review_state`, `feature_version`, `rights_scope`.

`controller_events`: time-monotonic `deck_id`, `parameter`, `value`, `unit`, `device`, `clock_calibration`, `latency`, with separate human vs machine provenance. Normalize actions to physical units (dB, Hz, seconds, semitones, 0–1 control) and sample to consistent beat/time positions.

`human_pairwise`: two transition IDs, blind order randomized, context descriptor, `winner/tie/uncertain`, separate quality dimensions, rater ID, qualified-DJ flag, time, attention-check status, consent.

`model_runs`: run ID, code/git commit, dataset manifest sha256, split version, config, seeds, checkpoint path/hash, hardware, training logs, per-split metrics, limitations, license summary.

Do not place large arrays on individual synchronized DeepSpace records; store compact summaries and dereference immutable versioned artifacts.

---

## 4. DSP and Music Information Retrieval measurement pipeline

**Rule:** For every inferred physical/musical quantity provide (a) implementation, (b) alternative/baseline, (c) window/hop settings, (d) units and timestamps, (e) confidence and failure policy, (f) evaluation data and method.

### 4.1 Audio preprocessing and QC

- Validate MIME and decoded format, length, channels, clipping, silence, corruption, channel offset, stereo phase, corrupt frames. Decode source to float32/float64 PCM. Retain original stereo master for playback; create a separate mono analysis stream as appropriate. Avoid unsafe downmixing of phase-opposed stereo material.
- Normalize analysis sample rate (e.g., 22,050 or 44,100 Hz depending on model); use anti-alias resampling and record exact mapping to source sample indices. Set all output cue timestamps in **source-time seconds and source sample index**, not arbitrary analysis frames.
- Record sample/true-peak, RMS, integrated and short-term LUFS (EBU R128 where available), loudness range, silence segments, clipping percentage; compare results to actual reference implementations.
- Deterministic cache key: SHA256 of audio + feature schema/version + model checkpoint + preprocessing config. Log resampling, codec and decoder versions.
- Time alignment across rendered audio, source recordings, controller signals, recorded DJ set, and wall clock should use a calibrated monotonic clock mapping. Document offsets/drift.

### 4.2 Fourier and time-frequency representations

Compute multiresolution STFT: for signal `x`, `X(m,k)=sum_{n=0}^{N-1} x[n+mH]w[n]exp(-j2πkn/N)`; log magnitude, power, phase, spectral flux, multiband energies. Example starting sizes at 22.05 kHz: N=1024/2048/4096, hop 256 or 512, Hann; *sweep rather than assume optimal*. Use larger windows for bass/pitch and shorter for transient timing. Add log-mel spectrogram and CQT/HPCP/chroma for tonality. Test time-frequency and phase behavior on synthetic tones/chirps/impulses.

### 4.3 Tempo, beat, downbeat and meter

- Onset strength: positive spectral differences, per-band/percussive-weighted onset envelopes, HPSS assistance.
- Candidate tempos: autocorrelation/tempogram and Fourier tempogram with half-/double-time hypotheses and uncertainty, especially at 70/140 BPM; avoid claiming sub-0.01 BPM precision if evidence doesn't support it.
- Beat tracker: classical DP or Essentia rhythm baseline plus pretrained Beat This! for beats/downbeats. Do not blindly average timestamps; compare beat activation and alignment under tempo hypotheses. Use beat-level confidence, local tempo curve, rubato/tempo-change flags.
- Downbeat and meter inference, 3/4/4/4 etc; hierarchical bar/4-/8-/16-/32-bar structural hypotheses; detect changes. Offer manual tap tempo and editable grid, anchors, offset correction and source-time mapping.
- Calibration: beat/downbeat F1 (e.g. standard ±70ms benchmark tolerance), continuity, phase drift (ms per bar), BPM errors with octave-corrected and strict variants. Stress percussion-free intros, breaks, mixed meter and half-time.

### 4.4 Harmonic, pitch and chord analysis

- CQT/chroma/HPCP, global tonic/mode and **local key/chroma and chord trajectories** in potential overlap regions.
- Relative major/minor, fifth relationships and Camelot mapping as heuristics only. Compare local chroma similarity; compute dissonance/consonance proxy, chord-change conflicts; allow percussive sections to relax key requirements.
- Optional melody/pitch tracking for salient lead lines, pitch contour and timbral interference; pitch estimates are instrument-dependent and uncertain in polyphonic mixes.
- Score transposition and time-stretch with artifact penalties; warn about excessive pitch shift. Evaluate key class, chord boundary/chord accuracy and human harmonic-clash judgment.

### 4.5 Structure, segmentation and cue candidates

- Self-similarity matrices over beat-synchronous chroma, MFCC, timbre and onset descriptors; novelty checkerboard kernels; structural segmentation; optional pretrained or fine-tuned labels intro/outro/build/drop/breakdown/chorus/verse.
- Distinguish *boundary detection* from *semantic phrase labeling*; a novelty peak is not proof of a “drop”. Use meter-aware bar-grid quantization and evaluate 4-/8-/16-bar windows with learned cue models (CUE-DETR/EDM-CUE where permitted).
- Candidate entry/exit windows must respect track playable duration, minimum preview length, vocal intensity, percussion independence, low/hi spectral load, confidence, structure label, and user-configured early-exit/mid-track rules. Identify both *safe* and *creative* candidate positions, with separate risk values.
- Metrics: structure boundary P/R/F with tolerance; cue error in beats/seconds; expert-approved candidate recall@K; diversity of usable cue proposals.

### 4.6 Energy, groove, timbre, perceptual quality

- Integrated/short-term LUFS, true peak, RMS and crest factor; beat-synchronous loudness and dynamics; onset/transient density, spectral centroid/rolloff/contrast, MFCCs, sub/low/mid/high band energies, spectral entropy.
- Tempo/groove: beat swing, microtiming, kick/snare/hi-hat periodicity, syncopation proxies, rhythmic pattern embeddings.
- Vocal activity using a validated model or optional stem separation; use *vocal collision likelihood* over overlap, not a binary whole-song `hasVocals` flag. Track instrumental lead overlap, percussive density and bass clash separately.
- Optional stem separation for bass/drums/vocals/other only if resources and licensing permit. Log bleed/artifacts and never pretend separated stems are exact sources.
- Novelty/surprise: compare embeddings in style-space against recent songs and genre target; target a calibrated moderate surprise rather than maximize novelty. Embeddings (e.g., MERT) are not themselves a DJ transition predictor.
- Loudness matching should use perceptually relevant meter and guard against summed true-peak clipping; gain curves should not inadvertently create pumping, jumps, clicks or harsh resonance.

### 4.7 Quality and confidence gate

Aggregate warnings and independent evidence: `BPM_AMBIGUOUS`, `BEAT_GRID_LOW_CONFIDENCE`, `DOWNBEAT_UNCERTAIN`, `STRUCTURE_UNCERTAIN`, `HARMONIC_CLASH`, `VOCAL_COLLISION`, `BASS_CLASH`, `TRANSIENT_RISK`, `PITCH_SHIFT_TOO_LARGE`, `INSUFFICIENT_AUDIO`, `NOT_MIXABLE`. Low confidence must select a safer technique or request host correction. Quality fields are estimates and should be calibrated against annotated samples.

---

## 5. Recover real human-DJ actions from reference mixes

### 5.1 Tracklist matching and coarse alignment

1. Validate the exact recording/version, not just title. Metadata-only tracklist ID is insufficient.
2. Compute beat-synchronous chroma / CQT, onset/rhythm descriptors and optionally fingerprint features when permitted for reference mix and sources.
3. Align source-to-mix using subsequence DTW robust to tempo/phase changes, followed by local fine alignment (spectral cross-correlation, transient matching, time-warp map). Allow full-track variations and tempo drift.
4. Estimate the time warp `phi_source(t_mix)`, beat phase, cue-in/out, overlap duration, and per-track tempo ratio. Independently verify against provided DJ Mix Dataset metadata where available.
5. Measure confidence from alignment path smoothness, ambiguity, source similarity, alternate candidate margin, audio overlap and human spot checks; reject weak labels from primary training.

### 5.2 Inverse performance reconstruction

Physical mixture approximation: `y(t) ≈ g_A(t) EQ_A(x_A(phi_A(t))) + g_B(t) EQ_B(x_B(phi_B(t))) + ε(t)`; residual includes effects, mastering, crowd, unknown stems and source mismatch.

- Estimate fader and low/mid/high EQ gains in segments using convex or differentiable optimization, constrained smoothness, bounded physical ranges, gain regularization and prior knowledge of DJ technique. Distinguish channel gain, track loudness and master gain.
- Use multi-resolution spectrogram and/or waveform reconstruction losses, loudness/true-peak penalties, derivative/slew penalties, sensible priors, and calibration on synthetic mixes with ground-truth controls.
- Do not infer exact historical knob turns where the inverse problem is non-identifiable. Store distributions or intervals, residual diagnostics, uncertainty and `pseudo_label` flags. Limit imitative training weights for high-uncertainty reconstructions.
- Handle crossfades, bass swaps, low-pass sweeps, simple filters, hard cuts, beat loops; special effects like echo/reverb/scratching should be assigned `unsupported/unknown` if not modeled.
- Compare reconstruction on UnmixDB/synthetic set with known controls, and on verified human controller-capture sessions. Evaluate timing, fader dB MAE, EQ-curve MAE, multi-resolution spectral distance, boundary artifacts and expert ratings.

### 5.3 High-fidelity controller data collection

Capture Deck A/B track file IDs/hashes, beatgrid edits, source cue offsets, playbackRate/tempo target, audio clock, volume faders, channel trims, three-/four-band EQ, filters, FX, loop events, crossfader, technique labels, and per-event monotonic timestamps. When recording source+master simultaneously, measure MIDI/control latency to audio, compensate systematically, and version device/calibration. Obtain player/DJ consent. This is gold supervision for TransitionNet.

---

## 6. MixGraph: constraint-aware, directed, **region-level** planning

### 6.1 Graph definition

Each physical song may have multiple entry and exit region candidates; each *directed* transition edge represents `(track_A, exit_region, track_B, entry_region, overlap_bars, tempo_plan, technique, EQ/fader policy, risk)`.

Nodes may be track segments, or track-level nodes with multi-edge transition alternatives. Do not mistake global song similarity for region-level mix compatibility. Each edge stores vector `z=[tempo_delta, beat_phase, downbeat_align, local_chroma, harmonic_conflict, segment_pair, vocal_overlap, bass_overlap, timbre, loudness_delta, energy_change, transition_duration, time_stretch_artifact_risk, novelty, uncertainty]` and a calibrated cost. Retain per-edge explanations and rejected alternatives.

### 6.2 Transition policies

Implement **at least**: safe cut on downbeat, short equal-power crossfade, long phrase-aligned crossfade, low-frequency bass handoff, percussive transition, intentionally abrupt phrase cut; later optional echo-out, filter sweeps, loop bridges, beat juggling. Hard limits on key/time changes, EQ gain, filter resonance, fade duration, peak level, cue bounds, and waveform availability. Creativity can choose a legitimate cut instead of forcing every pair into a long beatmatch.

### 6.3 Hybrid queue invariants

- The playing track and committed next transition are immutable without explicit host override.
- Guests submit queue items; requests have stable IDs and deterministic admission order. Repeated song IDs may be allowed/merged per host policy; voting is uniqueness-checked per member.
- Host position locks fix the specified *upcoming play slot*; time reservations fix a requested start wall-clock time with tolerance. Conflicting/impossible constraints yield clear errors, never silent violation.
- AI may reorder only eligible unlocked items. Every accepted request is accounted for; max request age/slot delay and vote-weight/fairness constraints are independently tunable and auditable.
- Time feasibility uses effective track playback durations and overlap/cue timing, plus lower/upper bounds for remaining segments; don't assume original whole-track duration. Do not auto-cut mid-song merely to satisfy a timer unless explicitly permitted.
- Queue updates are revisioned; plans snapshot `(queueRevision, lockRevision, playbackEpoch, featureVersions, modelVersion)` and are committed only if fresh. Host device owns audio; server owns canonical commitment state.

### 6.4 Planner objective

For plan `P`, minimize `Σ C_transition(e) + λ_F fairness(P) + λ_V vote_delay(P) + λ_E energy_trajectory(P) + λ_R repetition(P) − λ_C calibrated_creativity(P)` under all hard constraints. Critical: scaling and sign conventions documented; optimize set arc while not sacrificing hard constraints or audible safety. Use bounded beam search for short horizon, exact DP/ILP on toy cases for correctness baseline, and constraint pruning. Never rely solely on the GNN to enforce locks/time slots.

### 6.5 Multi-step musical direction

Track preceding 3–10 tracks, momentum in energy/key/genre, variety of transition techniques, builds/drops, surprise budget, crowd explicit preferences and host DJ personality. Propose alternative plans with scored trade-offs. A context model can recommend different transitions for identical A/B pairs depending on set position.

### 6.6 Explainability

For every proposed edge display: BPMs and local tempo changes, beat/downbeat confidence, source section and cues, local key compatibility, vocals and bass risks, transition technique, estimated overlap, fairness/host-lock considerations, uncertainty, calibrated rank/model version. Avoid LLM-invented measurements; provide explanations from actual planner feature contributions.

---

## 7. Learning architecture and optimization

**Separate algorithms by scientific task.** Only ship a trained model when there is a real checkpoint and held-out evaluation.

### 7.1 Model A — CuePointNet
- Baselines: bar/phrase/energy/structure heuristics; EDM-CUE/CUE-DETR pretrained checkpoint if permitted and available.
- Features: beat-synchronous STFT/mel/chroma/energy/structure and model embeddings.
- Outputs: calibrated probabilities for intro/outro, mix-in/mix-out, downbeat-aligned cue candidates, uncertainty and top-K alternatives.
- Loss: cue-position matching/regression or event detection with tolerance, class imbalance, multi-expert ambiguity. Metrics: cue recall@K, median beat/second error, calibration, genre generalization.

### 7.2 Model B — Baseline transition ranker (must beat before GNN)
- Inputs: edge DSP features, source/destination metadata and local context.
- Train weighted heuristic, logistic regression, LightGBM/XGBoost if dependencies available, small MLP. Do not call an unobserved alternative a bad transition. Use matched hard negatives, confounder controls and explicit context.
- Objectives: imitation ranking (`observed DJ choice` as weak positive); separately pairwise human preference ranking. Reweight by label confidence and selection bias. Calibrate scores and show counterfactual comparison against random, BPM-key-only and structured DSP baselines.

### 7.3 Model C — Edge-aware GNN / MixGraph-GAT
- Graph nodes represent segment or song context; edges contain candidate transition features. Start with edge-aware GATv2 (e.g., 2 layers, 4 heads, 128-d latent, edge_dim from actual schema; tune). GNN outputs `q_hat(edge, set_context)`; uncertainty via ensembles or MC dropout only if calibrated.
- Context encoder for last 3–5 tracks or 60–120s musical arc; shared embedding with ranker. Avoid transductive leakage between held-out tracks and graph neighborhood. The graph must include *unseen candidate edges at inference*; otherwise the model may memorize identity.
- Train pairwise/listwise supervised ranking, optional auxiliary technique classification and remaining-arc preference tasks; proper negative mining and class balancing.
- Ablations: no GNN / GNN without edge features / without structure / without vocal or bass features / without set context / pretrained embeddings vs DSP; require meaningful improvement with confidence intervals. If GNN doesn't improve, ship simpler ranker.

### 7.4 Model D — TransitionNet (execution policy)
- Input: source and destination beat-synchronized audio/feature windows, cue candidates, target tempo, technique, context and optional DJ style.
- Output: constrained temporal trajectories for each deck: source playback/time map, gain/fader, low-mid-high EQ gains, filters, optional simple effects, with timestamps tied to beat/sample clock. **Do not predict raw PCM audio or blindly play neural output as sound**; render with deterministic tested DSP modules.
- Start with **technique-conditioned template library**; then temporal CNN/Transformer or diffusion over *controls* once direct/pseudo-label data supports it. Avoid training huge models on weak reconstructions.
- Loss: supervised control-curve Huber/MAE weighted by source reliability; multi-res spectral/log magnitude difference on renderer output where permitted, onset/beat synchronization, phase/transient quality, loudness and clipping penalties, regularization on slew rate, technique validity. Use a renderer differentiability strategy explicitly; don't falsely claim browser Web Audio itself is differentiable.
- Preserve modal diversity: multiple equally valid styles; conditional labels, probabilistic policies, candidate sampling + critic reranking. Report how chosen technique was selected.

### 7.5 Model E — DJCritic (listening preferences)
- Task: given **rendered audio** and set context, predict which of two legitimate transitions listeners prefer. Model must see enough context and audio to avoid purely metadata-driven judgments.
- Annotation: randomize A/B presentation, level-match responsibly, blind model/source, collect preferred/tie/uncertain + technical smoothness, phrase coherence, groove, bass/vocal cleanliness, creativity, energy trajectory, perceived fatigue and style fit. Separate expert DJ and casual room-listener strata; rater consistency, repeat judgments, uncertainty, consent.
- Loss: Bradley–Terry-style pairwise `−log σ(r_A−r_B)` with ties/abstentions, uncertainty-aware weighting; report held-out pairwise accuracy, calibration, preference win-rate with bootstrap CIs, bias by genre and DJ.
- Optimize via **offline candidate generation and reranking** first. Do not launch unconstrained online RL that risks live playback or optimizes popularity at expense of committed requests. Logged bandit/off-policy experimentation only with suitable policies, propensities, consent and evaluation.

### 7.6 Creativity and DJ styles
- Controls: `smooth`, `club`, `adventurous`, `open-format`; future `hip-hop cuts`, `bass-heavy`, etc. These are documented target behaviors, not impersonations of named DJs.
- Formalize coherent surprise: avoid too-similar consecutive songs *and* random jumps; use style-switch penalty/bonus, genre arc, tension/release, novelty budget, transition technique diversity, motif recurrence, crowd preference fairness.
- Use multiscale horizons (beat → bar/phrase → song transition → 3–10-song arc) with rule-based feasibility and learned quality. Consider hierarchical policy and sequence model only when dataset supports it.
- Offline DJ reference imitation is a weak source of taste. A professional DJ chose one of many possible good songs; preference labels and ablation tests are necessary to learn perceived quality.

---

## 8. Training procedure and curriculum

| Stage | Required output | Promotion gate |
|---|---|---|
| S0 — Registry/data validation | Versioned manifests, licenses, checksums, schemas, splits, ingestion tests | No missing provenance; known audio availability and allowed use |
| S1 — MIR DSP | Reproducible STFT/tempo/beats/chroma/phrase/loudness extraction | Beat, tempo, cue baseline metrics and confidence on held-out labels |
| S2 — Reconstruction | Source-to-mix alignment, estimated cue/overlap/controls, synthetic exact-label tests | Measurable timing/control error; uncertainty gating and expert spot checks |
| S3 — Planner baseline | Valid queue/lock/time search and executable mixing templates | Hard-constraint property tests, deterministic runs, no clip/glitch regressions |
| S4 — Cue/transition learning | CuePointNet, ranker and optional GATv2 with checkpoints | Held-out improvement over heuristics and no identity leakage |
| S5 — Performance learning | TransitionNet templates → learned controls | Audible A/B quality; no regression in safety metrics |
| S6 — Human preference/creativity | DJCritic, annotation workflow, reranking and constrained personalization | Significant preference win-rate versus strongest baseline on unseen tracks |

**Curriculum:** start with 4/4 quantized house/techno, clean DJ source pairs; expand to DnB half-time, hip-hop and open-format with tempo jumps, structure changes, sparse intros and vocals; later humanized/live-tempo sets, mixed meters and special effects. Maintain a challenge set throughout. Don't overfit easy electronic 4/4 data and claim universal accuracy.

**Splits:** by mix and by DJ, by song/work/recording family (including remixes/remasters near-duplicates), optionally by artist/genre for OOD; hold out source recordings from train and test and avoid the same professional performance appearing via multiple dataset mirrors. Track-based splits are crucial for product use. Version all split rules and seeds, produce leakage audit.

**Experiment tracking:** reproducible config (Hydra/YAML optional), deterministic seeds and versions, logging (MLflow or W&B local alternative), GPU specs and time/cost, data manifest hash, model artifacts and signed model card. Validate checkpoint loading and inference schema. Never commit training audio or huge weights to GitHub.

**Model calibration:** report calibration error and reliability diagrams; segment by tempo, genre, audio quality and confidence. Cost-sensitive decisions: if model uncertain, fallback to conservative transition, not risky creativity.

---

## 9. Audio renderer and runtime realism

### 9.1 Browser two-deck engine
- Single host AudioContext as audible authority; load/decode authorized PCM, preserve stereo; decks A/B with gain, three-band parametric EQ or Linkwitz-Riley-style band separation if deliberately implemented, filters, master gain/limiter/meter, scheduled source start/stop. Use `AudioParam` automation at exact `audioContext.currentTime`, never JS timers for sample-critical mixing.
- Equal-power gain crossfades (`cos`/`sin` window) and beat/phrase-aware transitions; bass handoff with crossover and phase/latency assessment; compare technique presets by offline renders.
- Time stretching without pitch changes: investigate correctly licensed WASM implementation or pre-rendered tempo-adjusted files (Rubber Band is GPL/commercial dual-licensed). Standard `playbackRate` shifts pitch—identify limitation, never claim otherwise. Account for time-stretch latency/phase and artifact cost. Reject excessive tempo shifts.
- No abrupt clip: equal-power fade can still overload with correlated signals; meter post-mix; target headroom, clamp automated gain, true-peak safety and configurable limiter. Avoid unbounded filters/feedback.
- Latency and clock: host-only audio engine, explicit transport state machine `idle/preloading/ready/playing/transitioning/paused/error/recovering`, audio context unlock on user gesture, preloading deadlines, idempotent `transitionCompleted` event, play epoch tokens, reconnect state reconciliation. Guest device metadata is approximate and not sample-sync playback.
- Degraded policies: no mixing rights → normal supported player; source unavailable → skip or notify; feature missing → safe cut/fade with human confirmation; GNN timeout → heuristic ranker; training model failure → known-good technique; host disconnect → pause and release lease; lock infeasible → never silently override.

### 9.2 Transition plan schema (illustrative; implement shared TS/Python validation)

```json
{
  "planId": "plan_042",
  "roomId": "room_072",
  "queueRevision": 18,
  "lockRevision": 5,
  "playbackEpoch": 3,
  "featureSchemaVersion": "mir-v2",
  "modelVersion": "heuristic-v1",
  "outgoingQueueItemId": "q_a",
  "incomingQueueItemId": "q_b",
  "outgoingCueSeconds": 188.44,
  "incomingCueSeconds": 12.08,
  "transitionDurationBeats": 32,
  "tempoTargetBpm": 124.0,
  "technique": "bass_swap",
  "automationRef": "signed-or-local-ref",
  "predictedStartUnixMs": 1795300000000,
  "sources": {"outgoingMixable": true, "incomingMixable": true},
  "quality": {"beatGridConfidence": 0.91, "riskFlags": []},
  "status": "proposed"
}
```

Require playback timestamps **both source-relative seconds and audio-clock scheduling positions** in runtime. Typed unit validation; lengths/cue bounds and asset hashes checked before commit. Avoid exposing private source file paths to guests.

---

## 10. DeepSpace data model, APIs and permissions

### 10.1 Preserve Phase 1 records

Inspect and migrate existing schema, don't assume identical names. Add logically:
- `audio_assets`: owner, trackId, SHA256, license/provenance, `waveformMixable`, local-only vs stored, decoding status. Do not store host-local files in shared records.
- `analysis_jobs`: track/asset hash, source, status (`queued/running/failed/completed`), percent, error, feature version, model/checkpoint, timestamps, retry count. Heavy processing outside Worker; DeepSpace job is status/orchestration.
- `track_features`: compact BPM/key/meter/energy/confidence, `featureBlobRef`, analyzer version, warnings and correction ID.
- `cue_candidates`: track/section/beat, kind, probability, humanApproved, feature version.
- `transition_candidates`: source+destination asset hashes/versions, cue pair, technique, overlap, score breakdown, risk flags, effect config, model version.
- `mix_plans`: complete candidate plan snapshots, queue/lock revisions, timestamps, state proposed/committed/played/rejected, explanation and estimated feasibility.
- `model_registry`: model name, framework, checkpoint hash, feature/schema, deployment status, authorization/license, benchmark report ref, rollback target.
- `mix_feedback`: sessionId, transitionId, listener role, rating or blind-pair selection, explicit consent and retention policy.
- `research_annotations`: restricted reviewer-only dataset labels, provenance, confidence, review decision, audit history; never expose authorized source audio in a guest feed.

### 10.2 Server actions (suggested names; implement with docs-verified SDK)

`requestTrackAnalysis`, `getAnalysisStatus`, `proposeMixPlan`, `commitMixPlan`, `setMixStyle`, `submitHostCueCorrection`, `submitTransitionFeedback`, `getModelInfo`, `cancelAnalysisJob`, `previewTransition` (only for authorized assets), `retryPlanning`, `overrideCommittedTransition` (explicit host role and logged reason).

All must validate caller identity, room membership, current host authority, audio rights capability, queue/lock revision, payload sizes, rate limits and idempotency. Do not put privileged API keys or model secrets client-side. Use host lease/epoch for concurrent host tabs.

### 10.3 Permissions, privacy and costs

- Guests can read only authorized room metadata and submitted queue items, never private audio, raw contributor identifiers beyond designed profile fields, or research labels. Host owns playback and locks; researcher/admin sees dataset tooling; all sensitive writes in validated server actions.
- Default audio processing is host-local when feasible; remote inference optional with explicit host consent, clear data retention, deletion and bandwidth implications.
- Cloudflare Workers are not GPU training environments. Use background jobs for orchestration/progress and a separate queue/worker if throughput demands; if no external GPU is configured, local CLI pipeline is fully functional.
- Cache feature computations by content hash and analyzer version; cap concurrent analysis, R2 size/quota, token/API use, job retries, streaming status. Test mobile memory and desktop/browser decode limits.
- DeepSpace `.app.space` deployment is target; GitHub is source control. Do not migrate to Vercel or add a new backend without explicit reason.

---

## 11. Evaluation and objective acceptance

**No fabricated “99% accurate DJ” claim.** Benchmarks must state sample sizes, datasets, baselines, CI/error bars, and limitations. A first version that is reliable and outperforming basic crossfade on blinded judgments is better than an unsupported “world-class AI DJ”.

| Dimension | Tests/metrics |
|---|---|
| Beat/downbeat | Beat F1 ±70ms convention, downbeat F1, tempo strict+octave-corrected, beat phase drift per 8/16/32 bars |
| Key/harmony | Global/local key accuracy, chord transition confidence, listener harmonic-clash scores |
| Structure/cues | Segment boundary P/R/F, cue timing error in beats and seconds, human-approved cue recall@K |
| Mix alignment | Source-to-mix timing drift, overlap error, successful track-identification precision, false alignment rate |
| Recovered controls | Fader/EQ dB MAE against logged synthetic/human control signals; residual spectral loss and confidence calibration |
| Ranking | Pairwise/listwise rank metric, Recall@K for observed DJ choices *as imitation*, preference win-rate and bootstrap CI |
| Technique performance | Beat/downbeat alignment ms; percentage of clipped/true-peak violations; LUFS jumps; click/transient artifact tests; human smoothness and groove scores |
| Long-form DJ creativity | 20–45-minute set evaluations, energy arc fit, context-sensitive surprise, technique diversity, guest-request completion and fairness |
| Distribution shift | Unseen tracks, unseen DJs, unseen genres, source degradation and open-format jumps |
| Infrastructure | Two-browser real-time convergence, stale plan rejection, host roles, lock feasibility, preloading, dropout recovery, audio resource cleanup |

Compare **baselines** (FIFO+gap, FIFO+fixed crossfade, BPM/key heuristic, phrase-aware heuristics, learned ranker, GNN, TransitionNet, human reference when legally/experimentally appropriate). For neural results use ablations and seed stability. Separate DJ-expert and general-listener outcomes. Keep subjective preference uncertainty and disagreements visible.

**Automated test library** must include synthetic click-track BPMs, silence, sine tones/chords, variable tempo, syncopation, rubato, mismatched meter, phase-offset stereo, low quality MP3, missing audio, impossible host schedules, empty queue, corrupted feature cache, two hosts, duplicate events and script cancellation. Render/inspect WAVs and numerical post-render analysis; listening tests cannot be replaced with unit tests.

**Audio listening methodology:** level-match comparison clips without erasing intended dynamics; same track pair/cue candidate pool; blind/randomized A/B; include original reference only with proper permissions; rate both technical and creative outcomes; stratify across genres/beat qualities; report CI and annotator agreement.

---

## 12. Proposed repository structure

```text
crowdpilot/
  src/                          # Existing React/DeepSpace application (preserve)
    actions/                     # docs-verified host, plan, analysis server actions
    components/ai-dj/            # host console, beatgrid, preview, confidence UI
    schemas/                     # compact realtime records
  packages/
    audio-contracts/             # Zod/TypeScript/Python shared versions and units
    mixgraph/                    # deterministic constraints, beam search, baselines
    audio-engine/                # browser dual deck, Web Audio/worklets, DSP
    music-sources/               # capability-aware provider adapters
  ml/
    configs/                     # versioned configs/seeded experiments
    datasets/                    # registry, ingest, rights, dedup, splits
    audio/                       # Fourier, beatgrid, harmonic, structure, loudness
    alignment/                   # source-to-mix, DTW, control reconstruction
    synthetic/                   # licensed synthetic mixes and known-control labels
    models/                      # CuePointNet, transition ranker, GNN, TransitionNet, DJCritic
    training/                    # supervised, imitation, pairwise, control training
    evaluation/                  # metrics, null baselines, render tests, blind A/B
    inference/                   # model export and stable callable inference
    tests/                       # DSP signal invariants and data-quality tests
  services/inference/            # optional inference service, not assumed deployed
  docs/
    DJ_AI_ARCHITECTURE.md
    DATASET_REGISTRY.md
    DATA_RIGHTS_AND_PROVENANCE.md
    TRAINING_PLAN.md
    EVALUATION_PROTOCOL.md
    MODEL_CARDS.md
    DEPLOYMENT_AND_FALLBACKS.md
    DECISIONS.md
```

### Proposed commands (agent must implement, not assume they already exist)

```bash
python -m ml.datasets.ingest --dataset djmix --metadata-only
python -m ml.datasets.ingest --dataset raveform --metadata-only
python -m ml.datasets.ingest --dataset edm-cue --metadata-only
python -m ml.datasets.ingest --dataset unmixdb --verify-license
python -m ml.audio.analyze --input <authorized-audio-file> --output <features.json>
python -m ml.alignment.align --mix <reference-mix> --sources <source-manifest>
python -m ml.training.train_ranker --config ml/configs/ranker.yaml
python -m ml.training.train_gnn --config ml/configs/gnn.yaml
python -m ml.training.train_transition --config ml/configs/transition.yaml
python -m ml.training.train_critic --config ml/configs/critic.yaml
python -m ml.evaluation.benchmark --config ml/configs/evaluation.yaml
npm run test
npm run build
npx deepspace deploy
```

CLI commands are desired interfaces, not assertions about the current repository. If the repository uses a different convention, document the mapping.

---

## 13. Implementation order, milestones and Definition of Done

### Phase A — Functioning research core (highest immediate value)
1. Repo audit and Phase 1 contract tests; confirm DeepSpace docs and SDK version.
2. Dataset registry/provenance + metadata ingestion for DJ Mix Dataset, EDM-CUE, Raveform; synthetic/UnmixDB test corpus where licensed; ensure no prohibited downloading.
3. Accurate, reproducible DSP analyzer using real PCM: STFT, onset/BPM, beat/downbeat, chroma/key, structure/cues, loudness, energy, confidence, cache and manual override.
4. MixGraph directed multi-edge model, lock-safe deterministic planner, queue fairness and beat/phrase/loudness-aware technique selection.
5. Real two-deck browser renderer with audible auto-transitions, safe fallback, preview, and DeepSpace host controls.
6. Multiuser tests and evaluation dashboard with real measured outcomes. **At this point an end-to-end AI DJ exists even without trained GNNs.**

### Phase B — Professional DJ supervision
7. Alignment and inverse mixing; synthetic known-control generation; label QC and reviewer UI.
8. Train baseline ranker and cue model, compare to deterministic models on unseen tracks.
9. Train GATv2 only with enough verified edges/negatives; evaluate ablations, calibration and holdouts; promote only upon measured improvement.
10. Train TransitionNet on controller logs/high-confidence pseudo-labels, render and A/B compare.

### Phase C — Creativity and large-scale quality
11. Build consenting DJ annotations, A/B preference collection and label-consistency checks.
12. Train DJCritic and tune style/context trajectory; optimize optional alternative plan sets without violating queue locks.
13. Expand genre/open-format coverage; unseen-DJ/track test suites; public-facing model cards and transparent limitations.

### Deliverables
- Working code, not only an architecture or notebooks.
- Metadata ingest + rights manifest + authorized PCM analyzer + tested feature exports.
- Actual audible mix between authorized tracks and a real DeepSpace queue/host flow.
- At least one deterministic ranked baseline and independently runnable benchmark.
- Trained model artifacts *only when data/hardware available*, with legitimate measured metrics; if not, reproducible scripts, smoke tests and explicit blocker status.
- Documentation on architecture, sources/licenses, training, evaluation, model cards, failure recovery, dependency licenses, and deployment.
- Exact scripts/commands, test results, known limitations, future milestones and user-visible feature flags.

### Definition of Done per subfeature
A feature is **complete** only when source/data provenance is valid, code runs, outputs derive from real inputs, tests pass, errors/fallbacks work, docs describe limitations, and one engineer can reproduce its result. A decorative UI, placeholder score, untrained neural network, unauthorized audio source, or simulated playback must be explicitly labeled as incomplete.

---

## 14. Open design decisions for the implementing agent to ask first

**Must ask and await responses before irreversible development decisions:**
1. Location/branch of Phase 1 repo and existing queue/playback schemas; whether any files are already present.
2. Host's available authorized audio format, local-only vs permitted upload, and whether reference/source DJ mixes can be supplied. Do not request pirated links or DRM extraction.
3. Exact research target genres: house/techno first vs open-format; expected BPM range and DJ styles.
4. Training computer/GPU capacity, storage, compute budget, desired model-hosting approach, and time horizon. Never promise massive training in three days.
5. Whether host wants *fully automatic* live execution or preview/approval before transitions.
6. Whether private guest listening is through host's speakers or synchronized remote streaming (significantly different architecture and rights).
7. Whether the user has consenting human DJs/controller traces, expert raters, and rights/approval to use their recordings and labels.
8. Allowed dependency/model licenses (GPL/AGPL vs permissive; MERT weights' terms), and privacy/retention policy.
9. Whether to prioritize deployed usable prototype first or immediate deeper offline research pipeline.
10. Scope/constraints inherited from Phase 1 including host lock behavior and timed slots.

After the initial question round, ask targeted follow-ups only when a materially new choice arises; otherwise implement sensible defaults and record them in `docs/DECISIONS.md`.

---

## 15. Official references and implementation verification

- DeepSpace: https://docs.deep.space/ ; https://docs.deep.space/guides/background-jobs ; https://docs.deep.space/guides/server-actions ; https://docs.deep.space/concepts/data-model ; https://docs.deep.space/guides/file-uploads
- DJ Mix Dataset: https://github.com/mir-aidj/djmix-dataset ; https://huggingface.co/datasets/djmix/transitions
- Raveform: https://mir-aidj.github.io/raveform/ ; https://reference-global.com/article/10.5334/tismir.288
- EDM-CUE and CUE-DETR: https://huggingface.co/datasets/disco-eth/edm-cue ; https://github.com/ETH-DISCO/cue-detr
- UnmixDB: https://zenodo.org/records/1422385
- Beat This!: https://github.com/CPJKU/beat_this
- Essentia: https://essentia.upf.edu/
- PyG GATv2: https://pytorch-geometric.readthedocs.io/en/latest/generated/torch_geometric.nn.conv.GATv2Conv.html
- MERT optional: https://github.com/yizhilll/MERT
- DAFx fader/EQ estimation: https://dafx.de/paper-archive/details/f2sQEJSkwA4mhZ83iKqc4A
- MixWeaver (2026): https://ismir2026program.ismir.net/poster_428.html
- Rubber Band time stretch and license: https://breakfastquay.com/rubberband/

**Final directive:** Prefer a genuinely working, reproducible, musically tested system over aspirational “world-class” claims. Respect the host's queue constraints and legal access limits without compromising the ambition of full waveform analysis for authorized audio. The hallmark of successful CrowdPilot training is superior **blinded listening quality on unseen tracks** combined with reliable live operation.


---

# Appendix A — MANDATORY: Obtain Complete Professional-DJ Training Triplets and Controller Ground Truth

**Priority: P0 / blocking for the professional-waveform-training milestone.** This appendix strengthens, rather than removes, all existing requirements. Implement the code, workflows, acquisition adapters, manifests, validation, QA and completion gates described here. Do not stop with a list of dataset links. The implementation agent must actively obtain, inspect, hash, link, and validate every source that can be lawfully acquired within its environment and user-approved scope. Do not claim success based on metadata alone or on downloads that could not actually be verified.

## A.1 Required deliverable for *each* real reference transition

A **complete triplet** consists of:

1. **Professional/human reference performance audio**: the actual recording of the DJ mix segment containing the transition, or a complete mix with a verified timeline and tracklist. The audio must be present and decodable; URL-only metadata is insufficient. Identify the DJ, performance date if known, set, source, exact segment timestamps, codec/sample rate and SHA-256.
2. **Exact original masters of BOTH constituent tracks**: the outgoing recording and incoming recording. Match artist/title, featured/remix version, release/edit, duration, recording identity (e.g. ISRC if reliable), and actual content using permitted audio fingerprinting plus fine alignment. Do not silently swap a radio edit for the extended version, or a different remix for the performed recording. Both files must exist, decode, and align to the reference at an acceptable tolerance.
3. **Rights and provenance documentation for ALL THREE audio recordings**: individual master/source rights and any relevant underlying musical-work/composition rights or permissions, plus the right to use the DJ performance recording. Save canonical origin URLs, creator/label/publisher/rights-holder where known, exact license or written grant, retrieval date, immutable documentation snapshot or signed agreement, use-by-use authorization decision, restrictions, attribution, expiration and revocation contacts. A CC label on the DJ set does **not** prove the underlying tracks have the same license; a CC license on a composition does **not** automatically clear a separately owned recording; a streaming-player embedding grant does **not** grant downloadable PCM or model-training rights. Document uncertain legal bases as **needs review**, not approved.

**Preferred fourth resource (gold standard): actual DJ-controller/performance telemetry**, including mixer gains, crossfader, low/mid/high EQ, tempo/pitch, jog/sync, hot cues, deck load/seek, loops and FX parameters. This comes from a consented session with a musician whose audio rights are cleared, not from reverse inference alone. Clock-align telemetry with the recorded master and source playback timelines. A normal set recording without telemetry can still be used as a lower-confidence pseudo-label if its complete triplet is approved.

### Source acquisition status state machine

`DISCOVERED -> SOURCE_DOCUMENTED -> RIGHTS_REVIEW -> APPROVED_FOR_TARGET_USE -> DOWNLOAD_AUTHORIZED -> AUDIO_PRESENT -> THREE_WAY_MATCH_CONFIRMED -> ALIGNMENT_VALIDATED -> TRAINABLE_TRIPLET`

Alternate terminal or holding states: `METADATA_ONLY`, `AWAITING_RIGHTSHOLDER`, `RESTRICTED`, `EXPIRED`, `REVOKED`, `UNAVAILABLE_AUDIO`, `SOURCE_MISMATCH`, `QC_FAILED`, `EVALUATION_ONLY`, `REMOVED`.

State changes must be audit logged (who, timestamp, evidence reference, reason). A sample in an earlier state MUST NOT flow to a later training stage by default. Permission gating must occur **before** fetching restricted audio and again before writing a training batch. Manual permission decisions must be attributable to a named reviewer; the model/agent must not certify its own uncertain legal conclusion.

### Permission matrix — evaluate separately per asset and use

| Right / capability | Reference mix | Outgoing master | Incoming master | Controller/session telemetry |
|---|---:|---:|---:|---:|
| Lawful acquisition and local file retention | Required | Required | Required | Required |
| Automated waveform analysis / derived DSP features | Required or supported legal basis | Required or supported basis | Required or supported basis | Consent and privacy basis |
| Copying into a research training corpus | Separate determination | Separate determination | Separate determination | Consent/license |
| ML model training / fine-tuning and model retention | Separate determination | Separate determination | Separate determination | Consent/license |
| Reconstructive audio transformations and synthetic mixes | Where applicable | Required or supported basis | Required or supported basis | N/A |
| Public demo playback, redistribution, publication of clips | **Not assumed** | **Not assumed** | **Not assumed** | Consent if exposed |
| Commercial use and hosted SaaS deployment | **Not assumed** | **Not assumed** | **Not assumed** | **Not assumed** |
| Attribution/derivative/share-alike/noncommercial obligations | Inspect exact license | Inspect exact license | Inspect exact license | Inspect agreement |

Default `train_waveform=false`, `mix_for_research=false`, `publish_audio=false` until explicitly supported by recorded evidence. When rights are ambiguous, keep metadata only, request clarification from the relevant rights holder, or use an alternative approved corpus. Do not use user declarations of “private” or “research” as automatic dataset grants. When necessary, seek qualified legal review. The technical system should track permissions, not offer legal certification.

## A.2 Actual acquisition sources and priority order

Implement **working connectors that attempt permitted acquisition**, not hand-wavy dataset names. Prefer a small verified usable corpus to a million unlicensed links.

**P0 — UnmixDB, first reproducible full-audio validation corpus.**

- Official record: https://zenodo.org/records/1422385 ; scripts: https://github.com/Ircam-RnD/unmixdb-creation . This published corpus contains open-licensed electronic-track excerpts, automatically generated DJ mixes and source/mix ground-truth labels. It **does not represent human-performed expert mixing** and must be labeled `synthetic_reference`.
- Its public archives are sizeable (one listed archive is approximately 85 MB; others are hundreds of MB or more). Offer the smallest suitable archive by default, verify available disk/bandwidth first, query Zenodo's official record metadata for canonical file URLs and checksums, and ask for approval before large downloads or costly transfer. Never invent an asset URL from a filename if the record provides an official link.
- Obtain and verify the archive's checksum, unpack safely (path traversal and zip bombs protections), inventory source track excerpts/mix waveforms/labels, and prove that at least one named mix and its two adjacent original excerpts can be loaded. Preserve accompanying license notices and attribution. Confirm reuse obligations of the underlying CC recordings rather than assuming the code repository's license applies to every audio asset.
- Acceptance test: actual decoded triplet, verified hashes, source match/ground-truth labels, generated time-alignment plot, machine-readable record and training-permission gate. Generate a *real* unit/integration test from that triple. If acquisition is blocked, record the precise blockage and keep it marked incomplete.

**P1 — Human-created, openly licensed DJ sets with matching original tracks.**

- Research leads: the CC-licensed Mixotic sets discussed in the original UnmixDB/mix-fingerprinting research; public artist or netlabel releases and official Creative Commons music catalogs. Start with the exact mix and track references from peer-reviewed dataset documentation, then check each **individual** recording's license and current access conditions. The fact that a source was CC-licensed in a paper is a lead, not automatic continuing availability or proof of every required permission.
- Automate discovery of candidate set tracklists and official download links only where permitted by the publisher. Implement matching with source-track versions; create a rights review package for every unmatched/unlicensed item. Never assume a DJ's upload rights clear third-party recordings within the set.
- Accept `human_reference` only when the recording is genuinely human performed, all three audio assets exist and align, and target research uses pass the rights gate.

**P2 — Direct, opt-in professional or experienced DJ collection (best supervision).**

- Recruit collaborating DJs who will record an original session using tracks with independently verified rights. Provide a musician-facing **DJ Session Capture Kit** using Mixxx (or another DJ software with a supported telemetry interface), a guide for deck capture and a consent/release form for annotations/model training. Source: https://manual.mixxx.org/ and https://github.com/mixxxdj/mixxx/wiki/midi-scripting . Mixxx supports controller mapping/scripting and MIDI debug information; **debugging incoming MIDI messages alone does not necessarily reconstruct all effective mixer state**. Capture actual applied control values or explicitly mark what is only input-event telemetry.
- Record: final mixed output; source recording identifiers and original files; per-deck audio position; playback speed; cue/loop events; crossfader; channel gains; low/mid/high EQ; effects; source/host clock; session ID and consent receipt. Where compatible, capture clean deck-output stems before mixing for better identification. Synchronize clocks using test pulses/markers or measured onset correlation; report residual alignment error and dropped events.
- Validate controller state traces against the recorded output and the DJ's acknowledgment of techniques used. Never fabricate performance controls from a simple tracklist.
- Support voluntary, consented performance studies with measurable target numbers (e.g., an initial cohort of 3–5 DJs each recording several transitions, followed by more coverage). Targets are **not** achieved dataset counts.

**P3 — Large-scale professional DJ metadata and audio matching.**

- Official metadata sources: https://github.com/mir-aidj/djmix-dataset , https://huggingface.co/datasets/djmix/transitions , https://mir-aidj.github.io/raveform/ and https://huggingface.co/datasets/disco-eth/edm-cue . Ingest their officially available annotations/metadata first; maintain their original identifiers and lineage.
- For each candidate reference mix and source recording: look for an official artist/label/research distribution link, check actual license/permission/terms and restrictions, then acquire **only approved** recordings. A YouTube/SoundCloud/Mixcloud URL in a dataset is discovery metadata, **not** an authorization to rip audio. Do not use subscription credentials, capture player buffers, intercept network streams, circumvent DRM, evade paywalls, or scrape in violation of access terms.
- Unlicensed tracks remain `METADATA_ONLY`; they may contribute to limited, non-waveform metadata research if permitted, but not to source-audio reconstruction/training. If audio rights are negotiated, record documents and only then attach downloaded/local supplied files.
- EDM-CUE and other annotation-only datasets require matching audio under a separate access-and-rights process. Do not mark them waveform-trainable merely because an annotation exists.

**P4 — Additional licensed full-length music for diversity and synthetic labels.**

- Curate original commissioned music and music whose relevant rights are granted expressly for mixing, dataset creation and model training. Use optional user-uploaded authorized files. Attribute artists per applicable licenses and restrict private storage.
- For optional Jamendo/Internet Archive/other open catalogs: verify per-asset license, platform terms, track ownership and AI/data-mining limitations. For example, Jamendo provides CC metadata and `audiodownload_allowed` fields but its platform terms impose further restrictions; **CC tags are not a universal music-training API license**. https://developer.jamendo.com/v3.0/tracks ; https://devportal.jamendo.com/api_terms_of_use .
- The Internet Archive Music Dataset (IAMD v0) is a research lead with per-sample Creative Commons license metadata, not a pre-cleared full-master or DJ-mix dataset: https://huggingface.co/datasets/Telecom-Paris/iamd_v0 . Its individual license and source permissions must be checked; 30-second segments are insufficient for some long-form cue and DJ-transition labels.

## A.3 Automated rights-review and permission-request workflow

Implement **discovery and evidence packaging**, with a human authorization gate. Use a single `rights_registry` backed by restricted-access storage. The agent may draft outreach emails but must **not send** them or represent granted rights without explicit user approval and actual replies.

### Required rights review packet

- Three concrete asset identities, ownership/credits where known, official source page/URL, and exact filename/hash if present.
- Who is being asked: DJ or mix recording owner, master rights holders for each song, and any necessary composition/publishing rights holders (or a documented alternative lawful basis reviewed by a person).
- Explicit permitted purposes to request: download/acquisition; keep research copies; waveform feature extraction; alignment/transformation into artificial blends; train and fine-tune models; retain/export model weights; render private demos; use anonymized performance-control logs; use for blinded evaluations; attribution; retention/deletion schedule; public demo/audio sharing **separate and opt-in**.
- Geographic scope, time limit, revocation mechanism, open-source model release restrictions, sublicensing/no-redistribution restrictions, commercial prohibition where relevant.
- Immutable copy of license/grant and receipt date, reviewer status, signatures or identifiable sender, expiry/revocation status, follow-up record.

### Approved standardized request template (draft only)

> Subject: Permission request — noncommercial DJ-mix analysis and model-training research
>
> Hello, I am developing CrowdPilot, a private noncommercial research project studying DJ transitions. I'd like permission to use [specific reference mix/track and link] for the following separately identified purposes: local download/storage, waveform feature analysis, reconstruction of transitions, training and evaluation of audio models, generation of nonpublic comparison snippets, and retention of derived model parameters. We would not publicly redistribute the source recording or publish resulting mixes without separate authorization. Please specify any restrictions, attribution requirements, duration of permission, and whether you control the relevant master/performance rights; if not, please identify the appropriate holder. Thank you.

Do not assert that a noncommercial research purpose overrides an artist's or platform's explicit restrictions. Where a legal exception is proposed, require documented basis and review; the system cannot automatically establish fair use.

## A.4 File layout, reproducibility and data lineage

Use private local or appropriately controlled object storage, **not a public GitHub repository**, for raw research audio and rights agreements. Prefer content-addressed IDs and symlink/DB lineage rather than uncontrolled duplicate audio copies.

```text
ml/data/
  registry/
    dataset_sources.jsonl
    asset_manifest.parquet
    rights_decisions.parquet
    triplet_index.parquet
    acquisition_audit.jsonl
  raw/private/
    reference_mixes/<mix_sha256>.<ext>
    original_tracks/<recording_sha256>.<ext>
    controller_logs/<session_id>.jsonl
    source_permissions/<evidence_id>.<ext>
  derived/
    decoded_audio_cache/
    beat_grids/
    alignment_features/
    aligned_transitions/
    reconstructed_controls/
    training_examples/
  qc/
    rights_failures.csv
    missing_source_pairs.csv
    wrong_version_matches.csv
    triple_completeness.csv
    telemetry_alignment.csv
  splits/
    train.jsonl
    validation.jsonl
    test.jsonl
```

Add raw audio and private consent/agreements to `.gitignore`; commit only safe redacted provenance identifiers and reproducible instructions. Secure secrets and consent records. Apply retention and deletion/revocation procedures to raw files, derived training sets and future training runs; track model checkpoints affected by revoked data.

### Proposed versioned manifest schema (fields required unless explicitly nullable)

```json
{
  "transition_id": "reference:mix1:transition3",
  "kind": "human_reference",
  "performance": {
    "mix_asset_id": "mix_sha256",
    "dj_id": "consented_dj_01",
    "source_page": "https://official-example.invalid/mix",
    "interval_sec": [350.4, 391.2],
    "file_sha256": "<verified digest>",
    "audio_present": true
  },
  "outgoing": {
    "recording_id": "master_A",
    "file_sha256": "<verified digest>",
    "audio_present": true,
    "version_match": "confirmed"
  },
  "incoming": {
    "recording_id": "master_B",
    "file_sha256": "<verified digest>",
    "audio_present": true,
    "version_match": "confirmed"
  },
  "rights": {
    "mix_evidence_id": "permission_ref_mix",
    "outgoing_evidence_id": "permission_ref_A",
    "incoming_evidence_id": "permission_ref_B",
    "waveform_analysis": "approved",
    "training": "approved",
    "render_private_comparison": "approved",
    "public_redistribution": "not_approved",
    "reviewer_id": "human_reviewer_01",
    "reviewed_at": "2026-11-21T00:00:00Z"
  },
  "alignment": {
    "method": "beat_chroma_subsequence_dtw_plus_fine_match",
    "overlap_sec": [364.9, 388.1],
    "source_A_version_match_confidence": 0.98,
    "source_B_version_match_confidence": 0.97,
    "validated_by": "human_reviewer_01"
  },
  "controller": {
    "available": false,
    "kind": "none",
    "verified_clock_offset_ms": null
  },
  "status": "TRAINABLE_TRIPLET",
  "manifest_schema": "2.0"
}
```

**IMPORTANT:** The example values above are *illustrative*, including `.invalid` URI and example approval fields. Real code must never insert example approvals into a working registry. Any ingestion attempt lacking actual authorization evidence must produce `RIGHTS_REVIEW`, not `TRAINABLE_TRIPLET`. Schemas must be implemented and validated in Python (Pydantic or equivalent) and exported as JSON Schema; type-compatible shared schemas should be available to TypeScript.

## A.5 Audio triplet matching and quality gates

Implement a deterministic, testable validation pipeline:

1. **Asset integrity:** files exist; source URL if applicable; cryptographic hash; codec decodes; sample count/sample rate/channels; clipping/silence/corruption; rights evidence file exists; all three asset IDs unique and appropriately associated.
2. **Recording identity:** normalized artist/title/remix/editorial metadata + recording ID if available; audio fingerprint or feature-match to distinguish versions; different versions cannot silently be treated as exact masters.
3. **Coarse alignment:** beat-synchronous chroma / constant-Q, subsequence DTW or similar, with tempo-change tolerance.
4. **Fine alignment:** constrained cross-correlation after alignment, source-to-mix time warp and boundaries. For EQ-heavy sections, multiband alignments with robust agreement checks.
5. **Overlap inference:** determine first and last plausible presence of each source, mix-in/out cue in source time, tempo ratio, bar/phrase phase and calibrated uncertainty. Strong disagreement between methods triggers manual review.
6. **Mix reconstruction:** render the inferred two-source blend using baseline fader/EQ optimization, compare against reference spectrogram/waveform when justified, quantify residual and explain unmodeled crowd noise, FX, mastering or third tracks.
7. **Training eligibility:** rights approval; complete three-way audio; exact version matching; plausible overlap; confidence threshold; label origin; train/test split restrictions; human check for borderline cases. Never silently lower thresholds to raise counts.

Retain the full unedited recordings only within permitted scope; export segment-derived training files with provenance. Split by recording identity, DJ/performance and near-duplicate work where required to avoid leakage. Keep original source track audio separate from the live DeepSpace guest library.

## A.6 Capture true human controller actions — mandatory working instrument path

Create a functional, standalone **`capture_dj_session`** toolkit, with docs for obtaining permission and using an actual DJ mixer/controller. At minimum:

- Prefer supported Mixxx scripting/control API, with version detection and explicit tested assumptions. Include a DJ operator setup page, input mapping and supported `deckId`/parameter schema. Support two decks and a master mix recording.
- Record high-resolution, monotonic timestamps for **effective** gain/fader/3-band EQ/crossfader/tempo/transport/loop/FX state changes where the host software exposes them. Independently log raw MIDI/HID commands and distinguish command vs effective state. If any parameter cannot be observed, record `observed=false` and don't make up values.
- Record in/out cue timestamps in source position, deck audio position vs wall-clock, BPM/base rate and tempo shift, hotcue, track-load hashes, loop enable/length, filter and FX dry/wet. Include exact device model, software version and calibration.
- Record stereo master output (and optional pre-fader deck stems when available) with permission. Create an audible calibration marker or documented time-sync procedure. Compute controller-audio clock drift and residual latency to validate training labels.
- Guarantee bounded buffering, recoverable event logs, schema validation, consent acknowledgment, ability to revoke data, and end-of-session provenance export.
- Provide a **practice/test session using synthetic audio first**, then a real consenting-human demo with authorized audio. The agent cannot fabricate a human DJ performance; if nobody is available, deliver the tested capture tooling and mark gold-controller-data collection as blocked pending recruitment.

Suggested session manifest: `session_id`, `dj_alias`, `consent_ref`, `source_track_sha256s`, `output_mix_sha256`, `controller_device`, `software_version`, `clock_origin`, `offset_ms`, `drift_ppm`, `sample_rate`, `events_path`, `effective_state_trace_path`, `notes`, `allowed_uses`.

## A.7 Exact implementation work items and CLI contract

The implementing agent must create a CLI (command examples are required behavior; use an implemented CLI or adjust docs to the actual implemented commands):

```bash
# Discover/inspect official datasets; these commands must actually execute after implementation.
python -m ml.datasets.acquire inventory --dataset unmixdb
python -m ml.datasets.acquire verify-source --dataset unmixdb
python -m ml.datasets.acquire fetch-approved --dataset unmixdb --subset small --max-gb 0.2
python -m ml.datasets.acquire ingest --dataset unmixdb

# Link a real human DJ performance and both source masters, without pretending a metadata row is PCM.
python -m ml.datasets.triplets register --mix /private/mix.wav --outgoing /private/a.wav --incoming /private/b.wav --rights-manifest /private/rights.json
python -m ml.datasets.triplets audit --output ml/data/qc/triple_completeness.csv
python -m ml.datasets.triplets align --only-rights-approved
python -m ml.datasets.triplets export-train --require-complete --require-train-approved

# Optional human DJ capture and validation.
python -m ml.capture validate-session --manifest /private/session.json
python -m ml.capture sync-clocks --manifest /private/session.json

# Required acceptance reports.
python -m ml.datasets.audit coverage --json reports/audio_coverage.json
python -m ml.datasets.audit rights --json reports/rights_compliance.json
python -m ml.datasets.audit provenance --json reports/provenance.json
```

`fetch-approved` must refuse unsupported scopes by default and must not accept metadata-only source URLs as an unrestricted download instruction. For large archives, support dry-run size calculation, resumable official transfers, retries/backoff, checksums, safe extraction and resource caps. Provide dependency and disk-space instructions; do not run expensive downloads without user approval.

Build tests that deliberately create missing-mix, missing-track, wrong-version, unverifiable-license, expired-grant, corrupted-file, duplicated-asset, low-alignment-confidence, clock-drift and revoked-consent cases. Every such test must prevent the sample from being exported as an approved human-DJ waveform training example.

## A.8 Minimum evidence, milestones, and reporting

The implementation must produce a dashboard and a JSON/CSV report containing **actual observed values**:

| Metric | Meaning |
|---|---|
| `mix_metadata_discovered` | Number of discovered professional mix records, audio or not |
| `mix_recordings_locally_present` | Actually stored/decodable human reference mix audio |
| `master_recordings_present` | Distinct original, decodable audio masters |
| `three_asset_groups_complete` | Number with actual reference mix and both specific source masters |
| `rights_evidence_complete` | Complete groups with suitable separately reviewed documents for all three assets |
| `rights_approved_for_waveform_training` | Complete groups permitted for the specified train use |
| `exact_recording_version_matched` | Source versions confirmed to align to performance |
| `time_alignment_verified` | Validated cue and overlap reconstruction |
| `human_controller_traces_available` | Consented sessions with real control logs + master recording |
| `gold_control_samples` | Real, verified controller traces eligible for supervised performance training |
| `pseudo_labeled_samples` | Inverse-estimated controls, uncertainty recorded |
| `synthetic_reference_samples` | Real audio but algorithmically synthesized mixing references; **not** human DJ examples |
| `waveform_trainable_professional_transitions` | Complete **human** three-way examples satisfying rights and QC gate |
| `blocked_by_rights`, `blocked_by_audio`, `blocked_by_alignment` | Precise auditable barriers |

**Done definitions:**

- **D0 — Real triplet ingestion proven:** at least one legitimately acquired and verified full triplet is used for actual waveform-alignment and source-reconstruction tests. Synthetic UnmixDB may satisfy *pipeline mechanics*, but not *professional human reference data*.
- **D1 — Human-performance dataset operational:** at least one *human* mix with exact outgoing/incoming source masters, three-way rights review, successful alignment and reproducible data manifest. If no such lawful corpus exists in the current environment, D1 is **BLOCKED**, not complete.
- **D2 — Gold telemetry capture operational:** real consenting DJ session with captured audio and effective mixer controls; validated timeline and permissions. If no human session exists, the capture software may be *implemented* while D2 remains **BLOCKED pending human performance**.
- **D3 — Research scale-up:** coverage goals (e.g., 100+ then 1,000+ validated transitions over diverse genres, DJs and techniques) set as future measurable targets, not advertised achieved counts.
- **D4 — Training readiness:** at least one nonempty rights-cleared training split, disjoint validation/test splits where size permits, dataset card, provenance audit and sample replay test. A dataset with too few independent songs/DJs cannot support meaningful generalization claims.

The agent's final output must state exactly: which datasets were contacted, which metadata/recordings were actually downloaded, archive hashes, explicit rights status, number of fully linked training triplets, number with actual controller traces, what remains blocked and why. Provide concise rightsholder outreach drafts for missing rights (never send without authorization), plus a manifest of requested files the user could supply. The goal is to **obtain everything it can legitimately obtain and know precisely what it cannot**, not to disguise missing commercial rights with a legal disclaimer.

## A.9 Source documentation for implementer verification

- UnmixDB archive, audio and source labels: https://zenodo.org/records/1422385 ; generation code: https://github.com/Ircam-RnD/unmixdb-creation
- Human DJ mix metadata/transition identifiers: https://github.com/mir-aidj/djmix-dataset ; https://huggingface.co/datasets/djmix/transitions
- Human performance structure metadata: https://mir-aidj.github.io/raveform/
- Expert cue-point annotations: https://huggingface.co/datasets/disco-eth/edm-cue
- Mixxx control scripting/MIDI traces: https://github.com/mixxxdj/mixxx/wiki/midi-scripting ; https://manual.mixxx.org/
- CC music licenses: https://creativecommons.org/about/arts-culture/arts-culture-resources/legalmusicforremixing/ ; https://creativecommons.org/faq/
- Jamendo metadata/terms: https://developer.jamendo.com/v3.0/tracks ; https://devportal.jamendo.com/api_terms_of_use
- IAMD candidate music data with per-asset licenses: https://huggingface.co/datasets/Telecom-Paris/iamd_v0

**These links identify possible resources, not blanket authorization for copyrighted mainstream audio. Rights must be determined for every actual training sample and use.**
