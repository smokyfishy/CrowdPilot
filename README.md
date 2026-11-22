# CrowdPilot

A shared queue for the room you're in. A host starts a room and shares a code or QR; guests search YouTube, add songs, vote and react from their phones; the host's device plays everything through YouTube's official player. Everyone sees the same queue update live.

Built on [DeepSpace](https://docs.deep.space) (React + Cloudflare Workers + Durable Objects). Phase 1 is a conventional sequential player — no AI DJ features.

- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Decisions, provider limits, platform findings: [docs/DECISIONS.md](docs/DECISIONS.md)
- Design and plan: [docs/superpowers/](docs/superpowers/)

## Features

- Rooms with a 6-character code, link and QR invite; "Your rooms" list for hosts
- Guests join signed in (Google/GitHub) or anonymously with a name (host can require sign-in)
- YouTube search with loading, empty, quota and not-configured states
- Live FIFO queue: requester names, votes, duplicate protection ("Vote instead"), "Mine" filter, recently played
- Host controls: play/pause/skip, drag or keyboard reorder, pin "play next", remove, pause requests, per-guest limit, kick, end room
- One audio source: a single host tab holds the player lease; other devices can take over
- Unavailable videos are skipped with a reason; autoplay blocks show "Tap to start the music"
- Presence, emoji reactions, activity feed, screen-reader announcements, reduced-motion support
- Desktop host console and a mobile-first guest view with bottom tabs

## Setup

Requirements: Node 22.15+/24/26 and npm 11.6+.

```bash
npm install
npx deepspace auth login          # opens the browser (Google/GitHub); run in your own terminal
npx deepspace app init --json     # registers the app; commit the DEEPSPACE_APP_ID it writes to wrangler.toml
```

Secrets (never commit them, never put them in `.dev.vars` by hand):

```bash
npx deepspace secrets set YOUTUBE_API_KEY        # YouTube Data API v3 key (Google Cloud Console → enable "YouTube Data API v3")
npx deepspace secrets set GUEST_TOKEN_SECRET     # any long random string; enables anonymous guests
```

Run `npx deepspace secrets set --help` for the stdin form so values stay out of shell history. Without `YOUTUBE_API_KEY`, search shows a "not set up" state instead of fake results. Without `GUEST_TOKEN_SECRET`, guests must sign in.

Restrict the YouTube key to the YouTube Data API v3 in Google Cloud Console.

## Commands

```bash
npx deepspace dev start                          # local dev (vite + miniflare)
npx vitest run -c vitest.pure.config.ts          # domain/server/provider unit tests (no registration needed)
npm run test:unit                                # all unit tests (needs a registered app id)
npx deepspace test accounts create --email host@deepspace.test --name "Host" --password-stdin
npx deepspace test run all                       # smoke + API + multi-user E2E (tests/e2e)
npm run type-check && npm run lint && npm run build
```

## Deploy

GitHub is this app's source authority — never run `npx deepspace push`.

```bash
git push origin main
npx deepspace deploy        # → https://<name>.app.space
npx deepspace logs --follow --json
```

## Status of verification

| Area | Status |
|---|---|
| Domain rules, playback state machine, claims/concurrency (in-memory DO double), guest tokens, YouTube normalizer, IFrame adapter, host agent, client API, maintenance | 118 unit tests passing (14 files) |
| Type-check and lint | clean |
| Build, dev server, multi-browser E2E, live YouTube search/playback, deploy | **pending** — blocked on DeepSpace login/registration (the build refuses to run without a registered app id) |

## Known limitations

- Rate limits are per worker isolate (best effort).
- An anonymous guest who is kicked can rejoin under a new name unless the host switches the room to sign-in only.
- YouTube's default quota allows roughly 100 uncached searches per day.
- Room privacy relies on unguessable room ids (128-bit); codes are rate limited.
- Progress on guest devices is estimated from server timestamps, not sample-accurate.
