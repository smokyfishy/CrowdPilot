/**
 * npm run mixgen -- "<prompt>" [--songs N] [--minutes M] [--job id]
 * Local research mode only (the launcher sets CP_RESEARCH_YOUTUBE=1 for this process).
 */
import { interpretPrompt } from '../../src/server/mixgen-routes'
import { museClient } from '../../src/server/llm'
import { guardSpec, heuristicSpec, INTERPRET_SYSTEM, extractJson, parseSpec, type MixSpec } from '../../src/mixgen/spec'
import { researchYouTubeEnabled } from '../mixgen/research'
import { readFileSync } from 'node:fs'
import { runResearch } from './run'
import type { MlOptions } from '../../src/mixgen/ml'

function args(argv: string[]) {
  const out: { prompt?: string; songs?: number; minutes?: number; job?: string; specFile?: string; style?: string; stems?: boolean; ml: Partial<MlOptions> } = { ml: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--songs') out.songs = Number(argv[++i])
    else if (a === '--minutes') out.minutes = Number(argv[++i])
    else if (a === '--job') out.job = argv[++i]
    else if (a === '--ml') out.ml.mode = argv[++i] as MlOptions['mode'] // off | promoted | experimental
    else if (a === '--no-mixgraph') out.ml.mixgraph = false
    else if (a === '--no-transitionnet') out.ml.transitionNet = false
    else if (a === '--transitionnet') out.ml.transitionNet = true
    else if (a === '--spec') out.specFile = argv[++i]
    else if (a === '--style') out.style = argv[++i]
    else if (a === '--stems') out.stems = true
    else if (a === '--no-stems') out.stems = false
    else if (a === '--no-critic') out.ml.critic = false
    else if (a === '--no-ml-ordering') out.ml.ordering = false
    else if (!a.startsWith('--')) out.prompt = out.prompt ? `${out.prompt} ${a}` : a
  }
  return out
}

/** Local LLM interpretation: Muse (MUSE_API_KEY), then Claude (ANTHROPIC_API_KEY), with the deterministic guard; otherwise the heuristic. */
async function interpret(prompt: string): Promise<{ spec: MixSpec; source: string }> {
  if (process.env.MUSE_API_KEY) {
    try {
      const r = await interpretPrompt([museClient({ apiKey: process.env.MUSE_API_KEY, baseUrl: process.env.MUSE_BASE_URL, model: process.env.MUSE_MODEL })], { prompt })
      if (r.source === 'llm') return { spec: r.spec, source: `${r.model} (Muse)` }
    } catch {
      /* fall through to Claude */
    }
  }
  const key = process.env.ANTHROPIC_API_KEY
  if (key) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: process.env.MIXGEN_MODEL ?? 'claude-sonnet-5-5', max_tokens: 1500, system: INTERPRET_SYSTEM, messages: [{ role: 'user', content: prompt }] }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> }
      const text = (body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('')
      return { spec: guardSpec(prompt, parseSpec(extractJson(text))).spec, source: 'llm (claude)' }
    } catch (e) {
      console.warn(`LLM interpretation failed (${(e as Error).message}); using the basic interpreter.`)
    }
  }
  return { spec: heuristicSpec(prompt), source: 'heuristic (no MUSE_API_KEY / ANTHROPIC_API_KEY)' }
}

export async function cli(argv = process.argv.slice(2)): Promise<void> {
  if (!researchYouTubeEnabled()) throw new Error('Research mode requires CP_RESEARCH_YOUTUBE=1.')
  const a = args(argv)
  if (!a.prompt) {
    console.error('usage: npm run mixgen -- "<prompt>" [--songs N] [--minutes M] [--job id]')
    process.exit(2)
  }
  // An interpretation made elsewhere (e.g. the AI interpreter on the local /mix page) takes precedence.
  const { spec, source } = a.specFile
    ? { spec: parseSpec(JSON.parse(readFileSync(a.specFile, 'utf8'))), source: 'AI interpreter (from /mix)' }
    : await interpret(a.prompt)
  if (a.style && ['smooth', 'smooth_creative', 'creative', 'energetic', 'minimal'].includes(a.style)) (spec.transition_style = a.style as MixSpec['transition_style']), spec.explicit.push('transition_style')
  if (a.songs) (spec.song_count = Math.max(2, Math.min(30, a.songs))), spec.explicit.push('song_count')
  if (a.minutes) (spec.target_duration_minutes = Math.max(5, Math.min(180, a.minutes))), spec.explicit.push('target_duration_minutes')
  const jobId = a.job ?? `research-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
  console.log(`\nCrowdPilot RESEARCH MODE (local only, not for distribution) — job ${jobId}`)
  console.log(`interpretation: ${source}\n${JSON.stringify(spec)}\n`)
  const t0 = Date.now()
  const r = await runResearch(spec, { jobId, repoRoot: process.cwd(), prompt: a.prompt, specSource: source, ml: a.ml, stems: a.stems, onProgress: (e) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${e.stage.padEnd(12)} ${e.done}/${e.total} ${e.detail ?? ''}`) })
  const m = r.result.manifest
  console.log('\nAcquisition (actual results):')
  for (const s of r.songs) {
    const att = s.attempts.map((t) => `${t.key}${t.uploader ? ` [${t.uploader}]` : ''}: ${t.outcome}${t.outcome === 'failed' ? ` (${t.reason})` : ''}`).join('; ')
    console.log(`  ${s.selected ? String((s.position ?? 0) + 1).padStart(2) : ' -'} ${s.status.padEnd(13)} ${s.artist} – ${s.title}${s.bpm ? `  ${s.bpm} BPM ${s.key}` : ''}\n       ${att}`)
  }
  const ml = m.ml
  if (ml) {
    console.log(`\nML (${ml.mode}): ${ml.models.map((x) => `${x.name}${x.used ? ' [used]' : x.loaded ? ' [loaded, unused]' : ' [not loaded]'}`).join(', ')}`)
    console.log(`  counts ${JSON.stringify(ml.counts)}  timings(ms) ${JSON.stringify(Object.fromEntries(Object.entries(ml.timingsMs).map(([k, v]) => [k, Math.round(v)])))}`)
    for (const d of ml.decisions.filter((x) => x.stage !== 'automation')) console.log(`  [${d.stage}] ${d.model}${d.pair ? ` ${d.pair}` : ''}: ${d.decision}`)
    for (const f of ml.fallbacks) console.log(`  fallback: ${f}`)
    console.log(`  automation per transition: ${m.transitions.map((t) => (t.control?.automation === 'transitionnet' ? 'TransitionNet' : 'template')).join(', ')}`)
  }
  console.log(`\nDuration ${(m.durationSec / 60).toFixed(2)} min (target ${(m.targetDurationSec / 60).toFixed(0)}), ${m.tracks.length} tracks, transitions: ${m.transitions.map((t) => t.label).join(', ')}`)
  console.log('Validation:')
  for (const c of r.result.validation.checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'} ${c.name}: ${c.value}`)
  console.log(`\nMP3:      ${r.mp3Path}\nManifest: ${r.manifestPath}\nReport:   ${r.reportPath}\nViewer:   http://localhost:5191/research/${jobId} (npm run dev, dev builds only)`)
}
