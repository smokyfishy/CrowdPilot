import { expect, type Browser, type Page, type Route } from '@playwright/test'

/** Fake catalog results — used ONLY in tests so specs never spend YouTube quota. */
export const FAKE_TRACKS = [
  { source: 'youtube', sourceId: 'e2eTrackAAA', trackKey: 'youtube:e2eTrackAAA', title: 'Nightcall', creatorLabel: 'Kavinsky', durationMs: 258_000, playable: true },
  { source: 'youtube', sourceId: 'e2eTrackBBB', trackKey: 'youtube:e2eTrackBBB', title: 'Midnight City', creatorLabel: 'M83', durationMs: 244_000, playable: true },
  { source: 'youtube', sourceId: 'e2eTrackCCC', trackKey: 'youtube:e2eTrackCCC', title: 'Genesis', creatorLabel: 'Justice', durationMs: 233_000, playable: true },
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

export function queueRow(page: Page, title: string) {
  return page.locator('#queue-heading').locator('xpath=ancestor::section[1]').getByText(title, { exact: true })
}
