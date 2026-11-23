/**
 * Player-only check on an existing ready mix (no regeneration):
 *   MIX_ID=<id> DEEPSPACE_PORT=5194 npx playwright test -c playwright.config.ts e2e/mixgen-player.spec.ts
 * Verifies the stored audio loads, plays, seeks, and that tracklist/transition UI match the manifest.
 */
import { test, expect, loadAllTestAccounts } from 'deepspace/testing'

test.skip(!process.env.MIX_ID || loadAllTestAccounts().length < 1, 'Needs MIX_ID and a test account.')
test.describe.configure({ timeout: 5 * 60_000 })

test('stored mix plays, seeks and navigates', async ({ users }) => {
  const [u] = await users(1)
  const page = u.page
  await page.goto(`/mix/${process.env.MIX_ID}`)
  await expect(page.getByTestId('mix-play')).toBeVisible({ timeout: 60_000 })
  const state = () =>
    page.evaluate(() => {
      const a = document.querySelector('audio') as HTMLAudioElement | null
      return a ? { src: a.currentSrc.slice(0, 120), ready: a.readyState, net: a.networkState, err: a.error?.message ?? a.error?.code ?? null, dur: a.duration, t: a.currentTime, opus: a.canPlayType('audio/ogg; codecs=opus') } : null
    })
  await expect.poll(async () => (await state())?.ready ?? 0, { timeout: 120_000 }).toBeGreaterThanOrEqual(1)
  console.log('audio state', JSON.stringify(await state()))
  const performance = page.getByRole('region', { name: 'AI DJ performance' })
  await expect(performance).toBeVisible()
  await expect(page.getByRole('slider', { name: /Mix timeline/ })).toBeVisible()
  await page.getByTestId('mix-play').click()
  await expect.poll(async () => (await state())?.t ?? 0, { timeout: 60_000 }).toBeGreaterThan(1)
  await expect(performance.locator('[data-k$=".jog"][data-playing="1"]').first()).toBeVisible()
  await page.getByTestId('track-seek-5').click()
  await expect.poll(async () => (await state())?.t ?? 0, { timeout: 30_000 }).toBeGreaterThan(60)
  const t = (await state())!.t
  await page.waitForTimeout(1500)
  expect((await state())!.t).toBeGreaterThan(t) // keeps playing after the seek
  await expect(page.getByTestId('mix-time')).not.toHaveText(/^0:00 \//)
  await page.getByTitle('Transition into track 2').click()
  await expect(page.getByTestId('transition-inspector')).toContainText('Overlap')
  await page.setViewportSize({ width: 1280, height: 1400 })
  await page.locator('h1').first().scrollIntoViewIfNeeded()
  await page.evaluate(() => document.querySelectorAll('*').forEach((el) => { if (el.scrollTop > 0) el.scrollTop = 0 }))
  await page.screenshot({ path: 'test-results/mixgen-player-top.png' })
  console.log('after seek', JSON.stringify(await state()))
})
