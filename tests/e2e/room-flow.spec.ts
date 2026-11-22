/**
 * Multi-user room flow: host + signed-in guest + anonymous guest, all live.
 * Needs 2 test accounts and GUEST_TOKEN_SECRET set (anonymous join).
 * Search is mocked per page so the run never spends YouTube quota.
 */
import { test, expect, loadAllTestAccounts } from 'deepspace/testing'
import { addFromSearch, createRoom, joinAnonymous, joinSignedIn, mockSearch, queueRow } from './helpers'

test.skip(loadAllTestAccounts().length < 2, 'Needs 2 usable test accounts (npx deepspace test accounts create ...).')
test.describe.configure({ timeout: 90_000 })

test('host and two guests share a live queue', async ({ users, browser, baseURL }) => {
  const [host, ann] = await users(2)
  await host.page.setViewportSize({ width: 1440, height: 900 })
  await ann.page.setViewportSize({ width: 1440, height: 900 })
  await mockSearch(host.page)
  await mockSearch(ann.page)

  const roomId = await createRoom(host.page, 'E2E Friday')
  await joinSignedIn(ann.page, roomId, 'Ann')
  const bob = await joinAnonymous(browser, baseURL as string, roomId, 'Bob')
  await bob.page.setViewportSize({ width: 390, height: 844 })
  await mockSearch(bob.page)

  // Presence/membership: everyone appears for the host.
  await expect(host.page.getByText('Ann', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(host.page.getByText('Bob', { exact: true })).toBeVisible({ timeout: 20_000 })

  // Simultaneous adds from two guests show up everywhere without a reload.
  await Promise.all([addFromSearch(ann.page, 'Nightcall', true), addFromSearch(bob.page, 'Midnight City', false)])
  for (const page of [host.page, ann.page]) {
    await expect(queueRow(page, 'Nightcall')).toBeVisible({ timeout: 20_000 })
    await expect(queueRow(page, 'Midnight City')).toBeVisible({ timeout: 20_000 })
  }

  // Duplicate request → offered a vote instead, and the vote counts once.
  await bob.page.getByLabel('Search YouTube for a song').fill('again')
  await expect(bob.page.getByText('In queue').first()).toBeVisible({ timeout: 10_000 })
  await bob.page.getByRole('button', { name: 'Queue', exact: true }).click()
  const vote = bob.page.getByRole('button', { name: /Vote for Nightcall/ })
  await vote.click()
  await expect(host.page.getByRole('button', { name: /Nightcall, 1 vote/ })).toBeVisible({ timeout: 15_000 })

  // Host pins Midnight City to play next.
  await host.page.getByRole('button', { name: 'Play Midnight City next' }).click()
  await expect(ann.page.getByText('Plays next', { exact: false })).toBeVisible({ timeout: 15_000 })

  // Host pauses requests → guests see the explanation.
  await host.page.getByRole('button', { name: 'Room settings' }).click()
  await host.page.getByRole('switch', { name: 'Guests can add songs' }).click()
  await host.page.keyboard.press('Escape')
  await expect(ann.page.getByText('The host has paused requests', { exact: false })).toBeVisible({ timeout: 15_000 })

  // Host removes a song; it disappears for everyone.
  await host.page.getByRole('button', { name: 'Remove Nightcall' }).click()
  await expect(queueRow(ann.page, 'Nightcall')).toHaveCount(0, { timeout: 15_000 })

  // Refresh keeps the queue.
  await host.page.reload()
  await expect(queueRow(host.page, 'Midnight City')).toBeVisible({ timeout: 20_000 })

  await bob.context.close()
})
