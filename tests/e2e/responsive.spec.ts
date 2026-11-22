/** Layout and accessibility checks at phone, tablet and desktop widths. */
import { test, expect } from '@playwright/test'

const WIDTHS = [360, 768, 1440]

for (const width of WIDTHS) {
  test(`landing has no horizontal scroll at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/')
    await expect(page.getByTestId('static-landing')).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    await page.screenshot({ path: `test-results/landing-${width}.png`, fullPage: true })
  })
}

test('landing is keyboard operable: code field submits with Enter', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Room code').focus()
  await page.keyboard.type('zz9zz9')
  await expect(page.getByLabel('Room code')).toHaveValue('ZZ9ZZ9')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/join\/ZZ9ZZ9$/)
  await expect(page.getByRole('heading', { name: 'Room not found' })).toBeVisible({ timeout: 15_000 })
})

test('honours reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  const duration = await page.evaluate(() => getComputedStyle(document.body).transitionDuration)
  expect(['0s', '1e-05s', '0.00001s']).toContain(duration)
})
