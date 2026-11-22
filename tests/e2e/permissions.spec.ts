/**
 * Server-side permission checks, called directly over HTTP the way a
 * malicious guest would — bypassing the UI entirely.
 */
import { test, expect, loadAllTestAccounts } from 'deepspace/testing'
import { createRoom } from './helpers'

test.skip(loadAllTestAccounts().length < 1, 'Needs 1 usable test account.')
test.describe.configure({ timeout: 60_000 })

test('guests cannot run host-only commands, and kicked guests are locked out', async ({ users, request }) => {
  const [host] = await users(1)
  const roomId = await createRoom(host.page, 'E2E Permissions')

  const join = await request.post(`/api/rooms/${roomId}/join`, { data: { displayName: 'Mallory' } })
  expect(join.status()).toBe(200)
  const { value } = (await join.json()) as { value: { memberId: string; guestToken: string } }
  const headers = { 'X-Guest-Token': value.guestToken }

  for (const cmd of [
    { type: 'advance', reason: 'skip', expectedRevision: 0 },
    { type: 'updateSettings', patch: { perGuestLimit: 10 } },
    { type: 'closeRoom' },
    { type: 'claimController', controllerId: 'evil-controller-1', takeover: true },
  ]) {
    const r = await request.post(`/api/rooms/${roomId}/commands`, { headers, data: cmd })
    expect([cmd.type, r.status()]).toEqual([cmd.type, 403])
  }

  // A forged identity field is ignored (stripped), never trusted.
  const forged = await request.post(`/api/rooms/${roomId}/commands`, {
    headers,
    data: { type: 'react', emoji: '🔥', memberId: 'someone-else' },
  })
  expect(forged.status()).toBe(200)

  // No token at all → 401.
  const anon = await request.post(`/api/rooms/${roomId}/commands`, { data: { type: 'react', emoji: '🔥' } })
  expect(anon.status()).toBe(401)

  // Host kicks Mallory from the People list → her token stops working.
  await host.page.setViewportSize({ width: 1440, height: 900 })
  await host.page.getByRole('button', { name: 'Remove Mallory from the room' }).click()
  await expect
    .poll(async () => (await request.post(`/api/rooms/${roomId}/commands`, { headers, data: { type: 'react', emoji: '🎉' } })).status(), {
      timeout: 15_000,
    })
    .toBe(403)

  // Anonymous joins are refused once the host requires sign-in.
  await host.page.getByRole('button', { name: 'Room settings' }).click()
  await host.page.getByRole('switch', { name: 'Guests can join without signing in' }).click()
  await host.page.keyboard.press('Escape')
  await expect
    .poll(async () => (await request.post(`/api/rooms/${roomId}/join`, { data: { displayName: 'Eve' } })).status(), { timeout: 15_000 })
    .toBe(401)
})
