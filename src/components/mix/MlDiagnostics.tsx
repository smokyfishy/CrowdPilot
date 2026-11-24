/**
 * How the AI DJ made this mix, in plain words: what was asked for, what it did, how each transition
 * was performed, and which models helped. (Model versions, measurements and raw values stay in the
 * mix's saved data for debugging; they are not shown here.)
 */
import { Sparkles } from 'lucide-react'
import { MixDisclosure } from './MixDisclosure'
import type { MixManifest } from '@/mixgen/manifest'

const CURVE: Record<string, string> = {
  constant_high: 'keeps the energy high throughout',
  gradual_build: 'builds the energy gradually',
  gradual_build_to_peak: 'builds steadily to a peak',
  multiple_peaks: 'rises and falls through several peaks',
  chill_to_energetic: 'starts chilled and gets more energetic',
  festival_climax: 'builds to a festival-style finish',
  groovy_then_harder: 'starts groovy and gets harder',
  high_then_relaxed: 'starts high and winds down',
  steady: 'keeps a steady groove',
}

/** What each model contributed, in a few words (only models that ran are listed). */
const HELPERS: Array<[string, string]> = [
  ['beat_this_small0', 'Beat This! found the beats'],
  ['demucs_htdemucs', 'Demucs split tracks into vocals, drums, bass and melody'],
  ['mixgraph_quality', 'MixGraph chose which tracks and cue points go together'],
  ['transitionnet_v2', 'TransitionNet designed the transitions'],
  ['critic_quality', 'DJCritic listened to test versions and kept the best'],
]

/** Transition techniques in plain words (falls back to the technical label). */
const PLAIN: Array<[RegExp, string]> = [
  [/^Stem-level/, 'Passed the vocals and instruments across one at a time'],
  [/^Long-form staged blend/, 'Layered the new track in step by step'],
  [/^Long phrase blend/, 'Blended smoothly across full phrases'],
  [/^Bass swap/, 'Swapped the basslines at the right moment'],
  [/^Percussion-led/, 'Brought the new drums in first'],
  [/^Drop swap/, 'Built up and dropped straight into the new track'],
  [/^Filter sweep/, 'Filtered the old track away as the new one came in'],
  [/^Acapella layer/, "Laid the new vocal over the old track's beat"],
  [/^Mashup/, "Mixed the old vocal over the new track's beat"],
  [/^Double drop/, 'Dropped both tracks together'],
  [/^Reverb wash/, 'Washed the old track out with reverb'],
  [/^Echo/, 'Echoed the old track out'],
]
const plain = (label: string) => PLAIN.find(([re]) => re.test(label))?.[1] ?? label

const minutes = (sec: number) => `${Math.round(sec / 6) / 10} min`

export function MlDiagnostics({ m }: { m: MixManifest }) {
  const asked = (m.spec as { summary?: string }).summary || m.description
  const used = new Set((m.ml?.models ?? []).filter((x) => x.used).map((x) => x.name))
  const helpers = HELPERS.filter(([k]) => used.has(k)).map(([, v]) => v)
  const previews = m.ml?.counts?.critic_scored_previews
  const [lo, hi] = m.bpmRange
  return (
    <MixDisclosure title="How the AI DJ made this mix" icon={<Sparkles className="size-4" />} testId="ml-diagnostics">
      <div className="grid max-w-prose min-w-0 gap-5 leading-relaxed [overflow-wrap:anywhere]">
        {asked && (
          <section aria-label="Your request" className="grid gap-1">
            <h3 className="font-medium text-foreground">You asked for</h3>
            <p className="text-muted-foreground">{asked}</p>
          </section>
        )}

        <section aria-label="What it did" className="grid gap-1">
          <h3 className="font-medium text-foreground">What it did</h3>
          <p className="text-muted-foreground">
            It picked {m.tracks.length} tracks ({minutes(m.durationSec)}, {Math.round(lo)}–{Math.round(hi)} BPM) and put them in an order that {CURVE[m.spec.energyCurve] ?? 'flows naturally'}. Every
            transition is beat-matched and at least 16 bars long
            {previews ? `; it test-rendered ${previews} versions of the transitions and kept the ones that sounded best` : ''}.
          </p>
        </section>

        {m.transitions.length > 0 && (
          <section aria-label="Transitions" className="grid gap-2">
            <h3 className="font-medium text-foreground">The transitions</h3>
            <ol className="grid gap-2 text-muted-foreground">
              {m.transitions.map((t) => (
                <li key={t.index}>
                  <span className="text-foreground">
                    {m.tracks[t.index]?.title ?? t.fromTitle} into {m.tracks[t.index + 1]?.title ?? t.toTitle}
                  </span>
                  <span className="block">
                    {plain(t.label)}, over {t.overlapBars} bars
                    {Math.abs(t.tempoAdjustPct) >= 0.5 ? `, with the tempo nudged ${t.tempoAdjustPct > 0 ? 'up' : 'down'} ${Math.abs(t.tempoAdjustPct).toFixed(1)}%` : ''}.
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {helpers.length > 0 && (
          <section aria-label="Models" className="grid gap-1">
            <h3 className="font-medium text-foreground">AI models that helped</h3>
            <ul className="grid gap-0.5 text-muted-foreground">
              {helpers.map((h) => (
                <li key={h}>{h}.</li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </MixDisclosure>
  )
}
