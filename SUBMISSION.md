# CrowdPilot: an AI DJ that turns a sentence into a beat-matched mix

- **Live app:** https://crowdpilot.app.space
- **Repository:** https://github.com/smokyfishy/CrowdPilot (branch `main`)
- **Built on:** DeepSpace (Cloudflare Workers + Durable Objects), React, TypeScript

---

## Try it (please read first)

1. Open https://crowdpilot.app.space and sign in (Google or GitHub). You land on the mix page.
2. Describe a **5-minute set with about 4–6 songs**, for example:
   - *"Make a 5-minute tech house set with 5 songs that builds gradually, with smooth long blends."*
   - *"A 5-minute melodic house mix, 4 songs, drop swaps into every drop, no loop rolls."*
3. Press **Generate**. Expect about **6–7 minutes** for a new mix (3–4 if the songs were used before).
   The progress screen shows each stage while it runs.
4. When it's ready, press play. You can seek by track, watch the DJ board show what each deck is
   doing, and open **How the AI DJ made this mix** for a plain-language account of each transition.

**Why 5 minutes and 4–6 songs:** almost all the heavy work runs in your browser: decoding, beat
analysis, test-rendering about 50–60 candidate transitions, and rendering the final mix. Longer
sets are supported, but generation time grows roughly with the number of transitions. A 5-minute,
4–6-song set shows everything the system does in a reasonable wait.

**Other things to know before trying it:**
- **Ask for genres and moods, not chart songs.** The live app only uses music whose licence
  allows mixing (Creative Commons tracks from Jamendo, plus Audius). Named mainstream songs
  usually aren't available there, and the app tells you so.
- **Space requests about 30 seconds apart.** Requests are interpreted by a free open-source model
  whose free tier allows only a few requests a minute. Faster requests fall back to a backup
  interpreter.
- **Use desktop Chrome or Edge.** The layout works on phones, but I haven't timed a full
  generation on one, and processing will be slower.

---

## What I built

You describe a mix in plain English. CrowdPilot then:

1. **Understands the request.** An LLM converts it into a structured spec: length, track count,
   genres, BPM range, energy shape, vocals, and named techniques such as "drop swaps" or
   "no loop rolls". A deterministic guard then makes sure anything you stated explicitly
   (numbers, genres, named songs, techniques) survives even if the model drops it.
2. **Finds licensed music.** It searches Jamendo and Audius and only keeps tracks whose licence
   allows remixing and download.
3. **Analyses every track in the browser.** Beat This! (a neural beat and downbeat tracker, run
   with ONNX in a Web Worker) finds beats; DSP finds key, loudness, energy, phrases, drops and
   vocal sections. In parallel, Demucs splits each track into vocals, drums, bass and other on
   an Azure stem service.
4. **Plans the whole set like a DJ.** A beam search plans track order, cue points and transition
   length together: harmony, tempo, energy curve, vocal clashes, phrase alignment. It doesn't
   just pick the best pair at each step.
5. **Designs each transition.** Long staged performances (introduce → layer → develop →
   transfer → resolve) drive real fader, EQ, filter, echo and stem controls. House rules: every
   transition is beat-matched (±8 % tempo, key lock) and at least 16 bars long, and there are
   no loop rolls.
6. **Listens before committing.** A closed loop test-renders candidate transitions with the
   production renderer, in parallel Web Workers. Each render is scored on explicit audio metrics
   (beat alignment, bass clash, vocal clash, loudness steps) plus a learned critic. The best one
   is kept, and the set is re-planned around any transition that fails.
7. **Renders and checks the mix.** It renders a continuous 48 kHz Opus file, runs automatic audio
   checks on it, stores it privately for the user, and shows it in a DJ-board player that
   explains each transition in plain words.

---

## DeepSpace integrations I used, and why

| DeepSpace feature | How CrowdPilot uses it | Why it was the right tool |
|---|---|---|
| **Auth** (`DeepSpaceAuthProvider`, `AuthGate`, `AuthOverlay`, server-side `verifyJwt`) | Sign-in, the protected `/mix` area, and auth on every `/api/mixgen/*` route | Generation uses paid and rate-limited services, so it must be tied to a user. Writing my own auth would add risk and no value. |
| **RecordRoom collections** (`mixes` schema with `ownerField`, `useQuery`) | Each mix version is a row: status, live progress, the chosen track list, a summary, and storage keys | Live progress updates and an owner-only access rule come with the platform. The client can't write rows directly; every write goes through server-validated routes. |
| **Private file storage** (`useR2Files` in the client, `appFiles(..., { scope: 'self' })` on the server) | The rendered audio and full mix manifest are stored per user | Large audio files don't belong in a database row, and they must stay private to the user. |
| **DeepSpace AI proxy** (`createDeepSpaceAI('anthropic')`) | Claude, billed to the signed-in visitor, is the backup interpreter if the open-source model fails | It needs no API key in the app. Billing to the visitor means one user can't run up the owner's costs. |
| **Secrets** (`deepspace secrets set ... --stdin`) | The Groq key, the Azure queue and blob credentials, and the Jamendo client id | Keeps keys out of the repo and the client. They're read on the server only. |
| **Deploy, releases and rollback** (`npx deepspace deploy`) | 35 releases, each built from GitHub `main`; every deploy was followed by a live browser test | Every change can be rolled back, and the live site always matches a known commit. |

**Not used, on purpose:**
- **Google and Composio integrations:** the product doesn't touch users' email, calendars or files.
- **Payments:** this is an evaluation build with no paid tier.
- **Cron:** nothing runs on a schedule; generation starts when a user asks for a mix.
- **Yjs, canvas and presence rooms:** a mix is a solo creation, so real-time co-editing would
  add complexity without adding value. Collaborative listening rooms from an earlier phase are
  still in the schema but aren't part of the submitted path.

**Outside services, and why:**
- **Groq free tier with gpt-oss-120b** (open weights, Apache-2.0): reads the request, at no cost.
  I measured it on a 24-request benchmark (below).
- **Azure Container Apps job running Demucs**: stem separation. It's too heavy for Workers or
  for a browser. It scales to zero, has a budget alert, and its credentials are least-privilege:
  the site can only add to the queue and only read stems.
- **Jamendo and Audius**: licensed music. Each licence is re-checked before stems are made,
  because stems are derivative works.

---

## The main tradeoff: sound quality and rights over speed and catalogue size

I chose to make the mixes sound like a real DJ made them, using only music I'm allowed to use.
That costs speed and limits which songs are available.

- **Quality costs time.** The closed loop renders and measures 50–60 candidate transitions before
  committing to one. Without it a mix could finish in about 2 minutes, but bad joins would get
  through.
  - **What I did about it:** moved previews into parallel Web Workers (1.5–4 minutes down to
    16–50 seconds), started stem separation while tracks are still being analysed, split each
    track into parts that separate in parallel, and stopped the render pass from repeating the
    search.
  - **Result:** a fresh 5-song mix went from 8.6 to about 6.5 minutes of generation.
  - **What I'd do next:** cache analyses on the server, so a track used by any user is never
    analysed twice.
- **Most of the work runs in the browser.** Cloudflare Workers can't run neural audio models or
  heavy DSP. Doing it in the user's browser costs nothing per mix and scales with users, but speed
  depends on the user's computer. Only stem separation runs on a server.
- **Rights limit the catalogue.** The live app only uses Creative Commons and Audius tracks whose
  licence allows remixing. I also built a local research mode for testing with mainstream songs
  from a YouTube cache. It's gated behind a local environment flag, never deployed, and its audio
  is never uploaded. That's why the live app is best with genre prompts rather than specific
  chart songs.
- **Free open model instead of a paid model.** Free and open-source was an explicit requirement.
  On my benchmark it is accurate, but the free tier allows only a few requests a minute, so I
  chain a second open model, then Claude (the visitor's DeepSpace credits), then a rule-based
  parser.

---

## Evidence: what was measured

All numbers come from real runs during development. The scripts are in `evaluation/`.

| What | Result |
|---|---|
| **Request understanding** (24 varied prompts, each field checked against the expected answer) | Rule-based parser alone: 70/94 fields (74 %). gpt-oss-120b + guard: 88/94 (94 %), then **94/94** after adding guard rules for the misses |
| **"5-minute mix with drop swaps, no loop rolls"** on real audio | Before: 11:42 long, loop rolls. **After: 5:10, 4/4 drop swaps, no loop rolls** |
| **Named techniques** on real audio | Filter sweeps 7/7, echo outs 4/5, drop swaps 4/4, all at least 16 bars, no failed audio checks |
| **Beat-matching**, research set with tracks that have breakdowns and half-time intros | Before: 2 of 4 transitions were un-beat-matched fades. **After: 4/4 beat-matched**, beat alignment within 0–8 ms |
| **Parallel preview workers** | Make exactly the same choices as single-thread rendering (unit test). Planning stage: 92–227 s down to 16–52 s live |
| **Splitting stems into parallel parts** | Reconstruction residual −17.9 dB split vs −16.8 dB whole. Difference from a whole-track run is within Demucs's own run-to-run variation |
| **Live end-to-end test** (sign in → describe → generate → listen → inspect) on crowdpilot.app.space | Passes on the current release, in 6.9 min for a 5-track mix |
| **Automated tests** | 186 unit and integration tests, plus 47 ML and DSP tests, all passing |

**Being honest about the learned models.** The app runs eight models: Beat This!, Demucs,
MixGraph quality, MixGraph cue prior, TransitionNet v1 and v2, and the DJCritic quality and
artifact models.
- **TransitionNet v2 didn't beat a simple rule on held-out data** (22 % vs 43 % accuracy).
  So it's used only as a *candidate generator*: its proposals are rendered and measured, and they
  win only when they actually sound better. It's never trusted blindly.
- **The MixGraph cue prior is loaded but given zero weight**, because on held-out data it made
  results worse.
- **No learned model is marked "promoted"** in the registry. The explicit audio metrics are the
  primary judge, and the critic's influence is capped.
- **The details are in the repo:** [`docs/MODEL_CARDS.md`](docs/MODEL_CARDS.md) and
  [`docs/PRO_DJ_REPORT.md`](docs/PRO_DJ_REPORT.md).

---

## Code tour

| Path | What's there |
|---|---|
| `src/server/mixgen-routes.ts` | Authenticated API: interpret, discover, licensed audio proxy, stems, mix CRUD |
| `src/server/llm.ts` | OpenAI-compatible client for the open model (schema output, one retry on rate limit) |
| `src/mixgen/spec.ts` | Request schema, interpreter prompt, deterministic guard, techniques |
| `src/mixgen/pipeline.ts` | The generation pipeline (discover → analyse → stems → plan → render → validate) |
| `src/mixgen/setplan.ts` | Whole-set planner (beam search over order × cues × overlap, beat-matching rules) |
| `src/mixgen/longform.ts` | Staged long transitions (strategies and control lanes) |
| `src/mixgen/closedloop.ts` | Render → measure → refine → re-plan loop |
| `src/mixgen/browser/` | Browser host: analysis, preview and render workers, stem service client |
| `src/dj/` | DSP renderer, transition styles, beat and phase tools |
| `src/components/mix/` | Create, progress and listen pages, DJ board, explanation panels |
| `infra/stems/` | Azure stem job (Demucs), provisioning script, README |
| `evaluation/` | Benchmarks and real-audio evaluation harnesses |

---

## Secrets and safety

- **No secret is in the repository or the client bundle.**
  - The Groq key, Azure credentials and Jamendo client id are DeepSpace secrets, read on the
    server only.
  - The Azure credentials are least-privilege: add-only on the queue, read-only on stems, with a
    1-year expiry.
- **Every generation route requires a signed-in user** and is rate-limited per user (interpret,
  stems, polling).
- **Mix rows are owner-only** (`ownerField`), and every write is validated on the server. Audio
  is stored in the user's private file scope.
- **Licences are re-checked on the server**, from Jamendo's current metadata, before stems are
  made. Tracks that forbid derivatives get no stems.
- **The YouTube research mode is local only**, gated by `CP_RESEARCH_YOUTUBE=1`. It's never
  deployed, and its audio is never uploaded.

---

## How I worked with the coding agent, and what I verified myself

**What the agent did.** I used Claude Code throughout. It:
- wrote most of the implementation;
- ran the unit tests, benchmarks and real-audio evaluations;
- deployed and ran live browser end-to-end tests after each change;
- diagnosed failures from logs and stack traces.

I directed it with concrete product requirements and decisions, and made it prove changes on
real audio and on the live site before calling them done.

**What I verified and decided myself.** I listened to the mixes and used the live app, then sent
back what was wrong:
- **Wrong length and technique:** I asked for a 5-minute mix and got 11:42, and asked for drop
  swaps and got loop rolls. That led to binding techniques and short-set planning.
- **Missing page after sign-in:** sign-in landed on a "Nothing is playing here" page. Fixed so it
  goes straight to `/mix`.
- **UI bugs:** the "TEMPO" label on the DJ board was wrapping, and the page had two scrollbars.
  Both were fixed and checked in a browser at several window sizes.
- **Panel design:** the explanation panels read like a debugging report. They were rewritten as
  plain explanations.
- **Mixing rules:** I set them myself. Every transition must be beat-matched like a real DJ,
  at least 16 bars long, with no loop rolls.
- **Interpreter choice:** I chose a free open-source model over paid ones. Along the way I
  dropped a planned Gemini integration in favour of Claude, then tried Meta's Muse API, which was
  blocked by billing setup.
- **Stems:** I chose to run stem separation on Azure, and to always run all models and let the
  best measured output win.
- **Blind listening:** I rated a blind A/B listening set to check the audio metrics against my
  own ears.

**Where I stepped in on the agent's work:**
- **Dropped models:** when a model didn't generalise (TransitionNet v2), I accepted keeping it
  as a measured candidate, not a decision-maker.
- **Misleading test:** when a benchmark showed the interpreter at exactly the basic parser's
  score, that turned out to be rate-limit fallbacks, not a real result. I had it re-run at a
  realistic pace before trusting the number.
- **Overclaiming:** I asked for honest reporting throughout, including the regressions it found
  in its own changes (for example, the budget change that briefly caused two failed transitions).

---

## Known limitations and what I'd do next

- **Generation time (about 6–7 min for 5 songs).** Next: cache analyses on the server, keyed by
  audio hash; GPU stems; and pre-warming the stem service when the user opens the create page.
- **Loudness matching.** A recent mix had one transition with a 7.7 dB level step (the limit is
  6 dB). Next: add loudness as a hard term in the planner, and apply gain riding during the blend.
- **"Instrumental" requests** can still pick tracks with vocals when the licensed catalogue is
  thin. Next: make vocal activity a hard filter and say so when there aren't enough tracks.
- **The free-tier interpreter is rate-limited.** Next: a paid open-model tier or self-hosting
  for production traffic.
- **Mainstream songs need licensing** before they can be used in the live app; that's a business
  task, not an engineering one.
- **Console noise.** ONNX Runtime logs a harmless WebAssembly MIME-type warning. Next: serve
  `.wasm` files with the right content type.
- **Learned models.** Collect more human-rated transitions so models can be promoted on evidence
  rather than kept as candidates.

---

## Scope note

The submission's core path is: **describe → generate → listen.** The long-form planner, closed
loop and models exist to make that path sound good, and each was kept only where measurement
showed it helped. I left out things that don't serve that path: social features, payments,
co-editing, and integrations with users' accounts.
