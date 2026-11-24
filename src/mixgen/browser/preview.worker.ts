/// <reference lib="webworker" />
/**
 * Closed-loop preview worker: renders a candidate transition from cropped audio with the production
 * renderer and measures it (explicit metrics + DJCritic), exactly like the in-page path. Several of
 * these run in parallel so the closed loop is not limited to one CPU core.
 */
import { renderPreviewCropped, type PreviewCrops } from '../closedloop'
import { evaluateTransition } from '../audio-quality'
import { criticFromMix, type DjModels } from '../../ml/dj-brain'
import type { TransitionPlan } from '../../dj/transitions'

type Track = { key: string; trimDb: number; summary: { barSec: number }; profile: Parameters<typeof evaluateTransition>[1]['pa']; netBeats?: Parameters<typeof evaluateTransition>[1]['beatsA'] }
export type PreviewWorkerIn =
  | { type: 'init'; critic: NonNullable<DjModels['critic']> | null }
  | { type: 'measure'; id: number; plan: TransitionPlan; a: Track; b: Track; crops: PreviewCrops; stems: Parameters<typeof evaluateTransition>[1]['stems']; critic: boolean }
export type PreviewWorkerOut = { id: number; q?: ReturnType<typeof evaluateTransition>; error?: string }

let critic: NonNullable<DjModels['critic']> | null = null
self.onmessage = (ev: MessageEvent<PreviewWorkerIn>) => {
  const m = ev.data
  if (m.type === 'init') {
    critic = m.critic
    return
  }
  try {
    const r = renderPreviewCropped(m.plan, m.a, m.b, m.crops)
    const c = m.critic && critic ? criticFromMix(critic, m.plan, r.mix, r.rate, r.t0, r.t1) : undefined
    const q = evaluateTransition(r, { plan: m.plan, pa: m.a.profile, pb: m.b.profile, beatsA: m.a.netBeats, beatsB: m.b.netBeats, stems: m.stems, critic: c })
    ;(self as unknown as Worker).postMessage({ id: m.id, q } satisfies PreviewWorkerOut)
  } catch (e) {
    ;(self as unknown as Worker).postMessage({ id: m.id, error: (e as Error).message } satisfies PreviewWorkerOut)
  }
}
