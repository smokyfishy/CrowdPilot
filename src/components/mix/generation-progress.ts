/**
 * Maps the pipeline's eleven real stages (src/mixgen/types.ts STAGES) onto the four
 * stages a listener cares about, and computes one overall fraction from the REAL
 * done/total counts each stage reports. No timers, no invented percentages: a stage
 * only contributes what its own progress events say is finished.
 *
 * A job runs in two passes. The prepare pass covers discovery → analysis → planning.
 * The render pass re-runs the early stages (instantly, from the prepared pool and cached
 * analyses) before rendering, so during that pass everything before rendering counts as
 * done and the bar never jumps backwards.
 */
import { STAGES, type Stage } from '@/mixgen/types'

export type StageEvents = Record<string, { done: number; total: number; detail?: string }>
export type Pass = 'prepare' | 'render'

export interface Phase {
  id: 'discover' | 'prepare' | 'create' | 'finalize'
  /** Full stage name, shown for the active stage ("Creating your mix"). */
  label: string
  /** One-word form for compact steppers. */
  short: string
  stages: Stage[]
}

export const PHASES: Phase[] = [
  { id: 'discover', label: 'Discovering music', short: 'Discovering', stages: ['understanding', 'discovering', 'resolving'] },
  { id: 'prepare', label: 'Preparing tracks', short: 'Preparing', stages: ['acquiring', 'analyzing', 'selecting'] },
  { id: 'create', label: 'Creating your mix', short: 'Mixing', stages: ['ordering', 'transitions', 'rendering'] },
  { id: 'finalize', label: 'Finalizing audio', short: 'Finishing', stages: ['validating', 'ready'] },
]

/** One plain-language status line per real stage. */
const MESSAGE: Record<Stage, string> = {
  understanding: 'Reading your mix description…',
  discovering: 'Finding tracks that match your sound…',
  resolving: 'Finding the perfect tracks for your set…',
  acquiring: 'Analyzing beats, energy, and musical structure…',
  analyzing: 'Analyzing beats, energy, and musical structure…',
  selecting: 'Choosing the tracks for your set…',
  ordering: 'Arranging the track order…',
  transitions: 'Crafting smooth transitions…',
  rendering: 'Mixing everything together…',
  validating: 'Putting the finishing touches on your mix…',
  ready: 'Your mix is ready.',
}

/** Relative cost of each stage (sums to 100). Analysis and rendering dominate real runs. */
const WEIGHT: Record<Stage, number> = {
  understanding: 1,
  discovering: 5,
  resolving: 2,
  acquiring: 14,
  analyzing: 26,
  selecting: 2,
  ordering: 2,
  transitions: 8,
  rendering: 30,
  validating: 8,
  ready: 2,
}
const TOTAL_WEIGHT = STAGES.reduce((s, k) => s + WEIGHT[k], 0)

const idx = (s: Stage) => STAGES.indexOf(s)
/** Acquisition and analysis interleave per track, so they share one block. */
const block = (s: Stage) => (s === 'analyzing' ? idx('acquiring') : idx(s))
const isStage = (s: string | undefined): s is Stage => !!s && (STAGES as readonly string[]).includes(s)

function ratio(e: { done: number; total: number } | undefined): number {
  if (!e || !(e.total > 0) || !Number.isFinite(e.done)) return 0
  return Math.max(0, Math.min(1, e.done / e.total))
}

export interface ProgressSummary {
  /** Index into PHASES. */
  phase: number
  /** 0..1, from real counts. */
  overall: number
  message: string
  /** The effective pipeline stage (after the render-pass floor). */
  stage: Stage
}

export function summarizeProgress({ stage, events, pass }: { stage?: string; events: StageEvents; pass: Pass }): ProgressSummary {
  let eff: Stage = isStage(stage) ? stage : 'understanding'
  if (pass === 'render' && idx(eff) < idx('rendering')) eff = 'rendering'
  const cb = block(eff)
  let sum = 0
  for (const s of STAGES) {
    const b = block(s)
    const f = b < cb ? 1 : b === cb ? ratio(events[s]) : 0
    sum += WEIGHT[s] * f
  }
  const overall = eff === 'ready' ? 1 : Math.min(0.99, sum / TOTAL_WEIGHT)
  return { phase: PHASES.findIndex((p) => p.stages.includes(eff)), overall, message: MESSAGE[eff], stage: eff }
}

export interface FriendlyError {
  title: string
  hint: string
  retryable: boolean
}

/** Turns a raw pipeline error into something a listener can act on (the raw text stays in technical details). */
export function friendlyError(raw: string): FriendlyError {
  const m = raw.toLowerCase()
  if (/\((401|403)\)|unauthori[sz]ed|not signed in|session expired/.test(m))
    return { title: 'Please sign in again', hint: 'Your session expired while the mix was being created. Sign in, then retry — nothing analyzed so far is lost.', retryable: true }
  if (/failed to fetch|network|load failed|timed? ?out|\(5\d\d\)/.test(m))
    return { title: 'Connection problem', hint: 'We lost contact with the server. Check your connection and retry — tracks already analyzed are reused.', retryable: true }
  if (/not enough for a mix|no recordings|no candidates|no tracks/.test(m))
    return { title: 'Not enough mixable tracks found', hint: 'Too few tracks matched and were available for mixing. Retry, or start a new mix with broader genres, fewer songs or a shorter duration.', retryable: true }
  if (/quota|rate limit|too many requests|\(429\)/.test(m))
    return { title: 'The music catalog is busy', hint: 'A music service is limiting requests right now. Wait a minute, then retry.', retryable: true }
  if (/decode|worker crashed|out of memory|allocation/.test(m))
    return { title: 'Your browser ran out of room', hint: 'Mixes are rendered in this browser tab. Close other heavy tabs and retry, or start a shorter mix.', retryable: true }
  return { title: 'Something went wrong while creating your mix', hint: 'Retrying usually works — tracks already analyzed are reused, so it picks up faster.', retryable: true }
}
