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

# Phase 2 — AI DJ (2026-11-22)

## Owner decisions

| Topic | Decision |
|---|---|
| Product | Fully web-based AI DJ on DeepSpace. No local music files, no Python install for users. |
| Discovery | YouTube Data API search stays (Phase 1). |
| Real mixing sources | **Audius** (public API, CORS-enabled MP3 streams, Open Music License) and **Jamendo** (CC tracks; `JAMENDO_CLIENT_ID` secret). YouTube embeds can never be mixed (no audio access; policies forbid modifying/caching audio). |
| Honest tiers | Every queue item shows **AI mix** (authorized waveform), **Standard playback** (YouTube embed) or **Couldn't play**. |
| Host control | Autopilot with preview + override; AI queue reordering **off by default**; position locks; timed slots; tempo change ≤ ±6 % (pitch-preserving); no key shifting. |
| Audio | Host speakers only; guests receive synchronized metadata. |
| Compute | CPU-only locally; ML training may use the owner's Azure credits (~$1,000), budgeted per run. |
| Repo / data | Repo at `C:\dev\CrowdPilot` (`phase2` branch; `phase1-release` tag = deployed Phase 1 baseline). Research data at `C:\crowdpilot-data` (never in git, never on DeepSpace storage). |
| Rights | Private noncommercial research is **not** a licence. Default-deny, per-use permissions; CC licences applied by a documented policy (docs/DATA_RIGHTS_AND_PROVENANCE.md); training on NC/ND material awaits the owner's review. |

## Builder calls

- **Analysis runs in the host browser** (TypeScript DSP in a Web Worker): multi-resolution STFT (1024/2048/4096 Hann), spectral-flux onsets, autocorrelation tempo with octave candidates, whole-track constant-grid fit (0.0002 BPM steps), kick-vs-hat phase resolution, downbeat from bar-synchronous change, Krumhansl–Kessler key + Camelot, Foote novelty phrases, BS.1770-4 loudness (ITU coefficients reproduced exactly), 4× true peak. Only a < 4 KB summary is synced to DeepSpace (`track_features`); audio never leaves the host device.
- **Tempo matching** uses a project-written WSOLA time-stretcher (pitch preserved, no GPL dependency). `playbackRate` is never used for tempo.
- **Engine safety:** plan validation gate (zero-length fades, ±6 %, gain/EQ bounds, monotone curves), headroom-aware loudness trim (never above −1 dBTP), DynamicsCompressor limiter + transparent-below-−1 dBFS safety shaper, silence watchdog. Automation is scheduled on the AudioContext clock; UI timers only *report* events.
- **Mix handoff** reuses Phase 1's `advance` command with two optional fields (`nextItemId`, `startPositionSec`): the room switches to the committed incoming item at its real position. A handoff to an item that left the queue falls back to normal FIFO.
- **YouTube → Audius matching** is metadata-only and conservative (verified uploader + artist + title + duration ±4 s, remix tags must agree), because third-party re-uploads of mainstream songs carry no valid OML grant. The host can reject a match.
- **Licence basis is stored per queue item** (server-resolved). Mixing of sources whose licence needs review (OML-only Audius uploads; Jamendo ND/unknown) is governed by a host toggle that defaults **on** and is clearly labelled "pending rights review".
- **Jamendo audio** goes through a host-only, allowlisted, non-caching pass-through (`/api/audio/jamendo/:id`) because Jamendo storage sends no CORS headers.
- **Schema changes are additive only** (new `dj_state`, `track_features`; optional queue fields `mixTrackKey`, `mixMatch`, `targetStartAt`, `locked`, `rights`), which DeepSpace migrates automatically.
- **Deploy:** `phase2` checkout deployed to `crowdpilot.app.space` (rollback target: Phase 1 release `rel_01M80X7E9SKQ6070B0HKPBEBW3`).
