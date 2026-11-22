import { expect, type Browser, type Page, type Route } from '@playwright/test'

/**
 * Search results are mocked in tests (no 100-unit search calls), but they use REAL public
 * video ids because the server re-resolves every enqueue against YouTube (1 unit each) and
 * stores the authoritative title. Assert on title fragments, not the mocked titles.
 */
export const FAKE_TRACKS = [
  { source: 'youtube', sourceId: 'FGBhQbmPwH8', trackKey: 'youtube:FGBhQbmPwH8', title: 'One More Time', creatorLabel: 'Daft Punk', durationMs: 322_000, playable: true },
  { source: 'youtube', sourceId: '7ID-1jzek4Y', trackKey: 'youtube:7ID-1jzek4Y', title: 'Midnight City', creatorLabel: 'M83 - Topic', durationMs: 244_000, playable: true },
]

export async function mockSearch(page: Page) {
  await page.route('**/api/catalog/search**', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, value: FAKE_TRACKS }) }),
  )
}

/** Host creates a room from /home and lands in it; returns the room id. */
export async function createRoom(page: Page, name: string): Promise<string> {
  await page.goto('/home')
  await page.getByLabel('New room').fill(name)
  await page.getByRole('button', { name: 'Start room' }).click()
  await page.waitForURL(/\/room\/[0-9a-f-]{36}$/, { timeout: 20_000 })
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible({ timeout: 20_000 })
  return page.url().split('/room/')[1]
}

/** A signed-in guest joins with the join card. */
export async function joinSignedIn(page: Page, roomId: string, displayName: string) {
  await page.goto(`/room/${roomId}`)
  await page.getByLabel('Your name in this room').fill(displayName)
  await page.getByRole('button', { name: 'Join room' }).click()
}

/** A fresh, signed-out browser context joins as an anonymous guest. */
export async function joinAnonymous(browser: Browser, baseURL: string, roomId: string, displayName: string) {
  const context = await browser.newContext({ baseURL })
  const page = await context.newPage()
  await page.goto(`/room/${roomId}`)
  await page.getByLabel('Your name in this room').fill(displayName)
  await page.getByRole('button', { name: 'Join as guest' }).click()
  return { context, page }
}

export async function addFromSearch(page: Page, title: string, wide: boolean) {
  if (!wide) await page.getByRole('button', { name: 'Add songs' }).click()
  await page.getByLabel('Search YouTube for a song').fill('e2e search')
  await page.getByRole('button', { name: `Add ${title} to the queue` }).click()
}

export function queueRow(page: Page, titleFragment: string) {
  return page.locator('section[aria-labelledby="queue-heading"] li').filter({ hasText: titleFragment })
}
