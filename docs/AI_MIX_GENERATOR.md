# AI mix generator ("Generate AI Mix")

Describe a DJ set in plain language; CrowdPilot discovers music, acquires audio from sources
that permit mixing, analyzes every track, chooses and orders the set, plans transitions, renders
**one continuous audio file**, and shows it with a waveform of the rendered audio, a tracklist and
a transition inspector. The live collaborative rooms are unchanged and remain a separate feature.

## Pipeline

```
prompt ──▶ /api/mixgen/interpret (LLM → zod-validated MixSpec; labelled keyword fallback)
        ──▶ user reviews / edits the interpretation
        ──▶ /api/mixgen/discover (Jamendo · Audius · YouTube metadata; identity matching; central policy)
        ──▶ acquisition (policy-checked)  ──▶ decode to PCM  ──▶ analysis (Beat This! + DSP)
        ──▶ selection + ordering (beam search)  ──▶ transitions + duration fit (DP)
        ──▶ review (selected tracks with real acquisition status; optional Replace)
        ──▶ offline render (chunked, streaming limiter + meters)  ──▶ validation  ──▶ player
```

| Stage | Code | Notes |
|---|---|---|
| Spec | `src/mixgen/spec.ts` | `MixSpec` zod schema. Unstated fields stay `null`; `resolveSpec` applies documented defaults and records which values were defaulted. LLM: `claude-sonnet-5-5` via DeepSpace AI, billed to the signed-in user. |
| Discovery | `src/mixgen/discovery.ts` | Query plan from songs / artists / genres / moods / similar artists. Jamendo (tags, text, popularity, vocal filter, 2 × 200-row pages), Audius (search, genre trending), YouTube Data API (search + `videos.list` for duration, views, licence). |
| Identity | `src/mixgen/identity.ts` | Normalized artist / base title / version tag / featured artists; `sameRecording` requires identical version tags and duration within 4 s, so an original is never swapped for a remix, sped-up edit, cover or live recording. |
| Policy | `src/mixgen/policy.ts` | One `decideAccess()` for every acquire / analyze / mix / persist / export decision (see below). |
| Acquisition | `worker-node/mixgen/acquire.ts` (Node), `src/mixgen/browser/job.ts` (browser) | `AudioSourceProvider` adapters (`src/mixgen/provider.ts`). Retries, resumable downloads (HTTP Range on `.part`), magic-byte container check, full ffmpeg integrity decode, duration check against metadata, sha256 dedupe, provenance index. |
| Analysis | `src/dsp/*` (existing) | Beat This! small0 (ONNX; onnxruntime-node / onnxruntime-web), grid fit with octave handling, downbeats, key, loudness, phrases, sections, cue candidates. Cached by content hash (disk / IndexedDB). |
| Selection | `src/mixgen/select.ts` | Metadata pre-selection (preferences, genre, source-specific popularity percentiles, variants, exclusions) acquires the requested count + 75 % spares; after analysis a beam search over subsets *and* orders scores tempo/key compatibility, target energy arc, grid reliability, tempo coherence, artist variety and closing features. |
| Energy | `src/mixgen/energy.ts` | Loudness-independent energy (onset density, tempo, bass share, brightness, drop strength) as pool percentiles; nine target arcs. |
| Transitions | `src/mixgen/mixplan.ts` + `src/dj/transitions.ts` | MixGraph candidates (cue pairs × 12 techniques × overlap lengths) re-weighted by requested style/features; a DP over each pair's candidates fits the duration with phrase-aligned edits only. |
| Render | `src/mixgen/mix-render.ts` + `src/dj/render.ts` | body │ transition │ body … Transitions are rendered by `renderTransition` (LR4 isolator EQ, fader curves, WSOLA pitch-preserving tempo match + recovery, filter, echo, roll/brake/scratch). Incoming splice located in closed form and refined by cross-correlation (±25 ms), 25 ms crossfades. Streaming 5 ms look-ahead limiter (−1 dBFS) and BS.1770 meter; ≤ 2 decoded tracks in memory. |
| Validation | `src/mixgen/validate.ts` | Gaps, clipping, peak, transition-local level jumps, loudness match across transitions, integrated loudness, all tracks present, monotone timeline, duration, overlap share, splice correlation, waveform length. |
| Manifest | `src/mixgen/manifest.ts` | Everything the UI shows: actual mix timestamps from the renderer, executed curves, effects, splice lags, rendered-audio waveform and energy, attribution. |

## Where the work runs

* **Deployed (crowdpilot.app.space):** request handlers stay short (interpret, discover, audio pass-through, record updates). Acquisition, analysis and rendering run in the signed-in user's browser: the analysis Web Worker (Beat This! on WebGPU/WASM) and a dedicated render worker that streams the mix into WebCodecs Opus (192 kbps, Ogg). The finished file and manifest go to the user's **private** DeepSpace file storage (`self` scope); the `mixes` record holds keys, progress and version history. Nothing long-running happens in a DeepSpace HTTP request.
* **Research worker (local, `C:\crowdpilot-data\mixgen`):** the same pipeline in Node with FFmpeg (decode any format to 44.1 kHz float PCM; 320 kbps MP3 export), lossless Jamendo FLAC, persistent job manifests and logs, the `yt-dlp` adapter, and storage monitoring/cleanup. Used for the real-audio E2E test and comparisons.

Storage layout: `acquired/` (originals, sha256-indexed) · `decoded/` · `analysis/` · `embeddings/` (reserved) · `previews/` · `renders/` · `exports/` · `jobs/` · `logs/` · `session/` (session-only audio, deleted at job end). `cleanup()` removes session audio, stale decoded PCM and abandoned `.part` files; there is no research storage cap.

## Source-access policy (centralized; no per-track dialogs)

| Source | Acquire | Mix | Store render | Download | Basis |
|---|---|---|---|---|---|
| Jamendo, CC licence without ND | ✓ | ✓ | ✓ (private) | ✓ | CC permits adaptations with attribution; NC terms respected (noncommercial project). Attribution list ships in every manifest. |
| Jamendo, CC ND / unknown | ✗ | ✗ | – | – | A DJ mix is an adaptation. |
| Audius | session only (opt-in) | ✓ in session | ✗ | ✗ | OML streaming grant; API Terms allow session caching only and forbid ML training. Off in the deployed generator so every mix can be saved. |
| YouTube | **only with an operator-recorded authorization grant** (`C:\crowdpilot-data\mixgen\grants.json`), research worker only | per grant | per grant | per grant | YouTube's Terms do not permit downloading without YouTube's download feature or rights-holder permission, so a public video is not treated as downloadable. DRM-flagged formats, non-public / age-restricted / login-gated videos are refused even with a grant; no cookies are passed. |

Requested artists/songs without a permitted source are listed as **unavailable** in the review step and the player, with the catalogs searched; substitutions follow `allow_song_substitutions`. Downloads are never reported as successful unless the bytes were received, sniffed, integrity-decoded and hashed.

## Testing

* Unit (`npx vitest run -c vitest.pure.config.ts`): spec parsing/validation/fallback, edits, policy, identity, selection, ordering, limiter/meters, Ogg muxer CRC, full-mix render mechanics on synthetic tracks (continuity, splice alignment, timeline agreement).
* Real-audio E2E, Node (`evaluation/mixgen.e2e.eval.ts`): the acceptance prompt end to end, MP3 integrity re-decoded and duration-checked.
* Real-audio E2E, browser (`tests/e2e/mixgen.spec.ts`): sign-in → interpret → generate → review → render → play, seek, track navigation, transition inspector.
* Before/after (`evaluation/mixgen.compare.eval.ts`): live-engine defaults vs generator on the same tracks; WAV pairs + objective proxies (bass doubling, beat offset, level steps).

## Known limits

* The deployed catalog is effectively Jamendo's CC music; mainstream artists (e.g. John Summit, Dom Dolla) are discovered on YouTube but reported unavailable.
* Some Jamendo recordings have unstable beat grids (tempo drift / live feel); selection avoids them when enough stable tracks exist, otherwise they are joined with un-matched fades.
* The browser path decodes Jamendo's VBR MP3 stream by default (lossless FLAC is an opt-in because files are ~35 MB each); the research worker uses FLAC.
* Interrupted browser renders restart the render (analyses are cached, so only acquisition + render repeat).

## Local research mode (YouTube via yt-dlp, operator's machine only)

`npm run mixgen -- "<prompt>" [--songs N] [--minutes M] [--job id]` — private, noncommercial research on the
operator's own machine; the operator has accepted responsibility for this local use. **Never deployed.**

* Switch: `CP_RESEARCH_YOUTUBE=1`, read only in `worker-node/mixgen/research.ts` (the launcher sets it for its own
  process). The Cloudflare app never reads it; the container worker refuses to start if it is set (unit-tested).
* Policy: `researchYouTube` + `environment: 'local'` → YouTube acquire/analyze/mix, `persistRender: false`,
  `exportScope: 'local'`, method `yt_dlp_research`, reason "Local research mode — not for distribution".
  Jamendo/ND/Audius rules unchanged.
* Hard rules in every mode: no DRM formats; no private, members-only, premium, login-gated, age-restricted, live or
  upcoming videos; `--ignore-config --no-cookies --no-cookies-from-browser`; credential/cookie arguments rejected;
  access-control errors classified as not permitted (never worked around); downloads sequential with a 3 s gap.
* Discovery: YouTube Data API; official uploads preferred ("- Topic", VEVO, artist channel); covers, edits, live/DJ
  sets, lyric re-uploads, compilations and DJ mixes rejected unless requested; genre counted only when the upload
  claims it; scene seeds per genre. Fallbacks: other verified uploads of the same recording (identity + duration
  ±4 s) → Jamendo same recording → unavailable with reasons.
* Outputs: `C:\crowdpilot-data\mixgen\exports\research\<job>.mp3` (320 kbps, ID3 comment "research only — not for
  distribution"), `renders\research\<job>.manifest.json` (`mode: 'research'`) and `<job>.report.json`.
* Viewer: `/research/<job>` in `deepspace dev` only, data from the localhost-only Vite middleware `/__research/*`;
  the page renders "Not found" in builds and the Worker answers 404 for `/__research/*`.
