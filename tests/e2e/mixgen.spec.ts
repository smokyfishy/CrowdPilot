/**
 * Browser end-to-end: prompt → LLM interpretation → discovery → policy-checked audio
 * acquisition → in-browser analysis (Beat This!) → selection review → render worker →
 * private upload → player (waveform from the render, playback, seeking, track navigation,
 * transition inspection). Uses REAL providers and audio; long-running by design.
 *   DEEPSPACE_PORT=5192 npx playwright test -c tests/playwright.config.ts tests/e2e/mixgen.spec.ts
 * MIXGEN_E2E_PROMPT overrides the prompt (default: the acceptance prompt).
 */
import { test, expect, loadAllTestAccounts } from 'deepspace/testing'

test.skip(loadAllTestAccounts().length < 1, 'Needs 1 usable test account.')
test.describe.configure({ timeout: 45 * 60_000 })

const PROMPT = process.env.MIXGEN_E2E_PROMPT ?? 'Generate a 40-minute tech house mix with 12 tracks, a gradual energy build, strong basslines, and smooth transitions.'

test('describe → generate → listen: a real continuous mix in the browser', async ({ users }) => {
  const [u] = await users(1)
  const page = u.page
  const logs: string[] = []
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && logs.push(`${m.type()}: ${m.text()}`))
  await page.goto('/mix')
  await page.getByTestId('mix-prompt').fill(PROMPT)
  await page.getByTestId('mix-interpret').click()
  const interp = page.getByTestId('mix-interpretation')
  await expect(interp).toBeVisible({ timeout: 90_000 })
  await expect(interp.getByLabel('Songs')).toHaveValue('12')
  await expect(interp.getByLabel('Minutes')).toHaveValue('40')
  await page.getByTestId('mix-start').click()
  await page.waitForURL(/\/mix\/[0-9a-f-]{36}$/, { timeout: 30_000 })
  await expect(page.getByTestId('mix-progress')).toBeVisible()

  // Review step: real selection with acquisition status.
  const sel = page.getByTestId('mix-selection')
  await expect(sel).toBeVisible({ timeout: 30 * 60_000 })
  await expect(sel.locator('li')).toHaveCount(12)
  await page.getByTestId('mix-render').click()

  // Player: waveform canvas, tracklist, timeline.
  await expect(page.getByTestId('mix-play')).toBeVisible({ timeout: 20 * 60_000 })
  await expect(page.getByRole('slider', { name: /Mix waveform/ })).toBeVisible()
  await expect(page.locator('[data-testid^="track-seek-"]')).toHaveCount(12)
  await expect(page.getByText('continuous audio (no silence > 1 s)')).toBeVisible()

  // Playback actually advances, seeking and track navigation move the playhead.
  const now = () => page.evaluate(() => (document.querySelector('audio') as HTMLAudioElement | null)?.currentTime ?? 0)
  await expect.poll(() => page.evaluate(() => (document.querySelector('audio') as HTMLAudioElement | null)?.readyState ?? 0), { timeout: 120_000 }).toBeGreaterThanOrEqual(1)
  await page.getByTestId('mix-play').click()
  await expect.poll(now, { timeout: 60_000 }).toBeGreaterThan(1)
  await expect(page.getByTestId('mix-time')).not.toHaveText(/^0:00 \//)
  await page.getByTestId('track-seek-5').click()
  await expect.poll(now, { timeout: 30_000 }).toBeGreaterThan(60)
  const dur = await page.evaluate(() => (document.querySelector('audio') as HTMLAudioElement).duration)
  expect(dur).toBeGreaterThan(30 * 60)
  // Transition inspector shows the renderer's manifest values.
  await page.getByRole('button', { name: /^→ / }).first().click()
  await expect(page.getByTestId('transition-inspector')).toBeVisible()
  await expect(page.getByTestId('transition-inspector')).toContainText('Overlap')
  // Learned-DJ diagnostics come from the manifest's inference trace.
  const diag = page.getByTestId('ml-diagnostics')
  await diag.locator('summary').click()
  await expect(diag).toContainText('mixgraph_quality')
  await expect(diag).toContainText('critic_quality')
  await expect(diag.getByText('used', { exact: true }).first()).toBeVisible()
  await expect(diag).toContainText('Critic selection')
  await expect(diag).toContainText('Track order')
  await page.screenshot({ path: 'test-results/mixgen-player.png', fullPage: true })
  console.log('console warnings/errors:', logs.slice(0, 20).join('\n'))
})
