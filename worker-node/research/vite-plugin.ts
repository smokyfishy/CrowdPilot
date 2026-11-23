/**
 * Dev-only research viewer data route for `deepspace dev` / `vite` (apply: 'serve').
 * Serves research outputs from C:\crowdpilot-data\mixgen to LOOPBACK clients only:
 *   GET /__research/                     → list of local research jobs
 *   GET /__research/<job>/manifest.json  → manifest
 *   GET /__research/<job>/report.json    → acquisition/validation report
 *   GET /__research/<job>/mix.mp3        → audio (HTTP Range supported for seeking)
 * The plugin does not exist in production builds; the deployed Worker answers 404 for /__research/*.
 */
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Plugin } from 'vite'

const ROOT = join(process.env.CP_DATA_ROOT ?? 'C:/crowdpilot-data', 'mixgen')
const JOB = /^[A-Za-z0-9_-]{1,80}$/

/**
 * Local job runner for the /research page: each job runs the research CLI
 * (`worker-node/research/launch.mjs`, which enables research mode for its OWN process) as a child
 * process — the dev server itself never enables research mode. One job at a time; progress is the
 * CLI's real stdout.
 *   POST /__research/jobs        { prompt, songs?, minutes?, ml?: 'default'|'off'|'experimental', transitionNet?: boolean }
 *   GET  /__research/jobs        → recent jobs
 *   GET  /__research/jobs/<id>   → status + output lines
 */
interface LocalJob {
  id: string
  prompt: string
  status: 'running' | 'done' | 'failed'
  lines: string[]
  startedAt: number
  finishedAt?: number
  exitCode?: number | null
}
const jobs = new Map<string, LocalJob>()

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let b = ''
    req.on('data', (c: Buffer) => {
      b += c.toString()
      if (b.length > 16_384) req.destroy()
    })
    req.on('end', () => resolve(b))
    req.on('error', reject)
  })
}

async function handleJobs(req: IncomingMessage, res: ServerResponse, path: string) {
  const id = path.split('/')[1]
  if (req.method === 'GET' && !id) {
    return json(res, 200, { jobs: [...jobs.values()].map(({ lines: _l, ...j }) => j).sort((a, b) => b.startedAt - a.startedAt) })
  }
  if (req.method === 'GET' && id) {
    const j = jobs.get(id)
    return j ? json(res, 200, { ...j, lines: j.lines.slice(-400) }) : json(res, 404, { error: 'unknown job' })
  }
  if (req.method === 'POST' && !id) {
    if ([...jobs.values()].some((j) => j.status === 'running')) return json(res, 409, { error: 'A research job is already running.' })
    let b: { prompt?: unknown; songs?: unknown; minutes?: unknown; ml?: unknown; transitionNet?: unknown }
    try {
      b = JSON.parse(await readBody(req))
    } catch {
      return json(res, 400, { error: 'invalid JSON' })
    }
    const prompt = typeof b.prompt === 'string' ? b.prompt.trim().slice(0, 2000) : ''
    if (!prompt) return json(res, 400, { error: 'Describe the mix.' })
    const jobId = `research-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
    const args = ['worker-node/research/launch.mjs', prompt, '--job', jobId]
    const songs = Number(b.songs)
    if (Number.isInteger(songs) && songs >= 2 && songs <= 30) args.push('--songs', String(songs))
    const minutes = Number(b.minutes)
    if (Number.isFinite(minutes) && minutes >= 5 && minutes <= 180) args.push('--minutes', String(Math.round(minutes)))
    if (b.ml === 'off' || b.ml === 'experimental') args.push('--ml', b.ml)
    if (b.transitionNet === true) args.push('--transitionnet')
    const job: LocalJob = { id: jobId, prompt, status: 'running', lines: [], startedAt: Date.now() }
    jobs.set(jobId, job)
    const child = spawn(process.execPath, args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const push = (chunk: Buffer) => {
      for (const l of chunk.toString().split(/\r?\n/)) if (l.trim()) job.lines.push(l)
      if (job.lines.length > 4000) job.lines.splice(0, job.lines.length - 4000)
    }
    child.stdout.on('data', push)
    child.stderr.on('data', push)
    child.on('close', (code) => {
      job.exitCode = code
      job.finishedAt = Date.now()
      job.status = code === 0 && existsSync(join(ROOT, 'renders', 'research', `${jobId}.manifest.json`)) ? 'done' : 'failed'
    })
    child.on('error', (e) => {
      job.lines.push(`failed to start: ${e.message}`)
      job.status = 'failed'
    })
    return json(res, 202, { id: jobId })
  }
  return json(res, 405, { error: 'method not allowed' })
}

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
        if (path === 'jobs' || path.startsWith('jobs/')) return handleJobs(req, res, path)
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
