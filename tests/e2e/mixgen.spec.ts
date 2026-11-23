/**
 * Browser end-to-end: prompt → LLM interpretation → discovery → policy-checked audio
 * acquisition → in-browser analysis (Beat This!) → render worker (no review step) →
 * private upload → player (waveform from the render, playback, seeking, track navigation,
 * transition inspection). Uses REAL providers and audio; long-running by design.
 *   DEEPSPACE_PORT=5192 npx playwright test -c tests/playwright.config.ts tests/e2e/mixgen.spec.ts
 * Set MIXGEN_E2E_PROMPT, MIXGEN_E2E_TRACKS and MIXGEN_E2E_MIN_SECONDS for a shorter real-audio run.
 */
import { test, expect, loadAllTestAccounts } from 'deepspace/testing'

test.skip(loadAllTestAccounts().length < 1, 'Needs 1 usable test account.')
test.describe.configure({ timeout: 45 * 60_000 })

const PROMPT = process.env.MIXGEN_E2E_PROMPT ?? 'Generate a 40-minute tech house mix with 12 tracks, a gradual energy build, strong basslines, and smooth transitions.'

const TRANSITIONNET_ONLY = process.env.MIXGEN_E2E_AUTOMATION === 'transitionnet-only'
const TRACKS = Number(process.env.MIXGEN_E2E_TRACKS ?? 12)
const MIN_SECONDS = Number(process.env.MIXGEN_E2E_MIN_SECONDS ?? 30 * 60)

test('describe → generate → listen: a real continuous mix in the browser', async ({ users }) => {
  const [u] = await users(1)
  const page = u.page
  const logs: string[] = []
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && logs.push(`${m.type()}: ${m.text()}`))
  await page.goto('/mix')
  await expect(page.getByRole('heading', { name: 'Create your mix' })).toBeVisible()
  await page.screenshot({ path: 'test-results/mix-create.png', fullPage: true })
  await page.getByTestId('mix-prompt').fill(PROMPT)
  if (TRANSITIONNET_ONLY) {
    await page.getByText('Advanced options', { exact: true }).click()
    await page.getByTestId('pref-automation-model').selectOption('transitionnet-only')
  }
  await page.getByTestId('mix-generate').click()
  await page.waitForURL(/\/mix\/[0-9a-f-]{36}$/, { timeout: 120_000 })

  console.log('Mix ID:', new URL(page.url()).pathname.split('/').at(-1))

  // One compact progress component driven by real stage events.
  const gen = page.getByTestId('mix-generating')
  await expect(gen).toBeVisible()
  await expect(gen.getByRole('heading', { level: 1 })).not.toBeEmpty()
  await expect(gen.getByRole('progressbar', { name: 'Overall progress' })).toBeVisible()
  await expect(gen.getByRole('list', { name: 'Generation stages' }).locator('li')).toHaveCount(4)
  await expect(page.getByTestId('mix-status')).not.toBeEmpty()
  // The raw 11-stage list is only in the collapsed technical details.
  await expect(page.getByTestId('mix-progress')).toBeHidden()
  await expect(page.getByText(/\d+ \/ \d+/).filter({ visible: true })).toHaveCount(0)
  const pct = () => gen.getByRole('progressbar').getAttribute('aria-valuenow').then(Number)
  await expect.poll(pct, { timeout: 10 * 60_000 }).toBeGreaterThan(10)
  await page.screenshot({ path: 'test-results/mix-generating.png', fullPage: true })

  // Reload mid-run: the same job resumes (no duplicate), progress is restored.
  const url = page.url()
  page.once('dialog', (d) => void d.accept())
  await page.reload()
  expect(page.url()).toBe(url)
  await expect(page.getByTestId('mix-generating')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('mix-elsewhere')).toHaveCount(0)

  // Navigate away inside the app and come back: the in-tab job keeps running.
  await page.getByRole('link', { name: 'Your mixes' }).click()
  await expect(page.getByTestId('recent-mixes')).toContainText('In progress')
  await page.goBack() // in-app history: no reload, the job keeps running in this tab
  await expect(page.getByTestId('mix-generating')).toBeVisible()

  // Real selection appears once the tracks are chosen.
  await expect(page.getByTestId('mix-selection').locator('li')).not.toHaveCount(0, { timeout: 30 * 60_000 })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: 'test-results/mix-generating-mobile.png', fullPage: true })
  await page.setViewportSize({ width: 1280, height: 900 })

  // Player: waveform canvas, tracklist, timeline.
  await expect(page.getByTestId('mix-play')).toBeVisible({ timeout: 20 * 60_000 })
  await expect(page.getByRole('slider', { name: /Mix timeline/ })).toBeVisible()
  await expect(page.locator('[data-testid^="track-seek-"]')).toHaveCount(TRACKS)
  await expect(page.getByRole('region', { name: 'AI DJ performance' })).toBeVisible()
  await page.getByText('Audio checks, licences and downloads', { exact: true }).click()
  await expect(page.getByText('continuous audio (no silence > 1 s)')).toBeVisible()

  // Playback actually advances, seeking and track navigation move the playhead.
  const now = () => page.evaluate(() => (document.querySelector('audio') as HTMLAudioElement | null)?.currentTime ?? 0)
  await expect.poll(() => page.evaluate(() => (document.querySelector('audio') as HTMLAudioElement | null)?.readyState ?? 0), { timeout: 120_000 }).toBeGreaterThanOrEqual(1)
  await page.getByTestId('mix-play').click()
  await expect.poll(now, { timeout: 60_000 }).toBeGreaterThan(1)
  await expect(page.getByTestId('mix-time')).not.toHaveText(/^0:00 \//)
  const beforeSeek = await now()
  await page.getByTestId(`track-seek-${Math.min(5, TRACKS - 1)}`).click()
  await expect.poll(now, { timeout: 30_000 }).toBeGreaterThan(beforeSeek + 5)
  const dur = await page.evaluate(() => (document.querySelector('audio') as HTMLAudioElement).duration)
  expect(dur).toBeGreaterThan(MIN_SECONDS)
  // Transition inspector shows the renderer's manifest values.
  await page.getByTitle('Transition into track 2').click()
  await expect(page.getByTestId('transition-inspector')).toBeVisible()
  await expect(page.getByTestId('transition-inspector')).toContainText('Overlap')
  // Learned-DJ diagnostics come from the manifest's inference trace.
  const diag = page.getByTestId('ml-diagnostics')
  await diag.locator('summary').click()
  if (TRANSITIONNET_ONLY) {
    await expect(diag.getByRole('row').filter({ hasText: 'transitionnet' }).getByText('used', { exact: true })).toBeVisible()
    await expect(diag.getByRole('row').filter({ hasText: 'mixgraph_quality' }).getByText('used', { exact: true })).toHaveCount(0)
    await expect(diag.getByRole('row').filter({ hasText: 'critic_quality' }).getByText('used', { exact: true })).toHaveCount(0)
    await expect(page.getByTestId('transition-inspector')).toContainText('TransitionNet (learned automation)')
  } else {
    await expect(diag).toContainText('mixgraph_quality')
    await expect(diag).toContainText('critic_quality')
    await expect(diag.getByText('used', { exact: true }).first()).toBeVisible()
    await expect(diag).toContainText('Transition ranking')
    await expect(diag).toContainText('Track order')
  }
  await page.screenshot({ path: 'test-results/mixgen-player.png', fullPage: true })
  console.log('console warnings/errors:', logs.slice(0, 20).join('\n'))
})
