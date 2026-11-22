# CrowdPilot Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a real-time collaborative listening room (host-only YouTube playback, shared FIFO queue, votes, reactions, presence) on DeepSpace at `<name>.app.space`.

**Architecture:** DeepSpace scaffold (SDK 0.44.2). Each room's live data lives in its own RecordRoom Durable Object scope `room:<roomId>`; a host-owned `rooms` directory lives in the app scope `app:<APP_ID>`. Clients only *read* records (`useQuery`); every mutation goes through one worker route, `POST /api/rooms/:roomId/commands`, which resolves the caller (DeepSpace JWT or HMAC guest token), runs pure `src/domain/` rules, and writes through RBAC-bypassing record tools. Multi-record races are serialized by "claim" rows in `command_receipts` guarded by `uniqueOn`.

**Tech Stack:** Vite + React 19 + TS, Tailwind v4, scaffold UI primitives (`src/components/ui`, base-ui), Hono worker, DeepSpace records/presence/cron, Vitest, `deepspace/testing` Playwright, YouTube Data API v3 + IFrame Player API, `fractional-indexing`, `@dnd-kit/core` + `@dnd-kit/sortable`, `qrcode`.

**Spec:** `docs/superpowers/specs/2026-11-21-crowdpilot-phase1-design.md` (governing; overrides `CROWDPILOT_PHASE1_SPEC.md` where they differ). Read both.

## Global Constraints

- SDK `deepspace@0.44.2`; Node 22.15+/24/26; npm ≥ 11.6. Verify any SDK API against `node_modules/deepspace/dist/*.d.ts` before use — never invent exports.
- Git authority = GitHub `https://github.com/smokyfishy/CrowdPilot` (remote `origin`). **Never run `npx deepspace push`.** First deploy must run from a checkout whose GitHub remote is selected.
- Secrets only via `npx deepspace secrets set` (`YOUTUBE_API_KEY`, `GUEST_TOKEN_SECRET`). Never write secret values into files, commits, logs, tests or screenshots. Never hand-edit `.dev.vars`.
- Client never writes records. All collections: `create: false, update: false, delete: false` for every client role (`'*'`, `viewer`, `member`, `admin`).
- YouTube player: official IFrame API, visible, ≥ 200×200 px, native controls/branding untouched; never hidden, audio-only, overlapped, or modified. Search server-side only.
- No fake catalog results or fake player in the shipped app. Missing key → "provider not configured" state.
- No AI/DJ features (no crossfade, BPM, recommendations, auto-reordering).
- Queue order: pinned (by `pinnedAt` asc) then `sortKey` asc then `enqueueSeq` asc. Votes never affect order.
- Defaults: `perGuestLimit = 3`, room idle expiry 24 h, controller lease 90 s renewed every 30 s, unavailable-skip guard = 3 consecutive, reactions 1 per 2 s per member, enqueue 5/min per member, search 20/min per caller, activity feed keeps 200 events/room.
- Visual: high-end minimalist — near-black/off-white monochrome, one accent, editorial type, quiet motion (≤ 200 ms opacity/translate), all motion off under `prefers-reduced-motion`. Not a Spotify clone.
- Accessibility: WCAG AA contrast, keyboard-operable everything (incl. reorder), focus-trapped dialogs, `aria-live="polite"` queue announcements, layouts verified at 360 / 768 / 1440 px.
- Copy: YouTube channel is labelled as channel/"by <channel>", never asserted as artist.

## Review Focus

1. **Two "ended" events / skip-while-ending race** → exactly one advance; second returns current state. (Task 4 + Task 6 test `advance is idempotent per revision`.)
2. **Host with two tabs** → only the lease holder mounts a player; ENDED from non-controller rejected `NOT_CONTROLLER`. (Task 4 `claim/renew/takeover` tests + Task 6 `advance from non-controller rejected`.)
3. **Guest calls a host-only command directly** (skip/kick/reorder with forged body) → 403 `FORBIDDEN`. (Task 6 `guest cannot moderate` + Task 13 E2E.)
4. **Two guests add the same video at the same instant** → one queued item, other gets `DUPLICATE` with `existingItemId`. (Task 6 `concurrent duplicate enqueue`.)
5. **Every queued video is unavailable** → stops after 3 consecutive failures with an error state, never loops, never marks unavailable items `played`. (Task 4 `consecutive failure guard`.)

---

## File Structure (repo root = `C:\Users\aksha\OneDrive\Documents\CrowdPilot`)

```
src/domain/            pure TS, no SDK imports
  types.ts             shared domain types + Result/DomainError
  queue.ts             ordering, sortKey, active-set helpers
  rules.ts             permission + request-policy checks
  playback.ts          NextTrackSelector, advance/play/pause/lease planners, progress estimate
  rate-limit.ts        token bucket (pure, clock injected)
src/providers/catalog/
  types.ts             CatalogTrack, MusicCatalogProvider
  youtube.ts           YouTube search+videos normalizer (server)
src/providers/playback/
  types.ts             PlaybackController
  youtube-iframe.ts    IFrame API controller (client, host only)
src/server/
  room-tools.ts        createRoomTools(env, scopeId, actingUserId) (generalized from action-routes)
  claims.ts            claim/release via command_receipts
  guest-token.ts       HMAC sign/verify
  actor.ts             resolveActor(env, req, roomId)
  commands.ts          executeCommand(...) — the single mutation entry
  room-routes.ts       /api/rooms*, /api/catalog/search, /api/time
  testing/memory-tools.ts  in-memory ActionTools with uniqueOn (tests only)
src/schemas/           one file per collection (see Task 5)
src/client/
  api.ts               typed fetch wrappers (JWT or guest token)
  guest-session.ts     localStorage guest token per room
  hooks.ts             useRoomData(roomId), useServerClock(), useActor(roomId)
src/components/ui/     scaffold primitives, restyled via tokens
src/components/room/   NowPlaying, QueueList, SearchSheet, PeoplePanel, ActivityFeed, Reactions, InviteDialog, SettingsDialog, HostPlayer, StatusBanners
src/pages/index.tsx                         landing (static)
src/pages/(app)/start.tsx                   sign-in / your rooms / create
src/pages/(app)/(protected)/create.tsx      create room
src/pages/(app)/join/[code].tsx             code → room redirect
src/pages/(app)/room/[roomId].tsx           room (host console or guest view)
src/cron.ts                                 expiry + pruning
tests/e2e/*.spec.ts                         multi-user Playwright
docs/ARCHITECTURE.md, docs/DECISIONS.md, README.md
```

Remove scaffold demo pages not used (`home.tsx`, `api-status.tsx`) and replace `Navigation`.

---

### Task 1: Repository, scaffold, and platform spikes

**Files:** whole scaffold at repo root; `.gitignore`; `tests/spike/platform.spec.ts` (deleted at end of task, findings recorded in `docs/DECISIONS.md`).

**Interfaces:** Produces the scaffold layout above; `SCOPE_ID` from `src/constants.ts`.

- [ ] **Step 1:** Scaffold into the existing folder: `npx create-deepspace@0.44.2 .` from repo root (keeps `CROWDPILOT_PHASE1_SPEC.md`, `docs/`). Expected: "ready — it registers on first use".
- [ ] **Step 2:** `git init -b main`, `git remote add origin https://github.com/smokyfishy/CrowdPilot.git`, confirm `.gitignore` covers `node_modules`, `.dev.vars`, `.deepspace/`, `dist`. Commit "chore: scaffold DeepSpace app + spec + design". Push `main`.
- [ ] **Step 3 (owner gate):** `npx deepspace auth whoami --json` must show the owner. If not logged in, stop and ask the owner to run `npx deepspace auth login` in their own terminal. Then `npx deepspace app init --json`; commit the minted `DEEPSPACE_APP_ID` in `wrangler.toml`.
- [ ] **Step 4:** Run `npx deepspace integrations list` and record whether a YouTube search integration exists (report to owner; plan proceeds with own key either way).
- [ ] **Step 5:** Spike (temporary schema `spike_claims` with `uniqueOn: ['roomId','key']`, temporary route): verify against `npx deepspace dev start` that (a) a second `records.create` with same `(roomId,key)` returns `success:false` with "Duplicate", including when two creates are fired concurrently; (b) tools built on stub `idFromName('room:test1')` write records that a browser `RecordScope roomId="room:test1"` sees live via `useQuery`; (c) anonymous browser sockets can read that scope; (d) `usePresenceRoom('room:test1')` lists anonymous peers or not. Record each result in `docs/DECISIONS.md` §Platform findings.
- [ ] **Step 6:** If (a) fails → stop, report to owner (concurrency design changes). If (b) fails → switch to app-scope collections with `roomId` filter (owner-approved fallback) and note it. If (d) fails → anonymous guests show as members-without-presence.
- [ ] **Step 7:** Remove spike code; commit "chore: record platform spike findings".

### Task 2: Domain types and queue ordering

**Files:** Create `src/domain/types.ts`, `src/domain/queue.ts`; Test `src/domain/queue.test.ts`. `npm i fractional-indexing`.

**Interfaces — Produces:**
```ts
export type MemberRole = 'host' | 'guest'
export type QueueStatus = 'queued'|'playing'|'played'|'skipped'|'removed'|'unavailable'
export interface Actor { memberId: string; identityKey: string; role: MemberRole; displayName: string; signedIn: boolean }
export interface TrackRef { trackKey: string; title: string; creatorLabel?: string; thumbnailUrl?: string; durationMs?: number }
export interface QueueItem extends TrackRef { id: string; requestedByMemberId: string; requestedByName: string; enqueueSeq: number; sortKey: string; pinnedAt: number | null; status: QueueStatus; voteCount: number; createdAt: number; failureReason?: string }
export interface RoomState { roomId: string; name: string; hostUserId: string; hostName: string; status: 'open'|'closed'|'expired'; guestRequestsEnabled: boolean; allowAnonymousGuests: boolean; perGuestLimit: number; queueRevision: number; nextEnqueueSeq: number; lastActivityAt: number }
export type PlayerState = 'idle'|'playing'|'paused'|'blocked'|'error'
export interface PlaybackState { currentItemId: string|null; state: PlayerState; startedAt: number|null; pausedAtSec: number|null; playbackRevision: number; controllerId: string|null; controllerLeaseUntil: number|null; errorReason: string|null; consecutiveFailures: number; updatedAt: number }
export interface Member { id: string; identityKey: string; displayName: string; role: MemberRole; status: 'active' | 'kicked'; joinedAt: number; signedIn: boolean }
export type RoomEventType = 'join' | 'enqueue' | 'remove' | 'skip' | 'now_playing' | 'kick' | 'settings' | 'closed'
export interface RoomEvent { id: string; type: RoomEventType; actorName: string; queueItemId?: string; payload?: Record<string, unknown>; createdAt: number }
export interface Reaction { id: string; memberId: string; memberName: string; emoji: string; createdAt: number }
export type ErrorCode = 'UNAUTHENTICATED'|'FORBIDDEN'|'KICKED'|'ROOM_CLOSED'|'REQUESTS_LOCKED'|'DUPLICATE'|'LIMIT_REACHED'|'NOT_FOUND'|'STALE_REVISION'|'NOT_CONTROLLER'|'RATE_LIMITED'|'INVALID'|'PROVIDER_NOT_CONFIGURED'|'QUOTA'|'UPSTREAM'
export interface DomainError { code: ErrorCode; message: string; existingItemId?: string; retryAfterMs?: number }
export type Result<T> = { ok: true; value: T } | { ok: false; error: DomainError }
// queue.ts
export const ACTIVE: ReadonlySet<QueueStatus>          // queued, playing
export function upNext(items: QueueItem[]): QueueItem[]  // status 'queued' only, ordered per Global Constraints
export function history(items: QueueItem[], limit = 30): QueueItem[] // played|skipped|unavailable, newest first by updated order (enqueueSeq desc fallback)
export function sortKeyAfterLast(items: QueueItem[]): string
export function sortKeyBetween(before: string|null, after: string|null): string
```

- [ ] **Step 1: Failing tests** in `queue.test.ts`: `upNext orders pinned first by pinnedAt, then sortKey, then enqueueSeq`; `upNext excludes playing/played/removed`; `sortKeyAfterLast sorts after every existing key`; `sortKeyBetween(a,b) yields a < k < b` and `sortKeyBetween(null,a) < a`; `history returns finished items newest first and caps at limit`.
- [ ] **Step 2:** `npx vitest run src/domain/queue.test.ts` → FAIL (module not found).
- [ ] **Step 3:** Implement using `generateKeyBetween` from `fractional-indexing`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit "feat(domain): queue types and ordering".

### Task 3: Request policy and permission rules

**Files:** Create `src/domain/rules.ts`, `src/domain/rate-limit.ts`; Test `src/domain/rules.test.ts`, `src/domain/rate-limit.test.ts`.

**Interfaces — Consumes:** Task 2 types. **Produces:**
```ts
export function checkRoomOpen(room: RoomState): Result<void>
export function checkEnqueue(actor: Actor, room: RoomState, items: QueueItem[], trackKey: string): Result<void>
export function checkVote(actor: Actor, item: QueueItem | undefined): Result<void>           // item must be queued|playing
export function checkRemove(actor: Actor, item: QueueItem | undefined): Result<void>         // host: queued|playing; guest: own + queued only
export function checkHost(actor: Actor): Result<void>
export function checkCanJoin(room: RoomState, signedIn: boolean, kicked: boolean): Result<void>
export function sanitizeDisplayName(raw: string): Result<string>   // trim, collapse spaces, strip control chars, 1–32 chars
export class TokenBucket { constructor(capacity: number, refillPerMs: number); take(key: string, now: number): Result<void> }
```

- [ ] **Step 1: Failing tests:** `checkEnqueue rejects when room closed (ROOM_CLOSED)`; `rejects guest when guestRequestsEnabled=false (REQUESTS_LOCKED) but allows host`; `rejects duplicate active trackKey with existingItemId`; `allows re-adding a track that was played`; `rejects guest at perGuestLimit=3 queued items (LIMIT_REACHED), host unlimited`; `checkRemove: guest may remove own queued item, not own playing item, not others'`; `checkHost rejects guest FORBIDDEN`; `checkCanJoin rejects kicked (KICKED), anonymous when allowAnonymousGuests=false (UNAUTHENTICATED), closed/expired (ROOM_CLOSED)`; `sanitizeDisplayName rejects empty and >32, strips \u0000-\u001f`; `TokenBucket(5, 5/60000) allows 5 then RATE_LIMITED with retryAfterMs > 0, refills over time`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit "feat(domain): request policy, permissions, rate limiting".

### Task 4: Playback state machine and controller lease

**Files:** Create `src/domain/playback.ts`; Test `src/domain/playback.test.ts`.

**Interfaces — Consumes:** Tasks 2–3. **Produces:**
```ts
export interface NextTrackSelector { select(items: QueueItem[]): QueueItem | null }   // Phase-2 seam
export const fifoSelector: NextTrackSelector                                          // = upNext(items)[0] ?? null
export type AdvanceReason = 'ended' | 'skip' | 'error'
export interface AdvanceInput { reason: AdvanceReason; expectedRevision: number; controllerId?: string; errorCode?: number }
export interface AdvancePlan { finished?: { itemId: string; status: 'played'|'skipped'|'unavailable'; failureReason?: string }; startItemId: string | null; next: PlaybackState }
export function planAdvance(s: PlaybackState, items: QueueItem[], actor: Actor, input: AdvanceInput, now: number, selector?: NextTrackSelector): Result<AdvancePlan>
export function planPlay(s: PlaybackState, items: QueueItem[], actor: Actor, input: { expectedRevision: number; controllerId?: string; positionSec?: number }, now: number, selector?: NextTrackSelector): Result<{ startItemId: string | null; next: PlaybackState }>
export function planPause(s: PlaybackState, actor: Actor, input: { expectedRevision: number; positionSec: number; controllerId?: string }, now: number): Result<PlaybackState>
export function planBlocked(s: PlaybackState, actor: Actor, input: { expectedRevision: number; controllerId: string }, now: number): Result<PlaybackState>
export function planClaimController(s: PlaybackState, actor: Actor, input: { controllerId: string; takeover: boolean }, now: number): Result<PlaybackState>
export function planRenewLease(s: PlaybackState, actor: Actor, controllerId: string, now: number): Result<PlaybackState>
export function estimateProgressSec(s: PlaybackState, serverNow: number): number
export const LEASE_MS = 90_000, RENEW_MS = 30_000, MAX_CONSECUTIVE_FAILURES = 3
export const UNAVAILABLE_ERROR_CODES = [2, 5, 100, 101, 150]
```
Rules: every plan except claim/renew requires `expectedRevision === s.playbackRevision` (else `STALE_REVISION`) and bumps revision by 1. `ended`/`error` require `controllerId === s.controllerId` with a live lease (else `NOT_CONTROLLER`); `skip`/`play`/`pause` require host role (guest → `FORBIDDEN`) — remote host tabs may skip/pause. `ended` → finished `played`, failures reset 0; `skip` → `skipped`; `error` with code in `UNAVAILABLE_ERROR_CODES` → `unavailable` + reason, `consecutiveFailures+1`; when it reaches 3 → state `error`, no next item started. Empty queue after advance → state `idle`, `currentItemId null`. `planPlay` with no current item starts `selector.select`; with paused current resumes with `startedAt = now - positionSec*1000`. Claim succeeds if no controller, lease expired, same controllerId, or `takeover` (host only).

- [ ] **Step 1: Failing tests:** `advance(ended) marks played and starts next, revision+1`; `advance is idempotent per revision: second call with old revision → STALE_REVISION`; `advance from non-controller rejected NOT_CONTROLLER`; `advance with expired lease rejected`; `guest skip FORBIDDEN, host skip from non-controller tab allowed`; `error 150 marks unavailable with reason, never played`; `consecutive failure guard: 3rd unavailable → state error, startItemId null`; `ended resets consecutiveFailures`; `empty queue → idle`; `play resumes paused at positionSec`; `pause stores pausedAtSec`; `claim: free → ok; live other lease → FORBIDDEN without takeover; takeover by host → ok`; `renew extends controllerLeaseUntil by LEASE_MS only for current controller`; `estimateProgressSec: playing = (now-startedAt)/1000, paused = pausedAtSec, idle = 0`; `fifoSelector respects pin`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit "feat(domain): playback state machine with idempotent advance and controller lease".

### Task 5: Schemas

**Files:** Create `src/schemas/rooms-schema.ts`, `room-state-schema.ts`, `room-members-schema.ts`, `queue-items-schema.ts`, `votes-schema.ts`, `playback-schema.ts`, `room-events-schema.ts`, `reactions-schema.ts`, `command-receipts-schema.ts`; Modify `src/schemas.ts`; Test `src/schemas/schemas.test.ts`.

**Interfaces — Produces** collection names (constants exported from `src/schemas/names.ts`): `rooms` (app scope; `ownerField: 'hostUserId'`, read `'own'` for member/admin, false for `'*'`/viewer; columns `roomId` (uniqueOn), `code` (uniqueOn), `hostUserId`, `name`, `status`, `lastActivityAt`, `createdAt`), and in room scope: `room_state` (singleton id `state`, mirrors `RoomState`), `room_members` (`identityKey`, `displayName`, `role`, `status` active|kicked, `joinedAt`; `uniqueOn ['identityKey']`), `queue_items` (QueueItem fields; `uniqueOn ['enqueueSeq']`), `votes` (`queueItemId`, `memberId`; `uniqueOn ['queueItemId','memberId']`), `playback` (singleton id `state`, PlaybackState), `room_events` (`type`, `actorName`, `queueItemId`, `payload` json, `createdAt`), `reactions` (`memberId`, `memberName`, `emoji`, `createdAt`), `command_receipts` (`key` uniqueOn, `createdAt`, `ref`). Room-scope collections: read `true` for `'*'`, viewer, member, admin, except `command_receipts` read false and `room_members` exposes no email. All writes false for all client roles. Use `storage`/`interpretation` per `deepspace/schema` types; json payloads as `interpretation: 'json'`; booleans `{ kind: 'boolean' }`; text `maxLength` on names (32), titles (200).

- [ ] **Step 1: Failing test** `schemas.test.ts`: for every schema except `users`/`settings`, every role in `permissions` has `create === false`, `update === false`, `delete === false`; `command_receipts` readable by no role; `rooms` not readable by `'*'`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement and register in `src/schemas.ts`. **Step 4:** Run → PASS; `npx tsc --noEmit` clean.
- [ ] **Step 5:** Commit "feat: DeepSpace schemas for rooms, queue, playback, social".

### Task 6: Server command layer, guest identity, routes

**Files:** Create `src/server/room-tools.ts`, `claims.ts`, `guest-token.ts`, `actor.ts`, `commands.ts`, `room-routes.ts`, `testing/memory-tools.ts`; Modify `src/server/action-routes.ts` (use `createRoomTools` for `app:` scope), `worker.ts` (register `registerRoomRoutes(app)` before `registerPlatformProxyRoutes`; add `YOUTUBE_API_KEY?`, `GUEST_TOKEN_SECRET?` to `Env`); Tests `src/server/commands.test.ts`, `guest-token.test.ts`.

**Interfaces — Consumes:** Tasks 2–5; `ActionTools` type from `deepspace/worker`. **Produces:**
```ts
// room-tools.ts
export function roomScope(roomId: string): string            // `room:${roomId}`
export function createRoomTools(env: Env, scopeId: string, actingUserId: string): ActionTools
// claims.ts
export async function claim(tools: ActionTools, key: string, ref?: string): Promise<boolean>   // create in command_receipts; false on Duplicate
export async function release(tools: ActionTools, key: string): Promise<void>
// guest-token.ts
export async function signGuestToken(secret: string, p: { roomId: string; memberId: string; exp: number }): Promise<string>
export async function verifyGuestToken(secret: string, token: string, now: number): Promise<{ roomId: string; memberId: string } | null>
// actor.ts
export async function resolveActor(env: Env, req: Request, roomId: string): Promise<Result<Actor>>  // Bearer JWT (resolveAuth) or X-Guest-Token
// commands.ts
export type RoomCommand =
  | { type: 'enqueue'; track: TrackRef; idempotencyKey: string }
  | { type: 'vote' | 'unvote' | 'remove' | 'pin' | 'unpin'; itemId: string }
  | { type: 'reorder'; itemId: string; beforeId: string | null; afterId: string | null; expectedQueueRevision: number }
  | { type: 'react'; emoji: string }                                  // allowed set: 🔥 ❤️ 🙌 😂 🎉 👏
  | { type: 'play'; expectedRevision: number; controllerId?: string; positionSec?: number }
  | { type: 'pause'; expectedRevision: number; positionSec: number; controllerId?: string }
  | { type: 'blocked'; expectedRevision: number; controllerId: string }
  | { type: 'advance'; reason: AdvanceReason; expectedRevision: number; controllerId?: string; errorCode?: number }
  | { type: 'claimController'; controllerId: string; takeover: boolean }
  | { type: 'renewLease'; controllerId: string }
  | { type: 'updateSettings'; patch: Partial<Pick<RoomState, 'guestRequestsEnabled'|'allowAnonymousGuests'|'perGuestLimit'|'name'>> }
  | { type: 'kick'; memberId: string }
  | { type: 'closeRoom' }
export type CommandResult = Result<{ serverNow: number; itemId?: string }>
export async function executeCommand(tools: ActionTools, actor: Actor, cmd: RoomCommand, now: number): Promise<CommandResult>
export async function createRoom(appTools: ActionTools, roomToolsFor: (roomId: string) => ActionTools, host: { userId: string; name: string }, input: { name: string }, now: number): Promise<Result<{ roomId: string; code: string }>>
export async function joinRoom(tools: ActionTools, who: { identityKey: string; displayName: string; signedIn: boolean; role: MemberRole }, now: number): Promise<Result<{ memberId: string }>>
```
Routes (`room-routes.ts`): `POST /api/rooms` (JWT required) → createRoom; `GET /api/rooms/by-code/:code` (rate-limited, returns `{ roomId }` or 404); `GET /api/rooms/:roomId/preview` → `{ name, hostName, status, participantCount, guestRequestsEnabled, allowAnonymousGuests }`; `POST /api/rooms/:roomId/join` body `{ displayName }` → JWT: member `user:<userId>`; no JWT: guest member `guest:<uuid>` + `{ guestToken }` (exp 7 days; 503 if `GUEST_TOKEN_SECRET` missing); `POST /api/rooms/:roomId/commands` body `RoomCommand` → `resolveActor` then `executeCommand`; HTTP status map: UNAUTHENTICATED 401, FORBIDDEN/KICKED/NOT_CONTROLLER 403, NOT_FOUND 404, DUPLICATE/STALE_REVISION 409, RATE_LIMITED 429, ROOM_CLOSED 410, else 400. `GET /api/time` → `{ serverNow }`. Body size cap 8 KB; validate with `zod`.

Command semantics: room ids `crypto.randomUUID()`; code = 6 chars from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, retry on uniqueOn conflict. Every revisioned command claims `queue:<queueRevision>` or `playback:<playbackRevision>` before writing; claim failure → `STALE_REVISION` (for `advance`, return ok with current state as no-op so a duplicate ENDED is harmless — client treats as success). `enqueue`: idempotency claim `idem:<memberId>:<idempotencyKey>` (repeat → ok with existing itemId), then `checkEnqueue`, then claim `active:<trackKey>` (fail → re-read; if referenced item no longer active, release and retry once; else DUPLICATE), then create item with `enqueueSeq = room.nextEnqueueSeq` retrying on Duplicate (≤5), bump counters. `vote`/`unvote` create/remove `votes` row id `${itemId}:${memberId}` then set `voteCount` from count query. Items leaving the active set release `active:<trackKey>`. Every command updates `room_state.lastActivityAt` and appends a `room_events` row for: join, enqueue, remove, skip, now-playing change, kick, settings change. Rate limits via module-level `TokenBucket` maps (best effort per isolate; documented).

- [ ] **Step 1:** Write `memory-tools.ts`: in-memory `ActionTools` keyed by collection, enforcing each schema's `uniqueOn` from `src/schemas.ts` (returns `{ success:false, error:'Duplicate: …' }`) and supporting `query` `where` equality + `orderBy`. Add a `concurrently()` helper that interleaves two command promises at each `await`.
- [ ] **Step 2: Failing tests** in `commands.test.ts`: `createRoom creates rooms dir row, room_state, playback, host member`; `join is idempotent for same identityKey`; `kicked member commands rejected KICKED`; `enqueue assigns increasing enqueueSeq and sortKey`; `concurrent duplicate enqueue → one item, other DUPLICATE with existingItemId`; `concurrent distinct enqueues get distinct enqueueSeq`; `enqueue idempotencyKey repeat returns same itemId`; `vote twice keeps voteCount 1; unvote → 0`; `guest cannot moderate (skip, kick, reorder, pin, updateSettings, closeRoom → FORBIDDEN)`; `guest removes own queued item`; `reorder with stale queueRevision → STALE_REVISION`; `advance is idempotent per revision under concurrency (two ENDED → one advance)`; `advance from non-controller rejected`; `react rate limited after 1 per 2s`; `closeRoom → later enqueue ROOM_CLOSED`. In `guest-token.test.ts`: `round-trips`, `rejects tampered payload`, `rejects expired`, `rejects other room`.
- [ ] **Step 3:** Run `npx vitest run src/server` → FAIL. **Step 4:** Implement. **Step 5:** Run → PASS; `npx tsc --noEmit` clean.
- [ ] **Step 6 (needs Task 1 login):** Set guest secret without echoing it: generate 32 random bytes in Node and pipe to `npx deepspace secrets set GUEST_TOKEN_SECRET` per `secrets set --help` (stdin form). Smoke the routes against `npx deepspace dev start` with curl (create without JWT → 401; anonymous join → token; guest `advance` → 403).
- [ ] **Step 7:** Commit "feat(server): single command endpoint with guest tokens, claims, idempotent playback".

### Task 7: YouTube catalog provider and search route

**Files:** Create `src/providers/catalog/types.ts`, `src/providers/catalog/youtube.ts`; Modify `src/server/room-routes.ts` (add `GET /api/catalog/search`); Test `src/providers/catalog/youtube.test.ts` with recorded JSON fixtures in `src/providers/catalog/__fixtures__/` (hand-written, no real key).

**Interfaces — Produces:**
```ts
export type TrackSource = 'youtube'
export interface CatalogTrack { source: TrackSource; sourceId: string; trackKey: string; title: string; creatorLabel?: string; thumbnailUrl?: string; durationMs?: number; canonicalUrl?: string; playable: boolean | 'unknown' }
export interface MusicCatalogProvider { search(query: string, signal?: AbortSignal): Promise<Result<CatalogTrack[]>> }
export function createYouTubeProvider(apiKey: string | undefined, fetchImpl?: typeof fetch): MusicCatalogProvider
export function parseIsoDuration(iso: string): number | undefined   // PT3M21S → 201000
```
Search: `search.list?part=snippet&type=video&videoEmbeddable=true&videoCategoryId=10&maxResults=12&safeSearch=none&q=` then `videos.list?part=contentDetails,status&id=…`; drop items with `status.embeddable === false`; decode HTML entities in titles; `creatorLabel` = `snippet.channelTitle`; thumbnail = `high ?? medium ?? default`. Errors: no key → `PROVIDER_NOT_CONFIGURED`; 403 with reason `quotaExceeded|dailyLimitExceeded` → `QUOTA`; other non-2xx → `UPSTREAM`. Route: requires JWT or valid guest token for the `roomId` query param; query trimmed 2–100 chars; 60 s in-memory cache by lowercase query; bucket 20/min per caller.

- [ ] **Step 1: Failing tests:** `normalizes search+videos into CatalogTrack with trackKey youtube:<id>`; `decodes &amp;/&#39; in titles`; `filters non-embeddable`; `parseIsoDuration handles PT1H2M3S, PT45S, P0D`; `no key → PROVIDER_NOT_CONFIGURED without calling fetch`; `quotaExceeded → QUOTA`; `500 → UPSTREAM`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5 (owner key):** Store the owner-provided key via `npx deepspace secrets set YOUTUBE_API_KEY` using the stdin form (never on a logged command line, never in a file); restart dev; `curl` search for "daft punk" with a guest token → ≥ 1 result. Record outcome.
- [ ] **Step 6:** Commit "feat(catalog): YouTube search provider and route".

### Task 8: Visual system (owner gate: direction mockups)

**Files:** Modify `src/themes.css`, `src/styles.css`, `src/themes.ts`, `index.html` (fonts), restyle `src/components/ui/*` via tokens only; Create `src/components/brand/Logo.tsx`, `src/components/ui/Artwork.tsx`, `src/components/ui/Skeleton.tsx`.

- [ ] **Step 1:** Invoke `frontend-design:frontend-design`. Produce 2–3 minimalist direction mockups (landing hero + host console + mobile room) as an Artifact page; owner picks (if no answer, proceed with recommended). Directions differ in accent color and type pairing only within the minimalist brief.
- [ ] **Step 2:** Encode chosen direction as CSS custom properties: `--bg`, `--surface`, `--surface-2`, `--line`, `--text`, `--text-muted`, `--accent`, `--accent-contrast`, `--danger`, radius scale, type scale (display/title/body/meta), motion durations with `@media (prefers-reduced-motion: reduce)` zeroing them. Dark only (app is dark-mode product).
- [ ] **Step 3:** Restyle primitives; `Artwork` renders thumbnail with fixed aspect, `loading="lazy"`, monochrome fallback tile with initials. Verify contrast of text/muted/accent on bg ≥ 4.5:1 (compute and note values in `docs/DECISIONS.md`).
- [ ] **Step 4:** `npm run build` passes; screenshot primitives page at 360 and 1440 via Playwright MCP; commit "feat(ui): CrowdPilot minimalist design system".

### Task 9: Landing, sign-in, your rooms, create, join

**Files:** Modify `src/pages/index.tsx` (static landing), `src/components/Navigation.tsx`; Create `src/pages/(app)/start.tsx`, `src/pages/(app)/(protected)/create.tsx`, `src/pages/(app)/join/[code].tsx`, `src/client/api.ts`, `src/client/guest-session.ts`; delete `home.tsx`, `api-status.tsx`; Test `src/client/api.test.ts`.

**Interfaces — Produces:**
```ts
// api.ts
export async function apiFetch<T>(path: string, init: { method?: string; body?: unknown; roomId?: string }): Promise<Result<T>>  // attaches Bearer getAuthToken() if signed in, else X-Guest-Token for roomId; maps HTTP errors to DomainError
export const roomApi: { create(name: string); byCode(code: string); preview(roomId: string); join(roomId: string, displayName: string); command(roomId: string, cmd: RoomCommand); search(roomId: string, q: string, signal?: AbortSignal); time() }
// guest-session.ts
export function getGuestToken(roomId: string): string | null; export function setGuestToken(roomId: string, t: string): void; export function clearGuestToken(roomId: string): void  // try/catch around localStorage
```
Landing: positioning line, "Start a room" (→ `/start`), "Join with code" input (→ `/join/:code`), three-step explainer. `/start`: signed-out → `AuthOverlay providers={['google','github']}`; signed-in → "Your rooms" (useQuery `rooms` in app scope, open first) + "New room". `/create`: name (1–60), creates via API, navigates to `/room/:roomId`. `/join/:code`: resolves code → room id → `/room/:roomId`; invalid → error state.

- [ ] **Step 1: Failing tests** `api.test.ts` (mock fetch + getAuthToken): `uses Bearer when token present`; `uses X-Guest-Token when anonymous`; `maps 409 body {code:'DUPLICATE'} to DomainError`; `network failure → UPSTREAM with retry message`.
- [ ] **Step 2:** FAIL → **Step 3:** implement api + pages → **Step 4:** PASS, `npx tsc --noEmit`, manual check in dev at 360/1440 (Playwright MCP screenshots).
- [ ] **Step 5:** Commit "feat: landing, sign-in, your rooms, create and join flows".

### Task 10: Room page — data, guest view, host console, queue, search, social

**Files:** Create `src/pages/(app)/room/[roomId].tsx`, `src/client/hooks.ts`, `src/components/room/*` (listed in File Structure); Test `src/client/hooks.test.ts`, `src/components/room/QueueList.test.tsx` (Vitest + @testing-library/react if scaffold supports jsdom; else test pure view-model helpers in `src/components/room/view-model.ts`).

**Interfaces — Consumes:** Tasks 2, 4, 7, 9. **Produces:**
```ts
export function useRoomData(roomId: string): { status: 'loading'|'ready'|'error'; room?: RoomState; playback?: PlaybackState; members: Member[]; upNext: QueueItem[]; nowPlaying?: QueueItem; history: QueueItem[]; myVotes: Set<string>; events: RoomEvent[]; reactions: Reaction[] }
export function useServerClock(): { now(): number }        // offset from /api/time, refreshed every 5 min
export function useActor(roomId: string): { status: 'loading'|'needs-join'|'joined'|'kicked'|'closed'; actor?: Actor; join(displayName: string): Promise<Result<void>> }
```
Room page wraps content in `<RecordScope roomId={roomScope(roomId)} schemas={schemas}>` (or the Task-1 fallback). Join gate: preview card (room name, host, participant count, requests open?) + "Continue with Google/GitHub" + "Join as guest" name field (hidden when `allowAnonymousGuests=false`). Host console (≥1024px): left column player + now playing + transport (play/pause/skip, volume slider local) ; center queue (Up next with drag + move-up/down buttons, pin, remove; Recently played); right column search panel; collapsible people/activity rail. Guest/mobile: sticky now-playing bar with estimated progress, bottom tabs Queue · Search · People; search as full-height sheet. Search: input with 400 ms debounce + submit, AbortController, skeletons, empty/error/quota/not-configured states, result cards (artwork, title, "by <channel>", duration, Add button → states adding/added/duplicate→"Vote instead"). Queue rows: artwork, title, channel, "added by", vote toggle with count, status chip; own items show remove. A "Mine" filter chip on the queue shows the viewer's own requests (spec's "Your requests" view). Reactions: emoji bar; floating reactions rendered from rows newer than mount time, disabled animation under reduced motion. Activity feed: last 30 events. Invite dialog: link, code, QR (`qrcode` → canvas), copy with confirmed toast, `navigator.share` when available. Settings dialog (host): name, requests on/off, allow anonymous, per-guest limit (1–10), kick from people list, close room (confirm). Banners: disconnected (useQuery status error), room closed/expired, kicked, provider not configured. `aria-live` region announces "‹title› added by ‹name›". All write buttons disabled while command in flight; errors → toast with server message.

- [ ] **Step 1: Failing tests:** view-model tests — `progress label clamps to duration`; `canRemove shows only own queued items for guests`; `addButtonState maps DUPLICATE → 'vote-instead'`; `announcement text for enqueue event`; `useServerClock offset applied` (mock fetch).
- [ ] **Step 2:** FAIL → **Step 3:** implement components → **Step 4:** PASS; `npx tsc --noEmit`; `npm run lint`.
- [ ] **Step 5:** Manual verify in two browsers (Playwright MCP, signed-in host + anonymous guest): join, add, vote, reorder, react; screenshots at 360/768/1440; keyboard-only pass through join → search → add → vote.
- [ ] **Step 6:** Commit "feat(room): live room, host console, guest view, search, queue, social".

### Task 11: Host player (YouTube IFrame) and playback wiring

**Files:** Create `src/providers/playback/types.ts`, `src/providers/playback/youtube-iframe.ts`, `src/components/room/HostPlayer.tsx`, `src/components/room/useController.ts`; Test `src/providers/playback/youtube-iframe.test.ts`, `src/components/room/useController.test.ts`.

**Interfaces — Produces:**
```ts
export interface PlaybackController { load(videoId: string, startSec?: number): Promise<void>; play(): void; pause(): void; stop(): void; setVolume(v: number): void; currentTime(): number; onEnded(h: () => void): () => void; onError(h: (code: number) => void): () => void; onPlaying(h: () => void): () => void; destroy(): void }
export function createYouTubeIframeController(container: HTMLElement, loader?: () => Promise<YTNamespace>): PlaybackController   // loads https://www.youtube.com/iframe_api once
export function useController(roomId: string, playback: PlaybackState | undefined, actor: Actor | undefined): { controllerId: string; isController: boolean; claim(takeover: boolean): Promise<void> }
```
Behaviour: controllerId = `crypto.randomUUID()` per tab (sessionStorage). Host tab auto-claims if free; renews every `RENEW_MS`; if `playback.controllerId` changes away → pause + destroy player, show "Playing on another device · Play here instead". Controller reacts to playback record: new `currentItemId` → `load(videoId)` + `play()`; if not PLAYING within 3 s → `blocked` command and "Tap to start" overlay (click → `play()` then `play` command). ENDED → `advance{reason:'ended', expectedRevision}` once per revision (local guard set). onError(code) → `advance{reason:'error', errorCode}`. Pause/play buttons send commands; the controller applies resulting state (remote host tabs work through records). Volume local only. On reload with state `playing` → show paused UI with "Resume" (no auto-continue claim). Player container ≥ 200×200, visible on host console, never `display:none`.

- [ ] **Step 1: Failing tests** (fake YT namespace): `ENDED event triggers onEnded once`; `error 150 surfaces code`; `load calls loadVideoById with startSeconds`; useController: `sends advance once per revision even if ENDED fires twice`; `stops player when controllerId changes`; `renews lease every 30s` (fake timers).
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** PASS.
- [ ] **Step 5:** Manual (key set): host plays 2 short tracks; let first end → second starts, guest metadata updates; pause/resume/skip from host phone tab while laptop tab plays; open second host tab → only one audio source; queue an unembeddable/removed video id via API test helper → marked unavailable and skipped.
- [ ] **Step 6:** Commit "feat(player): host-only YouTube IFrame player with lease and idempotent advance".

### Task 12: Cron — expiry and pruning

**Files:** Modify `src/cron.ts`; Create `src/server/maintenance.ts`; Test `src/server/maintenance.test.ts`.

**Interfaces — Produces:** `export async function expireIdleRooms(appTools: ActionTools, roomToolsFor: (roomId: string) => ActionTools, now: number): Promise<number>` (rooms `status=open` with `lastActivityAt < now - 24h` → `expired` in dir + room_state, playback idle); `export async function pruneRoom(tools: ActionTools, now: number): Promise<void>` (reactions > 60 s, events beyond newest 200, non-`active:` receipts > 1 h). Cron task `maintenance`, `intervalMinutes: 60`, using `buildCronContext` or `createRoomTools` with `OWNER_USER_ID` (verify `buildCronContext` signature in `deepspace/worker` d.ts).

- [ ] **Step 1: Failing tests** with memory tools: `expires only idle open rooms`; `prune keeps newest 200 events`; `prune keeps active: receipts`.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** PASS. **Step 5:** Commit "feat(cron): idle room expiry and pruning".

### Task 13: Multi-user E2E

**Files:** Create `tests/e2e/room-flow.spec.ts`, `tests/e2e/permissions.spec.ts`, `tests/e2e/responsive.spec.ts`; remove scaffold demo assertions that reference deleted pages (`tests/smoke.spec.ts`, `tests/collab.spec.ts` updated).

- [ ] **Step 1 (owner gate):** Owner creates ≥ 3 test accounts: `npx deepspace test accounts create --email <name>@deepspace.test --name "<Name>" --password-stdin`.
- [ ] **Step 2:** Write specs using `test, expect, users` from `deepspace/testing` (skip when < 3 accounts, like scaffold): **room-flow** — host creates room; guest A (signed in) and guest B (anonymous, new context without auth) join; presence shows 3; A and B add different tracks simultaneously via the API (search mocked by route interception in tests only) → both visible on all 3 pages without reload; B adds A's track → "Vote instead"; votes uniqueness; host reorders, pins, removes; host locks requests → guest Add disabled with explanation; refresh host → queue/history restored. **permissions** — guest token / guest JWT calling `skip`, `kick`, `reorder`, `updateSettings` → 403; kicked guest → KICKED screen; anonymous join blocked when disabled. **responsive** — screenshots + no horizontal scroll at 360/768/1440; axe-free keyboard tab order through dialogs (focus trapped, Escape closes).
- [ ] **Step 3:** `npx deepspace test run all` → PASS (record output). Real-playback steps stay in the manual checklist (autoplay can't be asserted headlessly).
- [ ] **Step 4:** Commit "test: multi-user E2E for room flow, permissions, responsiveness".

### Task 14: Docs, final verification, deploy

**Files:** Create `README.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` (append to Task-1 findings).

- [ ] **Step 1:** README: what it is, screenshots, setup (Node/npm, `auth login`, `secrets set YOUTUBE_API_KEY` / `GUEST_TOKEN_SECRET`, `dev start`), commands, testing (accounts), deploy, provider limitations (quota ≈ 100 searches/day default, embeddability, autoplay, region blocks), known limitations (best-effort per-isolate rate limits, anonymous rejoin after kick, unguessable-link privacy if fallback taken). ARCHITECTURE: scopes, collections, command flow diagram, claims pattern, playback state machine, controller lease, Phase-2 seams (`NextTrackSelector`, `PlaybackController`). DECISIONS: all owner decisions table from design doc + builder calls + platform findings.
- [ ] **Step 2:** Run `npx tsc --noEmit`, `npm run lint`, `npx vitest run`, `npm run build`, `npx deepspace test run all`; all must pass; paste summaries into the final report.
- [ ] **Step 3:** Invoke `superpowers:requesting-code-review` and `security-review`; fix findings.
- [ ] **Step 4 (owner approval):** Ask owner to approve deploy and app name (`crowdpilot` if available). Commit, push `main` to GitHub, `npx deepspace deploy` (GitHub remote selected → GitHub authority). Expect `serving: confirmed`.
- [ ] **Step 5:** Verify live: open `https://<name>.app.space`, run manual acceptance list (spec §10) with two browsers; `npx deepspace logs --json` shows no exceptions. Record what was and wasn't verified in README.
- [ ] **Step 6:** Commit and push docs updates.
