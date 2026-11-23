import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Real-audio evaluation harness (needs the private corpus in C:\crowdpilot-data). Not part of CI.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { include: ['evaluation/**/*.eval.ts'], environment: 'node', testTimeout: 3_600_000 },
})
