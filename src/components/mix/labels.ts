/** Human labels for spec enums, shared by the create form, summaries and the mix list. */
import { resolveSpec, type MixSpec } from '@/mixgen/spec'

export const ENERGY_LABEL: Record<string, string> = {
  constant_high: 'High energy',
  gradual_build: 'Gradual build',
  gradual_build_to_peak: 'Build to a peak',
  multiple_peaks: 'Multiple peaks',
  chill_to_energetic: 'Chill to energetic',
  festival_climax: 'Festival climax',
  groovy_then_harder: 'Groovy, then harder',
  high_then_relaxed: 'High, then relaxed',
  steady: 'Steady',
}

export const STYLE_LABEL: Record<string, string> = {
  smooth: 'Smooth',
  smooth_creative: 'Smooth & creative',
  creative: 'Creative (effects)',
  energetic: 'Energetic',
  minimal: 'Minimal',
}

const titleCase = (s: string) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase()).replace(/\bEdm\b/g, 'EDM').replace(/\bDnb\b/g, 'DnB')

/** "House · EDM · 12 tracks · Build to a peak" — compact facts from the interpreted request. */
export function specFacts(spec: MixSpec): string[] {
  const r = resolveSpec(spec)
  return [...r.genres.slice(0, 3).map(titleCase), `${r.songCount} tracks`, `${Math.round(r.targetDurationSec / 60)} min`, ENERGY_LABEL[r.energyCurve] ?? r.energyCurve]
}
