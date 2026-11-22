import { defineConfig } from '@playwright/test'
import { chromiumLaunchOptions } from 'deepspace/testing'
// Read-only production check (no local server): real-audio DJ Lab on https://crowdpilot.app.space
export default defineConfig({
  testDir: '.',
  testMatch: 'e2e/dj-lab.spec.ts',
  timeout: 360_000,
  retries: 0,
  use: { baseURL: process.env.PROD_URL ?? 'https://crowdpilot.app.space', headless: true, launchOptions: chromiumLaunchOptions() },
})
