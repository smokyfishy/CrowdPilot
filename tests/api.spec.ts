import { test, expect } from '@playwright/test'

test.describe('API tests', () => {
  test('auth proxy forwards to auth worker', async ({ request }) => {
    const res = await request.get('/api/auth/ok')
    expect(res.ok()).toBeTruthy()
  })

  test('WebSocket endpoint exists', async ({ page }) => {
    const socket = page.waitForEvent('websocket', {
      predicate: (ws) => new URL(ws.url()).pathname.startsWith('/ws/'),
    })
    await page.goto('/mix')
    await expect(page.getByTestId('app-navigation')).toBeVisible()
    await socket
  })
})
