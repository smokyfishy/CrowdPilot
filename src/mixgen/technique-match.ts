/**
 * Which user-nameable techniques (spec.techniques) a concrete transition plan performs. Shared by the
 * set planner (prefer/avoid in edge costs), the closed loop (selection) and the fidelity report.
 */
import type { TransitionPlan } from '../dj/transitions'
import type { TechniquePlan } from './techniques'
import type { TechniqueName } from './spec'

const BY_STYLE: Partial<Record<TransitionPlan['style'], TechniqueName[]>> = {
  drop_swap: ['drop_swap'],
  loop_roll: ['loop_roll'],
  echo_out: ['echo_out'],
  bass_swap: ['bass_swap'],
  filter_sweep: ['filter_sweep'],
  long_blend: ['long_blend'],
  cut: ['cut'],
  scratch_cut: ['scratch'],
  brake: ['brake'],
}

const BY_TECH: Record<string, TechniqueName[]> = {
  spinback: ['spinback'],
  acapella_layer: ['acapella'],
  mashup_swap: ['mashup'],
  double_drop: ['double_drop'],
  reverb_wash: ['reverb_wash'],
  beat_juggle: ['beat_juggle'],
  stab_build: ['stabs'],
}

const BY_STRATEGY: Record<string, TechniqueName[]> = {
  drop_lock: ['drop_swap', 'bass_swap', 'long_blend'],
  echo_handoff: ['echo_out', 'bass_swap', 'long_blend'],
  filter_ride: ['filter_sweep', 'bass_swap', 'long_blend'],
  stem_mashup: ['mashup', 'acapella', 'bass_swap', 'long_blend'],
  layered_blend: ['bass_swap', 'long_blend'],
  percussion_build: ['bass_swap', 'long_blend'],
  vocal_handoff: ['bass_swap', 'long_blend'],
}

/** Techniques a staged long-form strategy performs. */
export function techniquesOfStrategy(strategy: string): TechniqueName[] {
  return BY_STRATEGY[strategy] ?? []
}

/** Techniques a plan performs. A long-form window whose incoming drop lands at its end becomes a drop swap. */
export function techniquesOf(p: TransitionPlan): TechniqueName[] {
  const out = new Set<TechniqueName>()
  if (p.performance) for (const t of BY_STRATEGY[p.performance.strategy] ?? []) out.add(t)
  else for (const t of BY_STYLE[p.style] ?? []) out.add(t)
  const tech = (p as TechniquePlan).tech?.technique
  if (tech) for (const t of BY_TECH[tech] ?? []) out.add(t)
  // an unperformed long window that lands on the incoming drop is performed as a drop lock (build into the drop)
  if (!p.performance && p.overlapBars >= 16 && p.incomingDropSec !== undefined && (p.style === 'long_blend' || p.style === 'staged_blend')) out.add('drop_swap')
  return [...out]
}

export function matchesAny(p: TransitionPlan, names: readonly TechniqueName[]): boolean {
  if (!names.length) return false
  const t = techniquesOf(p)
  return names.some((n) => t.includes(n))
}

/** The defining technique(s) only (used for "avoid": a smooth staged blend is not a "bass swap"). */
export function primaryTechniquesOf(p: TransitionPlan): TechniqueName[] {
  const out = new Set<TechniqueName>()
  if (p.performance) {
    const first = BY_STRATEGY[p.performance.strategy]?.[0]
    if (first && first !== 'bass_swap' && first !== 'long_blend') out.add(first)
  } else for (const t of BY_STYLE[p.style] ?? []) out.add(t)
  const tech = (p as TechniquePlan).tech?.technique
  if (tech) for (const t of BY_TECH[tech] ?? []) out.add(t)
  return [...out]
}

export function avoided(p: TransitionPlan, avoid: readonly TechniqueName[]): boolean {
  if (!avoid.length) return false
  const t = primaryTechniquesOf(p)
  return avoid.some((n) => t.includes(n))
}
