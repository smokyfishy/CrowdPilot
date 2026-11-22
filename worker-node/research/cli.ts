/**
 * npm run mixgen -- "<prompt>" [--songs N] [--minutes M] [--job id]
 * Local research mode only (the launcher sets CP_RESEARCH_YOUTUBE=1 for this process).
 */
import { heuristicSpec, INTERPRET_SYSTEM, extractJson, parseSpec, type MixSpec } from '../../src/mixgen/spec'
import { researchYouTubeEnabled } from '../mixgen/research'
import { runResearch } from './run'

function args(argv: string[]) {
  const out: { prompt?: string; songs?: number; minutes?: number; job?: string } = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--songs') out.songs = Number(argv[++i])
    else if (a === '--minutes') out.minutes = Number(argv[++i])
    else if (a === '--job') out.job = argv[++i]
    else if (!a.startsWith('--')) out.prompt = out.prompt ? `${out.prompt} ${a}` : a
  }
  return out
}

/** Optional local LLM interpretation (Anthropic Messages API) when ANTHROPIC_API_KEY is set. */
async function interpret(prompt: string): Promise<{ spec: MixSpec; source: string }> {
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
      return { spec: parseSpec(extractJson(text)), source: 'llm' }
    } catch (e) {
      console.warn(`LLM interpretation failed (${(e as Error).message}); using the basic interpreter.`)
    }
  }
  return { spec: heuristicSpec(prompt), source: 'heuristic (no ANTHROPIC_API_KEY)' }
}

export async function cli(argv = process.argv.slice(2)): Promise<void> {
  if (!researchYouTubeEnabled()) throw new Error('Research mode requires CP_RESEARCH_YOUTUBE=1.')
  const a = args(argv)
  if (!a.prompt) {
    console.error('usage: npm run mixgen -- "<prompt>" [--songs N] [--minutes M] [--job id]')
    process.exit(2)
  }
  const { spec, source } = await interpret(a.prompt)
  if (a.songs) (spec.song_count = Math.max(2, Math.min(30, a.songs))), spec.explicit.push('song_count')
  if (a.minutes) (spec.target_duration_minutes = Math.max(5, Math.min(180, a.minutes))), spec.explicit.push('target_duration_minutes')
  const jobId = a.job ?? `research-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
  console.log(`\nCrowdPilot RESEARCH MODE (local only, not for distribution) — job ${jobId}`)
  console.log(`interpretation: ${source}\n${JSON.stringify(spec)}\n`)
  const t0 = Date.now()
  const r = await runResearch(spec, { jobId, repoRoot: process.cwd(), prompt: a.prompt, specSource: source, onProgress: (e) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${e.stage.padEnd(12)} ${e.done}/${e.total} ${e.detail ?? ''}`) })
  const m = r.result.manifest
  console.log('\nAcquisition (actual results):')
  for (const s of r.songs) {
    const att = s.attempts.map((t) => `${t.key}${t.uploader ? ` [${t.uploader}]` : ''}: ${t.outcome}${t.outcome === 'failed' ? ` (${t.reason})` : ''}`).join('; ')
    console.log(`  ${s.selected ? String((s.position ?? 0) + 1).padStart(2) : ' -'} ${s.status.padEnd(13)} ${s.artist} – ${s.title}${s.bpm ? `  ${s.bpm} BPM ${s.key}` : ''}\n       ${att}`)
  }
  console.log(`\nDuration ${(m.durationSec / 60).toFixed(2)} min (target ${(m.targetDurationSec / 60).toFixed(0)}), ${m.tracks.length} tracks, transitions: ${m.transitions.map((t) => t.label).join(', ')}`)
  console.log('Validation:')
  for (const c of r.result.validation.checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'} ${c.name}: ${c.value}`)
  console.log(`\nMP3:      ${r.mp3Path}\nManifest: ${r.manifestPath}\nReport:   ${r.reportPath}\nViewer:   http://localhost:5191/research/${jobId} (npm run dev, dev builds only)`)
}
