# Deployment and fallbacks

## Deploy

```bash
cd C:\dev\CrowdPilot          # phase2 branch
npm run type-check && npm run lint && npx vitest run -c vitest.pure.config.ts
npx deepspace test run all    # smoke + API + all E2E, including real-audio DJ tests (needs network)
npx deepspace deploy          # GitHub-latched: ships the current checkout → https://crowdpilot.app.space
npx deepspace releases        # rollback target for Phase 1: rel_01M80X7E9SKQ6070B0HKPBEBW3
```

Secrets (server-side only):

- `YOUTUBE_API_KEY` and `GUEST_TOKEN_SECRET` (Phase 1)
- `JAMENDO_CLIENT_ID` and `JAMENDO_CLIENT_SECRET` (Phase 2; the secret is stored but not needed by the read-only API)

Production check without a local server: `cd tests && npx playwright test -c playwright.prod.config.ts`. It runs the real-audio DJ Lab test against the live site.

## Fallbacks (nothing here can stop the music)

| Failure | Behaviour |
|---|---|
| Next item is YouTube-only | Standard playback, labelled; the track plays to its end. |
| Audio fetch or decode fails | `advance(error 901/902)` → item marked "Couldn't play" with the reason → next song. Three in a row → stop with an error (Phase 1 rule). |
| Analysis fails or is low-confidence | No beat-matched styles; cut or quick fade, or standard playback. |
| Plan fails the safety gate | Not scheduled; `safe_fallback`; the track plays out. |
| Queue changed after commit | `djStatus` rejected as `STALE_REVISION` → transition cancelled before it becomes audible → replanned. |
| Handoff target left the queue | The server falls back to the normal next song. |
| Host tab reload / takeover | Phase 1 lease rules; the new controller reloads at the estimated position (no mix in flight). |
| Browser autoplay block | "Tap to start the music" on both the YouTube and DJ outputs. |
| Unexpected silence over 6 s | Status `failed` with a note; the next end or error advances normally. |
| Clipping risk | Headroom-aware trim, then the limiter, then the safety shaper (output can never exceed full scale). |

## 2026-11-23 — professional DJ planner (release #14)

- **Release:** `rel_01M83ZBQDK3F4YPXNB006BF50R` (#14), deployed 2026-11-23 10:31 UTC from GitHub `smokyfishy/CrowdPilot`, branch `feat/pro-dj-closed-loop`.
- **What changed:** global set planning, long-form staged performances and closed-loop evaluation are now the default planner (`planner: 'global'`). See docs/PRO_DJ_REPORT.md.
- **Rollback target:** `rel_01M83G2M4N0YRY8Z090XJ0DYT4` (#13, the previous production build). Roll back with `npx deepspace rollback`.
- **Code-level fallback:** `runPipeline(..., { planner: 'legacy' })` restores the previous beam order, cue DP and DJCritic path without a redeploy of other code.
- **Checks run before deploy:**
  - type-check, lint;
  - pure unit tests (172), ML and DSP tests (45);
  - smoke and API (8);
  - browser end-to-end on the local dev server (4-track real-audio generation);
  - real-audio Node end-to-end (12 tracks, all `validateMix` checks pass);
  - held-out controlled comparison.
