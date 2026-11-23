// Bundles the worker for the container image: node worker-node/service/build.mjs
import { build } from 'esbuild'
import { cpSync, mkdirSync } from 'node:fs'
const out = 'worker-node/service/docker'
mkdirSync(`${out}/public/models`, { recursive: true })
await build({
  entryPoints: ['worker-node/service/entry.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outfile: `${out}/worker.mjs`,
  external: ['onnxruntime-node'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
})
for (const f of ['beat_this_small0.onnx', 'beat_this_melfb.json']) cpSync(`public/models/${f}`, `${out}/public/models/${f}`)
