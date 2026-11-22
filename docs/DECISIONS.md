# CrowdPilot decisions

## Owner decisions (2026-11-21)

| Topic | Decision |
|---|---|
| Music provider | YouTube Data API v3 search (server-side) + official visible YouTube IFrame player on the host device. Audius not in Phase 1. |
| Guest identity | Guests may sign in (Google/GitHub) **or** join anonymously with a display name. Hosts must sign in. Host can require sign-in per room. |
| Audio | Host device only. Guests see synced metadata and estimated progress. |
| Queue | FIFO by server-assigned `enqueueSeq`. Host can drag/keyboard reorder and pin "play next". Votes are social feedback only. Duplicates of a queued/playing song are rejected with "Vote instead". |
| Moderation | Play/pause/skip/remove, reorder, pin next, lock requests, per-guest limit (default 3, 1–10), kick guest, end room. |
| Visual direction | High-end minimalist, direction A "Liner Notes": warm graphite, bone text, amber accent, Instrument Serif titles + Inter Tight UI. Mockups: https://claude.ai/artifact/4i9MkRx9Y3AqKAxqxjbaUz |
| Social | Emoji reactions and an activity feed. No chat, no scheduling in Phase 1. |
| Architecture | All mutations go through server code; clients only read records. |
| Anonymous fallback | If anonymous writes had proved impossible: read-only guests with a sign-in prompt. (Not needed — see below.) |
| Multiple host devices | One active player with takeover. |
| Privacy | Unguessable room links are acceptable; rooms are isolated per scope anyway. |
| Room lifetime | Auto-expire after 24 h idle; hosts can own several rooms ("Your rooms"). |
| Git | GitHub `smokyfishy/CrowdPilot` is the source authority (never `deepspace push`). |

## Builder calls

- **One command route instead of server actions.** DeepSpace server actions reject unauthenticated callers (401). The scaffold's action tools are a worker-internal fetch to the RecordRoom DO with `X-App-Action: true`, so `src/server/room-tools.ts` builds the same tools for any scope. One route accepts a JWT or an HMAC guest token, so there is a single, tested authorization path.
- **Claims via `uniqueOn`** for every race (see ARCHITECTURE.md). Claim rows are created without a recordId because `create(collection, data, recordId)` upserts.
- **Role comes from the member record**, never from the request. Joining derives `host` only when `identityKey === user:<room.hostUserId>`.
- **Kick is a soft removal.** Signed-in kicked users can't rejoin; anonymous kicked guests lose their token but could rejoin under a new name — the host can then switch the room to sign-in only.
- **Guests remove their own queued songs** (not once playing). Removing the playing song (host) acts as a skip with status `removed`.
- **Auto-continue:** a new request restarts playback if the queue had run dry and a host device holds the lease.
- **Rate limits are per worker isolate** (token buckets: enqueue 5/min, reactions 1 per 2 s, search 20/min, code lookups 20/min per IP, anonymous joins 10/min per IP). Best effort, not global.
- **Room code is mirrored into `room_state`** so guests can share invites; the `rooms` directory stays host-only.
- **Exactly one room layout is mounted** (media query), so a host never mounts two YouTube players.
- **Testing without registration:** `vitest.pure.config.ts` runs the pure domain/server/provider/client tests without a registered `DEEPSPACE_APP_ID`; the scaffold's `vitest.config.ts` refuses to load until the app is registered.

## Provider behavior and limits

- YouTube search costs 100 quota units per `search.list` call (+1 for `videos.list`); the default 10,000 units/day allows roughly 100 uncached searches. Quota exhaustion shows "Search is resting for today".
- Search filters `videoEmbeddable=true` and drops `status.embeddable === false`, but real availability (region blocks, removed videos) is only known when the host's player tries it. Those songs are marked "Couldn't play" with the reason.
- Browsers may block autoplay; the host then sees "Tap to start the music". CrowdPilot never claims seamless continuation after a reload: the host resumes manually.
- The channel name is shown as "on <channel>", never as the artist.

## Platform findings

Verified from the installed SDK (0.44.2) types and scaffold source:

- `ActionTools.create(collection, data, recordId)` upserts when `recordId` is given.
- Anonymous sockets get the `viewer` role; `'*'` is the signed-out fallback.
- `uniqueOn` is a single composite constraint per collection.
- `useQuery` default limit is 50; CrowdPilot passes explicit limits.

**Verified at runtime (2026-11-21, local dev against real RecordRoom DOs, spike spec since removed):**

- (a) 8 guests adding the same song simultaneously → exactly 1 × 200 and 7 × 409 `DUPLICATE`. `uniqueOn` claims are atomic under concurrency.
- (b) 8 simultaneous distinct adds → all 200 with distinct `enqueueSeq`.
- (c) Rows written by worker tools into `room:<id>` appear live in the host's `RecordScope` without reload.
- (d) Anonymous guests appear in `usePresenceRoom` (each anonymous socket gets an `anon-<uuid>` id). Finding: the SDK's `updateState` silently drops updates sent before the socket opens, so CrowdPilot re-sends its `memberId` tag whenever presence (re)connects.
- The anonymous-join limiter (10/min per IP) tripped as designed when the spike first tried 12 joins.

**Live YouTube checks (local dev, real API key):**

- Search returned 12 normalized results for real queries; adding them queued correctly.
- From `http://localhost`, the official player loaded *Daft Punk – One More Time* and kept playing (no errors, lease renewed every 30 s).
- From `http://127.0.0.1` (the scaffold's Playwright base URL), YouTube refuses label-owned videos with error 150 while its own demo video plays — YouTube rejects embeds on bare-IP origins. CrowdPilot handled it as designed: both songs were marked "The owner does not allow this video to be embedded" and skipped without looping. Production (`*.app.space`) is a real hostname, so this does not apply there.
- Not verified live: auto-advance on a real ENDED event (covered by unit tests of the agent and state machine; check on the deployed app).
