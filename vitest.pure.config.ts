import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Pure-logic unit tests (domain, providers, server command layer) that never
// import src/constants.ts, so they run without a registered DEEPSPACE_APP_ID.
// The main vitest.config.ts still runs everything once the app is registered.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['src/domain/**/*.test.ts', 'src/dsp/**/*.test.ts', 'src/dj/**/*.test.ts', 'src/providers/**/*.test.ts', 'src/server/**/*.test.ts', 'src/schemas/**/*.test.ts', 'src/client/**/*.test.ts', 'src/components/**/*.test.ts', 'src/mixgen/**/*.test.ts', 'worker-node/**/*.test.ts'],
    environment: 'node',
  },
})
