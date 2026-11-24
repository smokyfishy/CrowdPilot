/**
 * Live request-interpretation accuracy: the production /api/mixgen/interpret (Claude + repair + guard)
 * on the shared 24-request set, scored field by field. Writes test-results/interpret-accuracy.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test } from 'deepspace/testing'
import { CASES, score } from '../../evaluation/interpret-cases'

test('interpretation accuracy on the live interpreter', async ({ users }) => {
  test.setTimeout(20 * 60_000)
  const [u] = await users(1)
  const page = u.page
  let token = ''
  // capture the signed-in user's bearer token from the app's own interpret call, then cancel it
  await page.route('**/api/mixgen/interpret', async (route) => {
    token = route.request().headers()['authorization'] ?? ''
    await route.abort()
  })
  await page.goto('/mix')
  await expect(page.getByRole('heading', { name: 'Create your mix' })).toBeVisible()
  await page.getByTestId('mix-prompt').fill('a 20 minute house mix')
  await page.getByTestId('mix-generate').click()
  await expect.poll(() => token, { timeout: 60_000 }).not.toBe('')
  await page.unroute('**/api/mixgen/interpret')
  const rows: Array<{ prompt: string; source: string; model: string; ok: number; total: number; misses: string[]; corrections: string[] }> = []
  let ok = 0
  let total = 0
  for (const c of CASES.slice(0, Number(process.env.INTERP_LIMIT ?? CASES.length))) {
    const r = await page.request.post('/api/mixgen/interpret', { headers: { authorization: token, 'content-type': 'application/json' }, data: { prompt: c.prompt } })
    const j = (await r.json()) as { spec: Parameters<typeof score>[0]; source: string; model: string; corrections: string[]; attempts?: string[]; warning?: string }
    if (j.source !== 'llm') console.log(`FALLBACK "${c.prompt.slice(0, 40)}": ${j.warning ?? ''} | ${(j.attempts ?? []).join(' | ').slice(0, 400)}`)
    const s = score(j.spec, c.exp)
    ok += s.ok
    total += s.total
    rows.push({ prompt: c.prompt, source: j.source, model: j.model, ok: s.ok, total: s.total, misses: s.misses, corrections: j.corrections })
    await page.waitForTimeout(6500) // 10 interpretations / minute / user
  }
  mkdirSync('test-results', { recursive: true })
  writeFileSync('test-results/interpret-accuracy.json', JSON.stringify({ ok, total, rows }, null, 2))
  console.log(`INTERPRET accuracy ${ok}/${total} (${((100 * ok) / total).toFixed(1)} %), llm ${rows.filter((r) => r.source === 'llm').length}/${rows.length}`)
  for (const r of rows) if (r.misses.length) console.log(`MISS "${r.prompt.slice(0, 60)}" → ${r.misses.join(' | ')}`)
})
