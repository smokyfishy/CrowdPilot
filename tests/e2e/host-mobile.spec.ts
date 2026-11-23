/** Final-review fix: on phones the host's player must survive switching tabs (it is the room's only speaker). */
import { test, expect, loadAllTestAccounts } from 'deepspace/testing'
import { addFromSearch, createRoom, mockSearch } from './helpers'

test.skip(loadAllTestAccounts().length < 1, 'Needs 1 usable test account.')
test.describe.configure({ timeout: 90_000 })

test('mobile host keeps one visible player across tabs', async ({ users }) => {
  const [host] = await users(1)
  await host.page.setViewportSize({ width: 390, height: 844 })
  await mockSearch(host.page)
  await createRoom(host.page, 'Phone host')
  await addFromSearch(host.page, 'Midnight City', false)
  await host.page.getByRole('button', { name: 'Queue', exact: true }).click()

  const player = host.page.locator('iframe[src*="youtube.com/embed"]')
  await expect(player).toHaveCount(1, { timeout: 30_000 })
  const src = await player.getAttribute('src')

  for (const tab of ['Add songs', 'People', 'Queue']) {
    await host.page.getByRole('button', { name: tab, exact: true }).click()
    await expect(player).toHaveCount(1)
    await expect(player).toBeVisible()
    expect(await player.getAttribute('src')).toBe(src) // same iframe, not a reload
  }
})
