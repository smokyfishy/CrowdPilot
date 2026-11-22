import { defineConfig } from '@playwright/test'
import { chromiumLaunchOptions } from 'deepspace/testing'
// Production check of the AI mix generator (real audio, real LLM, real storage) on https://crowdpilot.app.space
export default defineConfig({
  testDir: '.',
  testMatch: ['e2e/mixgen.spec.ts', 'e2e/mixgen-player.spec.ts', 'e2e/mixgen-refine.spec.ts'],
  timeout: 45 * 60_000,
  retries: 0,
  use: { baseURL: process.env.PROD_URL ?? 'https://crowdpilot.app.space', headless: true, launchOptions: chromiumLaunchOptions() },
})
