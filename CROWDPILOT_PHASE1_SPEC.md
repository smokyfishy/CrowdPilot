# CrowdPilot — Phase 1 Product & Technical Specification

**Status:** Implementation brief for Claude Code  
**Target platform:** DeepSpace SDK, Vite + React + TypeScript, Cloudflare Workers/Durable Objects; deploy to `<app-name>.app.space`  
**Primary deliverable:** A polished, functional, multiplayer music-room application.  
**Explicitly excluded:** AI DJ, MixGraph, GNNs, FFT/STFT, beatmatching, pitch shifting, crossfades, custom audio DSP, recommendation optimization, paid subscriptions.

## 1. Product definition

CrowdPilot lets a host create a private listening room, share a link/QR code, and let guests search for available songs, submit them to a shared queue, react/vote, and collectively experience a DJ-free social listening session. The host owns actual playback through a single provider-approved player. Every participant sees a synchronized now-playing view and queue. The UI should convey the energy of a music-focused social experience while remaining usable on a phone at a party.

**Product principle:** Real multiplayer state and end-to-end functionality matter more than elaborate static mockups. No inert interactions masquerading as finished features.

**Distinction from DJ phase:** Phase 1 is a conventional sequential player and collaborative queue. The codebase should have clean interfaces for future MixGraph integration without implementing or pretending to implement any automatic transitions now.

## 2. Prioritized clarification decisions (Claude must ask before implementation)

Ask the product owner a concise batch of questions and wait for answers before making consequential architecture/design choices:

1. Should the primary free, mainstream song catalog be **YouTube Search + official visible embedded YouTube player**, or should the app favor **Audius** for a more audio-native experience with a narrower catalog? Recommend YouTube for breadth, with Audius as fallback only if user approves.
2. Is a **YouTube Data API v3 key** already available? If not, should we configure the real integration and offer a permitted Audius or demo fallback while awaiting credentials? Do not ask for API keys in chat; give instructions for storing them securely.
3. Can guests **join anonymously with a display name**, or must all room participants sign in to DeepSpace? Recommend authenticated host and low-friction guest access only when securely supported by DeepSpace and approved by the user.
4. Does only the **host's device output audio**, while guests see synchronized metadata and controls, or is remote guest audio required? Recommend host-only playback for Phase 1.
5. Should voting affect queue order or be **social feedback only**? Recommend stable FIFO queue by default, host manual reorder/pin and explicit queue modes later; no implicit AI reorder in this phase.
6. Which host moderation controls are required now: skip, pause/play, remove, drag-reorder, pin next, lock queue, limit requests, allow/disallow explicit songs? Recommend the basic subset.
7. What visual direction is preferred: sleek dark Spotify-adjacent but original, more playful neon/social, or high-end minimalist? Recommend original dark, purple/teal accents, high contrast.
8. Are scheduled host time slots required in Phase 1? Recommend deferring hard timed scheduling, while planning compatible data fields for Phase 2.

If operating in a truly noninteractive environment, write assumptions into `docs/ASSUMPTIONS.md` and continue only with reversible implementation decisions. **In interactive Claude Code, ask and wait.** Never re-ask answers already provided.

## 3. Product flows

### 3.1 Host creates a room
- Signed-in host selects **Create Room**.
- Supply room name, optional description, optional cover accent, controls for guest adding and queue visibility.
- Generate unique unguessable room ID; optional short join code and copyable link. Optionally generate QR code client-side.
- Host lands on DJ-free **Host Console** with now playing, queue, participant count, discovery search, and moderation controls.
- Show state when provider isn't configured and guide through setup, rather than silently using a fake player.

### 3.2 Guest joins a room
- Link `.../room/:roomId` opens room landing/join.
- Ask for display name or authenticated join according to decision above.
- Show who is hosting, number of participants, and whether requests are open.
- Validate expired/closed rooms and duplicate display names appropriately.
- Guest opens responsive room view with now playing, song discovery, queue, and activity.

### 3.3 Search and queue music
- Debounced song search with loading, empty, error, quota, and playback-unavailable states.
- Show thumbnail, video/track title, source/channel/artist where reliable, duration when known, source provider, and Add button.
- Never imply third-party metadata definitively provides a canonical artist when it only provides a video channel.
- For the default mainstream route: use YouTube Data API search server-side, `type=video`, `videoEmbeddable=true`; optionally `videos.list` for contentDetails/status; real eligibility must also be checked on playback. Never scrape/download YouTube content.
- Guests add one selectable result to the room queue via a server-validated write. Show instant visible success with requester's display name.
- If request is a duplicate, follow clarified policy: reject with option to vote for existing item, or allow duplicates when explicitly enabled.
- Rate-limit requests; sanitize text; prevent abusive repeated queries.

### 3.4 Collaborative queue
- Shared ordered list persists and updates live for all users. The sort order is **authoritative on the server**, not browser timestamps alone.
- Each entry has cover/thumbnail, display title, provider, requester, vote count, status, optional host pin.
- Host can remove requests, skip, move or pin items as approved. Guests can remove only their own uncommitted entries if enabled.
- Optional per-user upvote with one-vote-per-user uniqueness; clarify whether votes have ordering impact. Default: feedback only.
- Show who added a track and a subtle activity feed for new joins/additions/playback changes.
- Keep **Currently Playing**, **Up Next**, and **Recently Played** distinct. History survives refresh.
- Empty state encourages adding first track, with a clear path to search.

### 3.5 Playback (no DJ features)
- Exactly **one host-authoritative player** outputs audio. Guest views never create a second player; they display the now-playing metadata and an estimated progress indicator only.
- If YouTube provider: use the official YouTube IFrame Player API with the player **visible and policy-compliant**, not as hidden/audio-only playback. Preserve platform branding and controls; never extract audio, apply EQ, crossfade/overlap videos, modify provider streams, or bypass restrictions.
- Host may Play, Pause, Resume, Skip, and adjust local player volume through allowed provider methods. Never claim to guarantee autoplay; require user gesture if needed.
- On official player END event, advance to the next queued track. Do not blindly advance if playback was blocked, errored, or a stale event arrived.
- Queue item lifecycle: `queued -> committed -> playing -> played` (plus `removed`, `unavailable`, `skipped` as needed). Publish state changes durably.
- Use optimistic UI only where appropriate and reconcile server rejections; avoid duplicate transitions or a skip from two overlapping events.
- On reload, restore server queue/current track metadata; host may need to manually resume due to autoplay/provider policy. Do not claim precise audio continuation if it cannot be restored.
- Keep server `playbackStartedAt`, `updatedAt`, `currentItemId`, `state`, and a monotonically increasing playback revision. Progress is derived from authoritative state and corrected periodically; avoid writing time every second to DeepSpace.
- Handle unavailable/deleted/region-blocked videos: show actionable reason, offer next eligible track / skip, do not loop indefinitely.

### 3.6 Social crowd experience
- Live presence and participant avatars/initials; participants' room membership persists while live presence expires naturally.
- Simple emoji reactions (rate-limited) and optional short room chat, if selected by owner. Keep core queue more important than chat.
- 'Your requests' view and queue activity notifications/toasts.
- QR/share sheet, copy invite link, invite modal, room privacy/basics.
- Host toggles guest submissions on/off; guest UI explains disabled state.
- Accessible touch interactions, reduced motion preference, readable contrast.

## 4. Visual / UX system

### UI qualities
Original music-product design, **not a pixel clone** of Spotify. Deep charcoal/near-black background; violet/teal or cyan accents; large expressive track artwork; rounded cards; restrained gradients; clear typographic hierarchy; excellent empty states and motion with reduced-motion support.

### Navigation / primary screens
1. **Landing**: positioning, Create Room, Join Room, demo explanation.
2. **Auth / profile**: sign-in + optional guest name mode as chosen.
3. **Room setup**: name, privacy, guest permissions, create.
4. **Join room**: room preview, validation, enter name/sign in.
5. **Room / mobile**: now playing card, Add Song search, Queue, People/Activity, reactions.
6. **Host Console / desktop**: fixed now-playing/player area, search panel, shared queue, participant sidebar, moderation controls.
7. **Search overlay / drawer**: debounced results, source badge, request status.
8. **Room settings / invite**: join code, QR, copy link, lock queue, room close.
9. **Error states**: provider not configured, room invalid, expired link, API quota, playback blocked, disconnected.

### Responsiveness
- Mobile-first guest UX at 360px width; sticky now-playing/footer navigation and a full-height search drawer.
- Host desktop at 1280px+ with a clear multi-column layout; at narrow widths panels stack and preserve controls.
- Keyboard-operable, accessible labels, focus management for dialogs, skeletons for loading, descriptive error messages, screen-reader announcements for queue changes where reasonable.

## 5. Free music APIs / provider abstraction

### Recommended: YouTube Data API v3 + YouTube IFrame Player API
- Broad searchable collection of official audio/music videos, subject to availability and embeddability.
- Server-side `search.list`, `videos.list` when needed. Store `YOUTUBE_API_KEY` only in secure DeepSpace secrets, not frontend source. Minimize quotas with explicit submit or debounce, request cancellation, limited results, legitimate caching, and no search on every keypress.
- A Data API search result is *not* a downloadable audio file or guaranteed playback entitlement.
- Use the **visible official embedded player**. It is a queueable video, not hidden background audio or a Spotify-streaming substitute.
- Comply with YouTube branding, minimum player sizing, autoplay limitations, developer policies, and restrictions on modifying/separating media.
- API access is quota-limited; make quotas observable in errors, never promise that all tracks are embeddable.

### Alternative: Audius public API / JS SDK
- Offers track search and streaming for eligible artist-uploaded content; free tier exists. Catalog is not equivalent to Spotify/YouTube's mainstream breadth.
- Implement as a separate provider when approved. Confirm authentication, restrictions, playback eligibility, rate limits, and CORS with current docs.
- Provider interface must normalize track IDs with a namespaced key (`youtube:VIDEO_ID`, `audius:TRACK_ID`).

### Provider TypeScript contract (conceptual)
```ts
type TrackSource = 'youtube' | 'audius';

type CatalogTrack = {
  source: TrackSource;
  sourceId: string;
  title: string;
  creatorLabel?: string;
  thumbnailUrl?: string;
  durationMs?: number;
  canonicalUrl?: string;
  playable: boolean | 'unknown';
};

interface MusicCatalogProvider {
  search(query: string, signal?: AbortSignal): Promise<CatalogTrack[]>;
  resolve(sourceId: string): Promise<CatalogTrack>;
}

interface PlaybackController {
  load(track: CatalogTrack): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  onEnded(handler: () => void): () => void;
  onError(handler: (error: Error) => void): () => void;
}
```
Implement the active provider in a policy-compliant way; do not force all providers into raw audio elements if the provider requires its own embedded player.

## 6. DeepSpace architecture

Use the **official DeepSpace skill** and the latest [docs.deep.space](https://docs.deep.space/) documentation as source of truth. Scaffold `npm create deepspace@latest crowdpilot`; build with React + TS, Tailwind v4 and existing shadcn-style primitives, Hono worker. Use `RecordProvider`, `useAuth`, `useQuery`, `useMutations`, `usePresenceRoom`, verified server actions, and DeepSpace deploy. Do not invent SDK exports: consult docs, inspect generated scaffold and versions.

**Data authority:** DeepSpace records are authoritative for rooms, memberships, queue order, votes, host settings, playback state, and history. Presence is ephemeral and never used for durable membership. Store secrets server side. Ensure room-level privacy using server-enforced checks; client-side query filters do not constitute access control.

**Server-only writes requiring checks:** Create/join/close rooms; enqueue; deduplicate; vote; host moderation, reordering, pinning, skipping, starting/pausing; compare revisions; progression on ended events. Privileged server actions must validate actual authenticated user and room membership/role.

**Concurrency:** Use server-assigned monotonic `enqueueSeq`, versioned queue and playback revisions, idempotency keys for commands/event processing, and preferably a serialized per-room coordinator or documented atomic write mechanism for operations involving multiple records. Avoid stale client event triggering duplicate next-track advances.

**Realtime:** `useQuery` for records, `usePresenceRoom(roomId)` for online participant count and optional transient UI, separate room-level UI scopes. Confirm package APIs from docs. Avoid a new database or custom Socket.IO server when DeepSpace already supplies realtime sync.

## 7. Data model (logical; adapt to confirmed DeepSpace schemas)

### `rooms`
`id`, `code`, `hostUserId`, `name`, `description?`, `status` (`open|paused|closed`), `guestRequestsEnabled`, `duplicatePolicy`, `queueRevision`, `playbackRevision`, `createdAt`, `updatedAt`.

### `room_members`
`id`, `roomId`, `userId` (or approved guest identity), `displayName`, `role` (`host|guest`), `joinedAt`, `lastSeenAt?`. Unique room + identity.

### `catalog_tracks` (optional metadata cache)
`id` = provider-namespaced ID, `source`, `sourceId`, `title`, `creatorLabel`, `thumbnailUrl`, `durationMs?`, `canonicalUrl?`, `lastCheckedAt?`, `playableStatus`.

### `queue_items`
`id`, `roomId`, `trackId`, `requestedByMemberId`, `enqueueSeq`, `positionKey?`, `status` (`queued|committed|playing|played|skipped|removed|unavailable`), `isPinned`, `pinnedPosition?`, `createdAt`, `updatedAt`.

### `votes`
`id`, `roomId`, `queueItemId`, `memberId`, `createdAt`; uniqueness of `(queueItemId, memberId)` enforced server-side.

### `playback_states`
`roomId`, `currentQueueItemId?`, `nextQueueItemId?`, `state` (`idle|loading|playing|paused|blocked|error`), `startedAt?`, `positionSec?`, `playbackRevision`, `hostControllerId?`, `updatedAt`.

### `room_events`
`id`, `roomId`, `actorMemberId?`, `type`, `queueItemId?`, `payload`, `createdAt`; activity/history with bounded retention.

### Optional `reactions`
`id`, `roomId`, `memberId`, `emoji`, `createdAt`; rate-limited and TTL/cleanup strategy.

IDs, timestamps, uniqueness mechanisms, storage limits, and permission field shapes must follow verified DeepSpace APIs; these are logical contracts, not guaranteed drop-in SDK definitions.

## 8. State machine and invariants

- Only one current item per room.
- Only one authorized host/controller may issue playback-changing commands.
- `enqueueSeq` allocated by trusted server, never by client clocks.
- Each queue item is played at most once unless host explicitly requeues it as a new request.
- Advance once per `(roomId, playbackRevision, ended)` event; reject stale or duplicate events.
- Never remove or reorder a committed/playing item without explicit host override.
- Host-only actions must be enforced server-side, not just by hiding UI controls.
- Provider failure does not silently mark a song as played.
- Guests see queue and approximate progress; the host has the actual player.
- Room data must not leak across private rooms through broad collection reads.

## 9. Explicit out of scope

No DJ mixing/crossfading, BPM/FFT analysis, auto-transition intelligence, GNN/MixGraph, AI song recommendation, dynamic queue reshuffling, voice agent, monetization, streaming remote synchronized audio to every guest, scraping/downloads, or recording copyrighted media. Maintain modular boundaries for future Phase 2 without speculative implementations.

## 10. Testing and acceptance criteria

### Automated
- Unit: queue order, unique enqueues, status transitions, duplicate rejection policy, host permissions, vote uniqueness, next-track selection, revision/idempotency rules.
- Integration: search provider normalization, API errors/rate limiting, YouTube player event adapter (mock events), live record subscriptions.
- Multi-user Playwright using `deepspace/testing` where applicable: host + two guest accounts on same room, simultaneous adds, voting, host skip/lock/remove, unauthorized guest skip, refresh persistence, reconnects.
- Accessibility: keyboard navigation, dialogs, contrast, labels, responsive at 360/768/1440 widths.

### Manual acceptance
1. Host signs in, creates room, shares valid link/QR.
2. Two guest browsers join and appear in live presence.
3. A guest searches a real catalog, adds a playable result; all clients see it without refresh.
4. Another guest adds a second track, votes, or attempts duplicate; server policy is enforced.
5. Host starts official visible player (after user interaction as required), pauses, resumes, skips.
6. When a video ends, next queue item begins on host device and all guests' now-playing metadata updates.
7. Host can moderate queue; guest cannot invoke host-only operations by API call.
8. Room reconnect restores queue/history and handles playback recovery honestly.
9. Error states are real: no API key, quota exhausted, unavailable video, blocked autoplay, failed auth, network disconnection, empty queue.
10. Deploy succeeds to `.app.space`; README documents setup, secrets, commands, provider limitations, and future DJ boundary.

## 11. Implementation sequence

**Step 0:** Ask clarifying questions, confirm APIs and scope, inspect docs and scaffold.  
**Step 1:** Establish routing, auth, brand design system, room creation/join, durable schema and permissions.  
**Step 2:** Build provider-backed search + results + add queue, no fake catalog results.  
**Step 3:** Build real-time queue, votes, presence, host moderation, and activity.  
**Step 4:** Build host-only provider-approved player and deterministic playback state machine.  
**Step 5:** Polish mobile/desktop responsiveness and every empty/error/loading state.  
**Step 6:** Automated multi-user tests, security checks, build, deployment, verify live app.

## 12. Documentation references

- DeepSpace skill: https://github.com/deepdotspace/deepspace-skill
- DeepSpace main documentation: https://docs.deep.space/
- Quickstart: https://docs.deep.space/get-started/quickstart
- Data storage: https://docs.deep.space/guides/data-storage
- Permissions: https://docs.deep.space/concepts/permissions
- Server actions: https://docs.deep.space/guides/server-actions
- Presence: https://docs.deep.space/guides/presence-and-cursors
- YouTube Search API: https://developers.google.com/youtube/v3/docs/search/list
- YouTube IFrame API: https://developers.google.com/youtube/iframe_api_reference
- YouTube developer policy: https://developers.google.com/youtube/terms/developer-policies-guide
- Audius SDK: https://docs.audius.co/sdk/

## 13. Deliverables

1. Functional repo with clean, comprehensible source code.
2. Complete UI/UX for desktop host and mobile guest, backed by real DeepSpace state.
3. Configurable working music catalog/playback integration, with honest limitations and graceful no-key fallback.
4. Security checks and multi-user tests.
5. README: architecture, setup and `.app.space` deployment instructions.
6. `docs/DECISIONS.md`: clarified choices, tradeoffs, provider behavior and future DJ integration points.
7. Publicly reachable deployed app **only after owner approves any external actions/account changes**; if credentials are unavailable, provide exact setup/deploy commands and document what remains unverified.
