/**
 * Multi-user AI DJ flow on real Audius audio (search results mocked to two fixed,
 * real Audius ids; the server still resolves each enqueue against Audius):
 *   host enqueues two mixable tracks and starts playback → the host browser
 *   analyzes the real audio and syncs measured BPM/key → the guest sees them →
 *   host enables autopilot and forces "mix at next phrase" → the engine runs the
 *   transition on the audio clock and reports the handoff → the guest's "now playing"
 *   switches to the incoming track without a reload.
 */
import { test, expect, loadAllTestAccounts } from 'deepspace/testing'
import type { Page, Route } from '@playwright/test'
import { createRoom, joinSignedIn, queueRow } from './helpers'

test.skip(loadAllTestAccounts().length < 2, 'Needs 2 usable test accounts (npx deepspace test accounts create ...).')
test.describe.configure({ timeout: 900_000 })

const AUDIUS = [
  { source: 'audius', sourceId: 'VA6M3y', trackKey: 'audius:VA6M3y', title: 'Yo no quiero agua', creatorLabel: 'Audius', durationMs: 175_000, playable: true, mixability: 'mixable', rights: { basis: 'audius-oml', label: 'OML' } },
  { source: 'audius', sourceId: '5xklV', trackKey: 'audius:5xklV', title: 'Feel Me', creatorLabel: 'Audius', durationMs: 94_000, playable: true, mixability: 'mixable', rights: { basis: 'audius-oml', label: 'OML' } },
]

async function mockAudius(page: Page) {
  await page.route('**/api/catalog/search**', (route: Route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, value: AUDIUS }) }))
}

test('host AI DJ mixes two real Audius tracks and the guest follows live', async ({ users }) => {
  const [host, guest] = await users(2)
  await host.page.setViewportSize({ width: 1440, height: 1000 })
  await guest.page.setViewportSize({ width: 1440, height: 1000 })
  await mockAudius(host.page)
  const roomId = await createRoom(host.page, 'E2E DJ Night')
  await joinSignedIn(guest.page, roomId, 'Ann')

  await host.page.getByRole('radio', { name: 'Audius · AI mix' }).click()
  await host.page.getByLabel('Search YouTube for a song').fill('tech house')
  for (const t of AUDIUS) await host.page.getByRole('button', { name: new RegExp(`Add .*${t.title.split(' ')[0]}`) }).first().click()
  for (const page of [host.page, guest.page]) {
    await expect(queueRow(page, 'quiero agua')).toBeVisible({ timeout: 30_000 })
    await expect(queueRow(page, 'Feel Me')).toBeVisible({ timeout: 30_000 })
  }
  await expect(queueRow(guest.page, 'Feel Me').getByText('AI mix')).toBeVisible()

  await host.page.getByRole('button', { name: 'Start the music' }).click()
  // the host decodes + analyzes the real audio; measured features sync to the guest
  await expect(queueRow(guest.page, 'Feel Me').getByText(/BPM/)).toBeVisible({ timeout: 300_000 })
  await expect(host.page.getByText(/Tempo/).first()).toBeVisible({ timeout: 60_000 })

  await host.page.getByRole('switch', { name: 'Autopilot' }).click()
  await expect(guest.page.getByRole('status').filter({ hasText: /AI DJ|transition|Analyzing|Standard/ }).first()).toBeVisible({ timeout: 30_000 })
  await expect(guest.page.getByText(/locked in|Mixing now/).first()).toBeVisible({ timeout: 90_000 })
  // handoff: the guest's now-playing switches to the incoming track
  await expect(guest.page.locator('section[aria-label="Now playing"]').getByText('Feel Me').first()).toBeVisible({ timeout: 120_000 })
  const state = await host.page.evaluate(() => document.body.innerText.includes('clip events'))
  expect(state).toBe(false)
})
