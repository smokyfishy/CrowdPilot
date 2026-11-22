# CrowdPilot architecture (Phase 1)

CrowdPilot is a DeepSpace app: a Vite + React 19 client and a Hono worker on Cloudflare Workers, with DeepSpace RecordRoom Durable Objects as the only database and realtime layer.

## Scopes and data

| Scope | Durable Object | Collections | Who reads |
|---|---|---|---|
| `app:<APP_ID>` | one per app | `users`, `settings`, `rooms` (directory, `recordId = roomId`) | `rooms`: only the host's own rows (`ownerField: hostUserId`, read `'own'`) |
| `room:<roomId>` | one per room | `room_state`, `playback` (singletons, id `state`), `room_members`, `queue_items`, `votes`, `room_events`, `reactions`, `command_receipts` | anyone holding the unguessable room id (anonymous sockets included); `command_receipts` readable by nobody |

Every collection grants `create/update/delete: false` to every client role (`src/schemas/columns.ts` `readOnly`). Clients only read, with `useQuery`, inside `<RecordScope roomId="room:<id>">`. Per-room scopes mean no broad cross-room read exists.

Client scopes register disjoint schema lists (`appSchemas` / `roomSchemas` in `src/schemas.ts`) so collection names never collide in the SDK's scope registry; every DO registers all schemas.

## Write path

```
browser ──POST /api/rooms/:roomId/commands { type, ... }──▶ worker (src/server/room-routes.ts)
   │  Authorization: Bearer <DeepSpace JWT>   or   X-Guest-Token: <HMAC token>
   ▼
parseCommand (zod, strips unknown keys) ─▶ resolveActor (src/server/actor.ts)
   │      JWT → member with identityKey user:<userId>
   │      guest token (HMAC-SHA256, bound to roomId, 7-day exp) → memberId
   ▼
executeCommand (src/server/commands.ts)
   │  reload member (kicked → 403), room open check
   │  pure rules from src/domain (rules.ts, playback.ts, queue.ts)
   │  claims in command_receipts (uniqueOn key) to serialize races
   ▼
createRoomTools(env, "room:<id>") ── worker-internal fetch, X-App-Action: true ──▶ RecordRoom DO
                                                                         │ broadcasts changes
browsers ◀────────────────────── useQuery live updates ─────────────────┘
```

Other routes: `POST /api/rooms` (create; JWT), `GET /api/rooms/by-code/:code`, `GET /api/rooms/:id/preview`, `POST /api/rooms/:id/join` (JWT or anonymous → guest token), `GET /api/rooms/:id/me`, `GET /api/catalog/search` (members only), `GET /api/time` (server clock for progress estimates).

## Concurrency without transactions

DeepSpace documents no multi-record transaction or compare-and-set. The one atomic guard is schema `uniqueOn`, enforced inside the DO on every write. CrowdPilot uses it as a lock: creating a `command_receipts` row with a given `key` succeeds for exactly one caller (rows are created **without** an explicit recordId, because `create(…, recordId)` upserts).

| Race | Claim key | Outcome |
|---|---|---|
| Two ENDED events / skip racing ENDED | `playback:<playbackRevision>` | one advance; the loser is a no-op |
| Same song added by two guests | `active:<trackKey>` (released when the item leaves the queue) | one item; the other gets `DUPLICATE` + `existingItemId` |
| Retried request | `idem:<memberId>:<idempotencyKey>` | same item id returned |
| Two hosts reordering | `queue:<queueRevision>` | first wins; the other gets `STALE_REVISION` |
| Two enqueues allocating a slot | `uniqueOn ['enqueueSeq']` on `queue_items` | retry with the next seq |

Receipts other than `active:` are pruned hourly.

## Playback state machine

`src/domain/playback.ts` (pure, unit-tested). Item lifecycle: `queued → playing → played | skipped | unavailable | removed`. Every playback change requires `expectedRevision === playbackRevision` and bumps the revision.

- `ended` and `error` are accepted only from the **controller**: the host tab holding a live lease (`controllerId`, `controllerLeaseUntil`, 90 s, renewed every 30 s). Other host tabs show "Play here instead" (takeover).
- `skip`, `play`, `pause` are host-only, from any host tab.
- YouTube error codes 2/5/100/101/150 mark the item `unavailable` with a readable reason and move on; 3 consecutive failures stop with an error state, so a queue of broken videos never loops.
- Progress is never written every second: guests derive it from `startedAt` / `pausedAtSec` plus a server-clock offset.
- If the queue runs dry and a host device holds the lease, the next request starts playing automatically.

The host's player is `src/components/room/HostPlayer.tsx` → `HostPlaybackAgent` (`host-agent.ts`), which loads the current item at the estimated position, reports ENDED/errors once per revision, and reports `blocked` when autoplay doesn't start within 3.5 s (the UI then shows "Tap to start the music", a real user gesture).

## Provider boundary

- Catalog: `src/providers/catalog` — `MusicCatalogProvider.search()` returns normalized `CatalogTrack`s with namespaced `trackKey` (`youtube:<id>`). YouTube search runs only in the worker with `YOUTUBE_API_KEY`; results are cached 60 s per query and rate limited per member.
- Playback: `src/providers/playback` — `PlaybackController` interface, implemented by the official IFrame Player API adapter. The player is always visible (≥ 200 px, native controls and branding).

## Phase 2 (AI DJ) seams

Nothing DJ-related is implemented. The intended integration points:

1. `NextTrackSelector` (`src/domain/playback.ts`) — Phase 1 ships `fifoSelector`; a MixGraph selector can choose the next item without changing commands or schemas.
2. `PlaybackController` (`src/providers/playback/types.ts`) — a future controller can own transitions on the host device.
3. `MusicCatalogProvider` — add providers (e.g. Audius) by widening `TrackSource`.

## Housekeeping

`src/cron.ts` runs `maintenance` hourly: rooms idle for 24 h become `expired` (playback stops, join page says the room ended), events are capped at 200 per room, reactions older than a minute and stale receipts are removed.
