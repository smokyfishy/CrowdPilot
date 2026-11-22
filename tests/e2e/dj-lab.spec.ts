/**
 * Real-audio engine check: loads two real Audius tracks in the browser, analyzes
 * them, plans with MixGraph and plays the transition through the Web Audio engine.
 * Asserts the master output carried audio, the handoff and completion fired on the
 * audio clock, and nothing clipped. Needs network access to api.audius.co.
 */
import { expect, test } from '@playwright/test'

test.setTimeout(900_000)

for (const forced of ['', 'bass_swap', 'echo_out', 'loop_roll']) test(`DJ Lab plays an analyzed, planned transition on real Audius audio${forced ? ` (forced ${forced})` : ''}`, async ({ page }) => {
  const logs: string[] = []
  page.on('console', (m) => logs.push(m.text()))
  await page.goto('/lab')
  await page.getByLabel('Search Audius').fill('tech house')
  await page.getByRole('button', { name: 'Search Audius' }).click()
  const rows = page.getByTestId('lab-result')
  await expect(rows.first()).toBeVisible({ timeout: 30_000 })
  let next = 0
  for (const slot of ['a', 'b'] as const) {
    for (;;) {
      expect(next).toBeLessThan(await rows.count())
      await rows.nth(next++).getByRole('button', { name: slot === 'a' ? 'Deck A' : 'Deck B' }).click()
      await page.waitForFunction((s) => window.__djLab?.state === `loaded-${s}` || window.__djLab?.state === `failed-${s}`, slot, { timeout: 330_000 })
      if ((await page.evaluate(() => window.__djLab?.state)) === `loaded-${slot}`) break
    }
  }

  const summaries = await page.evaluate(() => ({ a: window.__djLab?.a, b: window.__djLab?.b }))
  console.log('analysis A', JSON.stringify(summaries.a))
  console.log('analysis B', JSON.stringify(summaries.b))
  expect(summaries.a?.durationSec).toBeGreaterThan(30)
  // the in-browser Beat This! model (ONNX Runtime Web) produced the grid
  expect(summaries.a?.gridSource).toBe('beatnet')
  expect(summaries.b?.gridSource).toBe('beatnet')

  if (forced) await page.getByLabel('Force style').selectOption(forced)
  await page.getByRole('button', { name: 'Plan', exact: true }).click()
  const plan = await page.evaluate(() => window.__djLab?.plan)
  console.log('plan', plan?.style, plan?.overlapBars, plan?.outCueSec, plan?.inCueSec, plan?.tempoRatio)
  expect(plan).toBeTruthy()
  // a forced beat-matched style is only produced when both grids are usable and within ±6%
  if (forced) test.skip(plan?.style !== forced, `planner could not beat-match these tracks (got ${plan?.style})`)

  await page.getByRole('button', { name: 'Audition transition' }).click()
  await page.waitForFunction(() => window.__djLab?.state === 'transition-scheduled', undefined, { timeout: 60_000 })
  // sample the master meter while it plays
  const rms: number[] = []
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(1000)
    rms.push((await page.evaluate(() => window.__djLab?.rmsDb ?? -200)) as number)
  }
  console.log('master RMS dB samples', rms.map((v) => v.toFixed(1)).join(', '))
  expect(Math.max(...rms)).toBeGreaterThan(-50)

  await page.waitForFunction(() => window.__djLab?.transition?.done === true, undefined, { timeout: 240_000 })
  const final = await page.evaluate(() => window.__djLab)
  console.log(final?.log.join('\n'))
  expect(final?.transition?.handedOff).toBe(true)
  expect(final?.clipCount ?? 0).toBe(0)
})
