# CrowdPilot architecture

CrowdPilot turns a plain-language request into one continuous, beat-matched DJ mix. It is a DeepSpace app: a Vite + React 19 client and a Hono worker on Cloudflare Workers, with a DeepSpace RecordRoom Durable Object as the database and realtime layer and DeepSpace file storage for rendered audio.

The core path is **sign in → describe → review the interpretation → generate → listen → refine**.

> History: the app began (2026-11-21) as a collaborative party queue (rooms, YouTube IFrame player, guest tokens). That platform was removed on 2026-11-22 to focus on the mix generator. Its schemas stay registered so stored data is not destroyed; nothing reads or writes them. The Phase 1 design is in git history: `git show phase1-release:docs/ARCHITECTURE.md`.

## The one rule

**No long-running work happens in a DeepSpace HTTP handler.** Worker routes are short and bounded. Acquisition, decoding, analysis, ML inference, planning, preview rendering and final rendering run in the signed-in user's browser, in Web Workers. The only compute outside Cloudflare is Demucs stem separation on an Azure Container Apps Job (`infra/stems`).

## Request flow

```
Browser (React)                                   Worker (worker.ts → src/server/*)
───────────────                                   ─────────────────────────────────
DeepSpaceAuthProvider / AuthGate ── JWT ────────▶ resolveAuth: verified JWT; anonymous rejected
useQuery('mixes') ◀── live WebSocket ──────────── AppRecordRoom (DO, SQLite), scope app:<APP_ID>

POST /api/mixgen/interpret ─────────────────────▶ gpt-oss-120b → gpt-oss-20b (Groq, GROQ_API_KEY)
                                                    → Claude Sonnet 5.5 via createDeepSpaceAI
                                                      (billed to the caller's JWT) → heuristic.
                                                    zod MixSpec, one repair round, deterministic guard
POST /api/mixgen/discover ──────────────────────▶ Jamendo · Audius · YouTube Data API (keys server-side)
                                                    → identity matching → decideAccess()
GET  /api/mixgen/audio/:key ────────────────────▶ jamendo:<id> only; licence re-read from Jamendo's
                                                    current metadata; streamed, cache-control: no-store
POST /api/mixgen/stems, GET /stems/:key ────────▶ Azure Storage queue (add-only SAS) → Demucs job →
                                                    private blob container (read SAS, 7-day lifecycle)
POST /api/mixgen/mixes, POST|DELETE /mixes/:id ─▶ zod MixPatch → owner check → RecordRoom write

Analysis worker pool  (src/dj/engine/analysis.worker.ts: Beat This! ONNX on WebGPU/WASM + DSP)
Preview workers       (src/mixgen/browser/preview.worker.ts: closed-loop candidates, up to 4)
Render worker         (src/mixgen/browser/render.worker.ts → WebCodecs Opus 192 kbps → Ogg muxer)
useR2Files().upload ────────────────────────────▶ DeepSpace app files, `self` scope (user-private)
```

## DeepSpace primitives

| Primitive | Code | Use |
|---|---|---|
| Auth | `src/pages/(app)/_layout.tsx`, `(protected)/_layout.tsx`, `src/server/http-routes.ts` (`resolveAuth`), `src/mixgen/browser/client.ts` (`getAuthToken`) | Every `/api/mixgen/*` route requires a verified, non-anonymous user. The user id owns the records and files and pays for Claude calls. |
| Records + RBAC + live queries | `worker.ts` (`AppRecordRoom`), `src/schemas/mixes-schema.ts`, `useQuery` in `RecentMixes.tsx` and `mix/[mixId].tsx` | `mixes`: one row per version (`rootId`, `parentId`, `version`), with spec, status, stage, progress, selection, summary, file keys and permissions. `ownerField: ownerUserId`. Clients read only their own rows and can never write. Progress written by the generating tab appears live in every open view. |
| Server-side record writes | `src/server/room-tools.ts` (`createRoomTools`) | A worker-internal fetch to the RecordRoom with `X-App-Action: true`, the same contract as the scaffold's action tools. It bypasses per-record RBAC, so every route checks ownership and validates the patch first. |
| Files (R2, `self` scope) | `useMixJob.ts` (`useR2Files`), delete route (`appFiles`), playback via `/api/files/...?scope=self` | The rendered mix and its manifest. The server rejects file keys outside the caller's folder. Deleting a mix deletes its files. |
| DeepSpace AI | `src/server/mixgen-routes.ts` | Claude Sonnet 5.5 as the interpreter backup, billed to the signed-in user. |
| Secrets | `Env` in `worker.ts` | `JAMENDO_CLIENT_ID`, `YOUTUBE_API_KEY`, `GROQ_API_KEY` (optional `OPEN_LLM_BASE_URL`, `OPEN_LLM_MODEL`), `STEMS_QUEUE_URL`, `STEMS_BLOB_BASE`, `STEMS_BLOB_SAS`. None reach the client. |
| Agent tools / MCP | `worker.ts` (`registerAgent`), `src/ai/tools.ts`, `<AgentTools />` | Scaffold default: record tools over HTTP, MCP and browser tools, under the same RBAC. |

Bound but unused:

- `JobRoom`: `src/jobs.ts` is empty. The heavy work is CPU/GPU work in the browser, and progress lives in the mix record.
- `CronRoom`: no tasks since the rooms were removed.
- Yjs, Canvas and Presence rooms: left over from the removed rooms.

## Mix records

| Field | Meaning |
|---|---|
| `status` | `draft → working → review → rendering → ready`, or `failed`. `ready` requires a manifest key. |
| `stage`, `progress` | Per stage, `{done, total, detail, at}`. Only completed work is counted. |
| `selection`, `summary` | The review step's tracks with their acquisition status, and a small summary for lists. |
| `audioKey`, `manifestKey` | Paths in the owner's private file storage. |
| `rootId`, `parentId`, `version` | Version history. A refinement creates a new row. |

A Web Lock per mix (`crowdpilot-mix:<id>`) stops two tabs of one browser from generating the same mix. A reload resumes from analyses cached in IndexedDB by content hash. An interrupted render restarts.

## Generation pipeline

`runPipeline` (`src/mixgen/pipeline.ts`) runs in three hosts:

- the browser (production);
- the Node worker (`worker-node/mixgen`), used for real-audio tests;
- the local research CLI (`worker-node/research`), which is never deployed.

1. **Spec** (`spec.ts`). A zod `MixSpec`.
   - Unstated fields stay `null` and get documented defaults.
   - The guard makes stated duration, count, BPM, genres and songs win over the model.
   - Technique requests are binding.
   - Techniques that cannot be a 16+-bar overlap (`loop_roll`, `cut`, `scratch`, `brake`, `spinback`) are dropped and reported.
2. **Discovery and identity** (`discovery.ts`, `identity.ts`). One query plan across the providers. "Same recording" means the same version tag and a duration within ±4 s.
3. **Policy** (`policy.ts`). `decideAccess()` decides acquire / analyse / mix / persist / export. Production mixes only Jamendo CC without ND.
4. **Acquisition and analysis.** Audio is integrity-checked. Analysis produces Beat This! beats and downbeats, a constant-tempo grid fit, key, BS.1770 loudness, phrases, sections, drops and energy. Stems are requested during analysis.
5. **Global set planning** (`profile.ts`, `setplan.ts`, `prodj.ts`). A beam search over subset and order with concrete edges (cues × 16–64-bar overlap × technique).
   - Edge costs combine rule terms, bar-level compatibility, MixGraph severity and measured costs.
   - **House rule: every transition is beat-matched within ±8 % (key lock), lasts at least 16 bars, and sits on steady-beat sections.**
   - A single flagged 16+-bar fade is the last resort when no beat-matched order exists.
6. **Long-form performances** (`longform.ts`). Introduce → layer → develop → transfer → resolve, driving fader, crossfader, EQ, filter, echo, tempo, loop, cue and stem lanes.
7. **Closed loop** (`closedloop.ts`, `audio-quality.ts`).
   - Candidate previews are rendered by the production renderer in parallel workers, then measured.
   - Hard failures are rejected.
   - Measured costs are fed back and the set is re-planned.
   - Every final transition is measured.
8. **Render and validation** (`mix-render.ts`, `src/dj/render.ts`, `validate.ts`).
   - Render: WSOLA time-stretch, LR4 EQ, per-sample automation, and a −1 dBFS look-ahead limiter.
   - Validation: gaps, clipping, level jumps, loudness, duration ±10 %, splices, beat-matching, and the rendered-transition checks.
9. **Manifest** (`manifest.ts`). Actual timestamps, executed automation, waveform, licences and attribution, and the model trace shown in the Listen view.

Details and evidence: [AI_MIX_GENERATOR.md](AI_MIX_GENERATOR.md), [PRO_DJ_REPORT.md](PRO_DJ_REPORT.md), [MODEL_CARDS.md](MODEL_CARDS.md).

## Security

- Secrets stay server-side. The browser never sees the Jamendo client id, the API keys or the queue token.
- Every route requires a verified non-anonymous JWT and checks body size, zod validation and ownership.
- Every collection is read-only to every client role.
- Per-user token buckets limit requests:
  - interpret: 10/min
  - discover: 6/min
  - audio: 120/min
  - stem requests: 30 per 10 min
  - stem polls: 240/min
  - writes: 240/min

  They are per isolate, so they are best effort, not global.
- The browser receives a read-only, container-wide stem SAS. It expires after 1 year, and blobs are deleted after 7 days. Per-blob, short-lived SAS would be stricter.
- Research mode (`CP_RESEARCH_YOUTUBE=1`) is read only in `worker-node/mixgen/research.ts`. The Worker answers 404 for `/__research/*`.

## Known limits

- The deployed catalog is effectively Jamendo CC. Mainstream requests are reported unavailable.
- Generation speed depends on the user's device, and the tab must stay open.
- Rate limits are per isolate.
