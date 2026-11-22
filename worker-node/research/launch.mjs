// Launcher for `npm run mixgen`: research mode is explicitly enabled for THIS local process only,
// then the TypeScript CLI is bundled with esbuild and executed. Never used by any cloud build.
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
process.env.CP_RESEARCH_YOUTUBE = '1'
mkdirSync('node_modules/.cache/mixgen', { recursive: true })
const outfile = 'node_modules/.cache/mixgen/cli.mjs'
await build({
  entryPoints: ['worker-node/research/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile,
  external: ['onnxruntime-node'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'error',
})
const { cli } = await import(pathToFileURL(outfile).href)
await cli(process.argv.slice(2))
