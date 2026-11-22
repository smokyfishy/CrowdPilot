# CrowdPilot Phase 1 — Design

**Date:** 2026-11-21 · **Governing spec:** `CROWDPILOT_PHASE1_SPEC.md` (this doc records the owner's clarifications and the chosen approach; where they differ, this doc wins).

## 1. Intent

A Spotify-Jam-style collaborative listening room. A host creates a room, shares a link/QR, guests search a real catalog (YouTube), add songs, vote and react; the host's device is the only audio output. Everything is real multiplayer state on DeepSpace — no fake/static interactions. Phase 1 is a conventional sequential player; it must leave clean seams for a later AI-DJ phase (MixGraph etc.) without implementing any of it.

**Success:** host + 2 guests in separate browsers can create/join, search YouTube, add/vote/react, and the host's official YouTube player plays the queue end-to-end, with every client updating live, permissions enforced server-side, deployed at `<name>.app.space`.

## 2. Goals / non-goals / anti-goals

**Goals:** room create/join (link, QR, short code); YouTube search + add; live FIFO queue with host control; host-only playback with auto-advance; presence, votes, emoji reactions, activity feed; premium minimalist responsive UI (desktop host console, mobile-first guest); tests; README + `docs/ARCHITECTURE.md` + `docs/DECISIONS.md`; deploy.

**Non-goals (Phase 1):** chat, scheduled time slots, Audius, guest-side audio, vote-ranked ordering, any AI/DSP/crossfade/BPM/recommendation feature.

**Anti-goals (failure even if it "works"):** a hidden/audio-only or modified YouTube player; fake search results or a fake player when the key is missing; permissions enforced only in the UI; double-skips from overlapping "ended" events; a Spotify pixel-clone look.

## 3. Owner decisions (2026-11-21)

| Topic | Decision |
|---|---|
| Provider | YouTube Data API v3 (server-side search) + official visible IFrame Player on the host device. Owner has no API key yet → build the real integration with an honest "provider not configured" state and setup instructions. |
| Credentials | Owner has neither YouTube key nor DeepSpace login yet. Claude provides setup steps; owner runs `npx deepspace auth login` and `npx deepspace secrets set YOUTUBE_API_KEY=…` themselves. Deploy only with owner approval. |
| Guest identity | **Both**: guests may sign in (Google/GitHub) *or* join anonymously with a display name. Host must sign in. (See §6.3 — platform constraint, open question.) |
| Audio | Host device only. Guests see metadata + estimated progress. |
| Queue | FIFO by server-assigned `enqueueSeq`. Host can drag/keyboard reorder and pin-next. Votes are social feedback only (no reordering). Duplicate of an already queued/playing track is rejected with a "vote for it instead" affordance. |
| Moderation | Play/pause/resume/skip/remove + reorder + pin-next + lock queue (guest requests on/off) + per-guest queued-request limit + kick guest + close room. |
| Aesthetic | **High-end minimalist** (overrides spec's violet/teal): near-black/off-white monochrome, one accent color, editorial typography, generous whitespace, very quiet motion; large artwork remains the hero. Mockups shown to owner before screens are built. |
| Social | Emoji reactions (rate-limited) + activity feed. No chat, no scheduling. |
| Architecture | **Option 1: all mutations through server-side code.** Clients only read records; every write goes through a validated server endpoint. |
| Anonymous fallback | If custom routes can't write records, anonymous guests are **read-only** (see now-playing, queue, activity); Add/Vote/React prompts Google/GitHub sign-in. |
| Multiple host devices | **One active player with takeover.** Only one host device/tab is the player; others show a remote-control view with "Play here instead". |
| Privacy | If per-room isolation can't be wired, **unguessable room ids are acceptable** (unlisted-link model). Documented as a limitation. |
| Room lifetime | Rooms **auto-close after 24h without activity**; hosts may own multiple rooms and get a "Your rooms" list; expired/closed links show a "room ended" page. |

## 4. Approaches considered

1. **All writes server-side (chosen).** RBAC makes collections read-only to clients; every mutation (create/join room, enqueue, vote, react, moderation, playback commands, "ended" events) runs in server code that verifies identity + role, checks revisions, and uses idempotency keys. One place enforces every invariant; required anyway for anonymous guests. Cost: more server code.
2. **Mixed.** Simple writes (votes, reactions) directly from client under RBAC + `uniqueOn`; server actions only for host/playback. Less code, but enforcement split across two places, and anonymous guests still need path 1. Rejected.

## 5. Verified platform facts (docs.deep.space, SDK 0.43.0) that shape the design

- Scaffold: `npm create deepspace@latest`; Vite + React + TS + Tailwind v4 + Hono worker; `(app)/` public pages, `(app)/(protected)/` behind `<AuthGate>` (UI-only).
- Auth: Google/GitHub OAuth via `<AuthOverlay providers={['github','google']} />`; email signup closed. `useAuth()` → `isLoaded, isSignedIn, userId`. Anonymous sockets (with `RecordProvider allowAnonymous`) get read-only `viewer` role / `'*'` permissions.
- Server actions: `src/actions/index.ts` exports `Record<string, ActionHandler<Env>>`, exposed at `POST /api/actions/<name>`, called with `Authorization: Bearer ${await getAuthToken()}`. Context `{ userId, params, tools, env, callerJwt }`. `tools.create/update/remove/get/query/deleteWhere` bypass RBAC. **Unauthenticated calls get 401.**
- **No transactions or compare-and-set.** The only atomic guard is schema `uniqueOn` (composite uniqueness, enforced in the Durable Object on every write path; duplicates rejected).
- Per-row read scoping: `own | shared (collaboratorsField) | team | published …` — no "member of room X" primitive. RecordProvider scopes map to separate Durable Objects.
- Custom Hono routes can read secrets via `c.env.X` and verify callers with `verifyJwt(...)`.
- Secrets: `npx deepspace secrets set`, read as `env.NAME`; deployed as secret bindings; never in client bundle.
- Testing: `deepspace/testing` with `users(n)` multi-user Playwright fixture, `@deepspace.test` accounts (max 10/machine).
- Deploy: `npx deepspace deploy` from a clean, committed git tree → `https://<name>.app.space`.
- Cron exists (`src/cron.ts`) — usable for reaction/event cleanup.

The DeepSpace Claude skill contains no reference material beyond pointing at docs.deep.space; the docs and the generated scaffold are the sources of truth. Owner must install the skill via `/plugin` themselves.

## 6. Design

### 6.1 Module layout (inside the scaffold)

```
src/
  schemas/            rooms, room_members, queue_items, votes, playback_states, room_events, reactions, command_receipts
  actions/            server actions, thin: parse → authorize → call domain → write
  domain/             PURE TS, no SDK imports: queue ordering, state machine, permission rules, dedupe, rate limits
  providers/
    catalog/          MusicCatalogProvider interface + youtube implementation (server-side)
    playback/         PlaybackController interface + YouTubeIframeController (client, host only)
  worker routes       /api/catalog/search (YouTube proxy), guest-token routes (§6.3)
  ui/                 design system primitives (tokens, type scale, buttons, sheets, toasts)
  pages/              landing, sign-in/join, create room, room (host console / guest view), settings
```

`domain/` is fully unit-testable without DeepSpace. Future AI-DJ hooks attach at two seams: a `NextTrackSelector` interface (Phase 1 impl = FIFO+pins) and the `PlaybackController` interface (Phase 1 impl = single YouTube player; a later controller could own transitions).

### 6.2 Data model (adapted to DeepSpace schemas)

All collections: client RBAC `read` per §6.4, `create/update/delete: false` for every client role; writes only via server code.

- **rooms**: `code` (6-char, `uniqueOn`), `hostUserId`, `name`, `description`, `accent`, `status` (open|closed|expired), `guestRequestsEnabled`, `allowAnonymousGuests`, `perGuestLimit` (default 3), `lastActivityAt`, `queueRevision`, `playbackRevision`, `nextEnqueueSeq`.
- **room_members**: `roomId`, `identityKey` (`user:<userId>` or `guest:<guestId>`, `uniqueOn [roomId, identityKey]`), `displayName`, `role` (host|guest), `status` (active|kicked|left), `joinedAt`.
- **queue_items**: `roomId`, `trackKey` (`youtube:<id>`), denormalized track metadata (`title`, `creatorLabel` = channel name, `thumbnailUrl`, `durationMs`), `requestedByMemberId`, `requestedByName`, `enqueueSeq` (`uniqueOn [roomId, enqueueSeq]`), `sortKey` (fractional index string for host reorder; default derived from seq), `pinned`, `status` (queued|playing|played|skipped|removed|unavailable), `voteCount`, timestamps. (Spec's `catalog_tracks` cache is folded into denormalized fields — no separate collection needed.)
- **votes**: `roomId`, `queueItemId`, `memberId`, `uniqueOn [queueItemId, memberId]`. Toggle = create/remove; `voteCount` recomputed by count query, not incremented.
- **playback_states** (one per room, recordId = roomId): `currentItemId`, `state` (idle|playing|paused|blocked|error), `startedAt`, `pausedAtSec`, `playbackRevision`, `errorReason`, `updatedAt`.
- **room_events**: activity feed (`type`, `actorName`, `queueItemId?`, `payload`), bounded (cron prunes > 200 per room).
- **reactions**: `roomId`, `memberId`, `emoji`, `createdAt`; cron prunes > 1 min old; clients animate new rows.
- **command_receipts**: idempotency/serialization records, `uniqueOn [roomId, key]`.

### 6.3 Guest identity — anonymous mode (OPEN, platform constraint)

Owner chose "both sign-in and anonymous guests". DeepSpace server actions **reject unauthenticated calls (401)** and anonymous sockets are read-only. Proposed mechanism for anonymous guests:

- `POST /api/guest/join` (custom Hono route): validates room code/id + display name, creates a `room_members` row with `identityKey guest:<random>`, returns a **room-scoped guest token** = HMAC-SHA256 signed `{roomId, memberId, exp}` using a worker secret `GUEST_TOKEN_SECRET`. Stored in `localStorage` per room.
- `POST /api/guest/<command>` routes accept that token, and execute the same `domain/` logic as the server actions.
- **Update (scaffold inspection, SDK 0.44.2):** the scaffold's action tools are just a `fetch` from the worker to the RecordRoom DO stub with `X-App-Action: true` (`src/server/action-routes.ts` `createActionTools`). Any worker route can build the same tools for any scope, so the anonymous write path is feasible; the plan uses **one** command route (`POST /api/rooms/:roomId/commands`) accepting either a DeepSpace JWT or a guest token, instead of server actions + duplicate guest routes. Runtime behavior still verified in the Task 1 spike.
- **Original note — unverified:** whether a custom Hono route can write records with RBAC bypassed. Candidates to verify against the scaffold: `buildCronContext(env, ownerUserId, roomId)`'s `records` API, or a documented server-side records client. If neither works, anonymous guests are **read-only + "sign in to add songs/vote/react"** (owner-approved). This is verified in the first spike, *before* building the command layer, so the server is built once: commands are written as `domain/` functions behind a single `executeCommand(actor, command)` used by both the action wrappers and (if viable) guest routes.
- Anonymous guests read records via `RecordProvider allowAnonymous`; room privacy for them relies on an unguessable room id (see §6.4).

### 6.4 Privacy / read access

Per-room `RecordProvider` scope (`room:<roomId>`) → each room's records live in their own Durable Object, so no broad cross-room reads exist. Room ids are 128-bit random; the short `code` resolves to a room id via a server route that rate-limits lookups. Reads inside a room scope are allowed to anyone holding the id (needed for anonymous guests). Kicked members' writes are rejected server-side; a kicked anonymous guest's token is invalidated (member status checked on every call). Exact scope/permission wiring to be confirmed against the scaffold. If per-room scopes can't be written from server code, fall back to shared collections filtered by `roomId`, protected by unguessable ids (owner-approved); `room_members` exposes only display names and roles, never emails.

**Kick (builder's call):** soft removal. Member status → `kicked`; all their commands are rejected; a kicked signed-in user cannot rejoin that room (`uniqueOn` identity + status check); a kicked anonymous guest's token is invalidated and the browser remembers the kick, but a determined anonymous user could rejoin under a new name — host can then lock the room or switch it to sign-in-only (`allowAnonymousGuests` room setting, default on). Documented as a limitation.

**Guest self-removal (builder's call):** guests may remove their own *queued* (not playing) items, always on. Removal clears the `active:<trackKey>` receipt.

### 6.5 Concurrency without transactions

- **enqueueSeq**: read `rooms.nextEnqueueSeq`, create queue item with that seq (`uniqueOn [roomId, enqueueSeq]`); on duplicate, re-read and retry (≤5). Then bump the counter.
- **Dedupe**: before enqueue, query for an active (queued/playing) item with same `trackKey`; reject with `{ code: 'DUPLICATE', existingItemId }`. Race window closed by `command_receipts` key `active:<trackKey>` created on enqueue and removed when the item leaves the active set.
- **Playback advance (critical)**: every playback-changing command carries `expectedRevision`. Server claims `command_receipts` key `advance:<playbackRevision>`; only the first claim succeeds (uniqueOn), it moves current item to played/skipped, selects next via `NextTrackSelector`, bumps `playbackRevision`. Stale or duplicate "ended"/"skip" events fail the claim and return the current state. Same pattern for any multi-record op.
- **Reorder**: host sends `{itemId, beforeId, afterId, expectedQueueRevision}`; server computes new fractional `sortKey`, bumps `queueRevision`; stale revision → 409, client refetches.
- Order shown: pinned items first (by pin time), then `sortKey`.
- Rate limits: per-member token bucket kept in `command_receipts`-style rows or in-memory per worker isolate (best effort) — enqueue 5/min, reactions 1/2s, search 20/min.

### 6.6 Playback

- Host page mounts `YouTubeIframeController` (official IFrame API, visible, ≥200×200, standard controls/branding preserved). Guests never load the IFrame.
- **Controller lease:** `playback_states.controllerId` (random per host tab) + `controllerLeaseUntil`. A host tab becomes the player by `claimController` (succeeds if no live lease or explicit takeover); the active tab renews the lease every 30s (lease 90s). Non-controller host tabs render the console without the IFrame plus "Play here instead" (takeover). The previous controller sees the change via `useQuery`, pauses and unmounts its player. Playback commands and ENDED events are accepted only from the current `controllerId` (plus host remote commands like skip/pause, which the controller tab applies).
- First play needs a user gesture; if `playVideo` doesn't reach PLAYING within ~3s → state `blocked`, show "Tap to start".
- `onStateChange ENDED` → `advance({reason:'ended', expectedRevision})`. `onError` (100/101/150 = unavailable/not embeddable) → mark item `unavailable` with reason, advance; never mark as played. Consecutive-failure guard: after 3 unavailable in a row, stop and show error.
- Guests derive progress from `startedAt`/`pausedAtSec` + server time offset; host writes playback state only on transitions (play/pause/seek/advance), never per second.
- Volume is local to the host player (not shared state).
- On host reload: restore current item metadata; state shown as paused with "Resume" — no claim of seamless continuation.

### 6.7 Search

`GET /api/catalog/search?q=` (auth: signed-in JWT or guest token). Server calls `search.list` (`type=video`, `videoEmbeddable=true`, `videoCategoryId=10` music, `maxResults=12`) then `videos.list` (contentDetails, status) for duration + embeddable. Normalizes to `CatalogTrack` with `creatorLabel` = channel title (never claimed as artist). Short-lived in-memory cache per query. Missing key → `503 PROVIDER_NOT_CONFIGURED` → UI setup state. Quota errors → `429/403 QUOTA` → explicit message. Client: explicit submit + 400ms debounce, AbortController cancellation.

Before building, check `npx deepspace integrations list` for a YouTube integration; if one exists it may remove the need for the owner's API key — would be raised with the owner.

### 6.8 UI/UX

- **Screens:** Landing; Sign-in / guest-name join; Create room; Room — desktop host console (player + now playing / queue / search panel / people+activity sidebar) and mobile guest view (sticky now-playing, bottom tabs: Queue · Search · People, full-height search sheet); Invite modal (link, code, QR generated client-side); Room settings (lock queue, per-guest limit, close room); states: loading skeletons, empty queue, provider not configured, room closed/invalid, quota, playback blocked, unavailable video, disconnected, kicked.
- **Look:** minimalist — monochrome near-black (#0B0B0C-ish) / off-white, one accent (to be chosen in mockups), editorial display serif or tight grotesk for headings + neutral sans for UI, hairline dividers, artwork as the only large color surface. Motion: opacity/translate ≤200ms; reactions float subtly; all disabled under `prefers-reduced-motion`.
- **A11y:** keyboard reorder (move up/down buttons + drag), focus-trapped dialogs, aria-live for queue changes, contrast AA, 360/768/1440 breakpoints.
- Mockups go to the owner (visual companion) before screen build; frontend-design skill used for the visual system.

### 6.9 Testing

- Unit (Vitest): `domain/` — ordering, pins, dedupe, per-guest limit, state machine transitions, revision/idempotency, permission matrix; YouTube normalizer; IFrame adapter with mocked events.
- E2E (`deepspace/testing`): host + 2 guests: create/join, presence, simultaneous adds, duplicate rejection, vote uniqueness, host skip/lock/remove/kick, guest calling host action directly → 403, refresh persistence. Requires owner to create `@deepspace.test` accounts (needs their DeepSpace login).
- YouTube-dependent E2E runs only when key present; otherwise mocked provider in tests only (never in the shipped app).

### 6.10 Room lifetime

`rooms.lastActivityAt` updated by every command; `status` gains `expired`. Cron (hourly) closes rooms idle > 24h, stops playback, prunes reactions. Join/room pages show a "This room has ended" state for closed/expired rooms. Host home shows "Your rooms" (open first, then recent closed), with reopen not supported in Phase 1 (create new instead).

### 6.11 Work order and owner gates (builder's call)

1. Owner: install DeepSpace skill, `npx deepspace auth login`. 2. Scaffold + spikes: `uniqueOn` claim semantics, per-room scope writes from actions, record writes from custom routes (decides §6.3/§6.4). 3. `domain/` + unit tests (no gates). 4. Visual direction mockups → owner picks (in parallel with 3); if no answer, proceed on the proposed direction and keep it token-driven so it's cheap to change. 5. Schemas/actions/pages. 6. YouTube once owner sets key (no-key state built and tested first). 7. Owner creates `@deepspace.test` accounts → multi-user E2E. 8. Deploy with owner approval.

## 7. Left to the builder

Exact component library choices within the scaffold, file naming, fractional-index library, accent color proposal for mockups, cron intervals, exact rate-limit numbers, test-account setup scripting.

## 8. Remaining risks

- Anonymous-guest write path unverified (§6.3).
- No platform transactions; correctness rests on `uniqueOn` claims — verify `uniqueOn` rejection semantics in the scaffold early with a spike test.
- YouTube default quota (10k units/day ≈ 100 searches) — caching and debounce mitigate; documented as a limitation.
