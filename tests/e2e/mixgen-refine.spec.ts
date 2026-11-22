/**
 * Natural-language refinement on an existing ready mix:
 *   MIX_ID=<ready mix id> npx playwright test -c playwright.prod-mixgen.config.ts e2e/mixgen-refine.spec.ts
 * "Make this 30 minutes instead" → new version (parentId, version history) → re-planned selection near 30 min.
 */
import { test, expect, loadAllTestAccounts } from 'deepspace/testing'

test.skip(loadAllTestAccounts().length < 1, 'Needs a test account.')
test.describe.configure({ timeout: 45 * 60_000 })

test('refine: "make this 30 minutes instead" creates a re-planned version', async ({ users }) => {
  const [u] = await users(1)
  const page = u.page
  let mixId = process.env.MIX_ID
  if (!mixId) {
    // newest finished mix of this account
    await page.goto('/mix')
    const link = page.locator('a[href^="/mix/"]').filter({ hasText: /tracks ·/ }).first()
    await expect(link).toBeVisible({ timeout: 60_000 })
    mixId = (await link.getAttribute('href'))!.split('/mix/')[1]
  }
  await page.goto(`/mix/${mixId}`)
  await expect(page.getByTestId('mix-refine')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('mix-refine').fill('Make this 30 minutes instead')
  await page.getByRole('button', { name: 'Create new version' }).click()
  await page.waitForURL((url) => /\/mix\/[0-9a-f-]{36}$/.test(url.pathname) && !url.pathname.endsWith(mixId!), { timeout: 90_000 })
  await expect(page.getByText('Version 2')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('link', { name: 'v1' })).toBeVisible()
  await expect(page.getByText(/Edit: “Make this 30 minutes instead”/)).toBeVisible()
  const sel = page.getByTestId('mix-selection')
  await expect(sel).toBeVisible({ timeout: 40 * 60_000 })
  const text = (await page.getByText(/Planned length/).textContent()) ?? ''
  const m = /Planned length (\d+):(\d+)/.exec(text)
  expect(m).not.toBeNull()
  const minutes = Number(m![1]) + Number(m![2]) / 60
  expect(Math.abs(minutes - 30)).toBeLessThan(3)
  expect(text).toContain('30 min requested')
})
