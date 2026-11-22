/**
 * Dev-only research viewer data route for `deepspace dev` / `vite` (apply: 'serve').
 * Serves research outputs from C:\crowdpilot-data\mixgen to LOOPBACK clients only:
 *   GET /__research/                     → list of local research jobs
 *   GET /__research/<job>/manifest.json  → manifest
 *   GET /__research/<job>/report.json    → acquisition/validation report
 *   GET /__research/<job>/mix.mp3        → audio (HTTP Range supported for seeking)
 * The plugin does not exist in production builds; the deployed Worker answers 404 for /__research/*.
 */
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'

const ROOT = join(process.env.CP_DATA_ROOT ?? 'C:/crowdpilot-data', 'mixgen')
const JOB = /^[A-Za-z0-9_-]{1,80}$/

export function researchViewer(): Plugin {
  return {
    name: 'crowdpilot-research-viewer',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/__research')) return next()
        const addr = req.socket.remoteAddress ?? ''
        if (!/^(127\.|::1$|::ffff:127\.)/.test(addr)) {
          res.statusCode = 403
          return res.end('research viewer is localhost-only')
        }
        const path = decodeURIComponent(req.url.split('?')[0]).replace(/^\/__research\/?/, '')
        if (!path) {
          const dir = join(ROOT, 'renders', 'research')
          const jobs = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.manifest.json')).map((f) => f.replace('.manifest.json', '')) : []
          res.setHeader('content-type', 'application/json')
          return res.end(JSON.stringify({ jobs }))
        }
        const [job, file] = path.split('/')
        if (!JOB.test(job) || !['manifest.json', 'report.json', 'mix.mp3'].includes(file)) {
          res.statusCode = 404
          return res.end('not found')
        }
        const fp = file === 'mix.mp3' ? join(ROOT, 'exports', 'research', `${job}.mp3`) : join(ROOT, 'renders', 'research', `${job}.${file}`)
        if (!existsSync(fp)) {
          res.statusCode = 404
          return res.end('not found')
        }
        const size = statSync(fp).size
        res.setHeader('cache-control', 'no-store')
        res.setHeader('x-crowdpilot-mode', 'research (local only, not for distribution)')
        if (file !== 'mix.mp3') {
          res.setHeader('content-type', 'application/json')
          return createReadStream(fp).pipe(res)
        }
        res.setHeader('content-type', 'audio/mpeg')
        res.setHeader('accept-ranges', 'bytes')
        const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '')
        if (m) {
          const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
          const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1
          res.statusCode = 206
          res.setHeader('content-range', `bytes ${start}-${end}/${size}`)
          res.setHeader('content-length', String(end - start + 1))
          return createReadStream(fp, { start, end }).pipe(res)
        }
        res.setHeader('content-length', String(size))
        createReadStream(fp).pipe(res)
      })
    },
  }
}
