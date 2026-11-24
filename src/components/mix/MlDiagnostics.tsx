/**
 * How the AI DJ built this mix: how well it matched the request, which models did what, and the
 * decision log. Raw model internals (versions, weight hashes, timings, prediction values) sit under
 * "Technical details" so the default view stays readable.
 */
import { Activity, Check, X } from 'lucide-react'
import { MixDisclosure } from './MixDisclosure'
import type { MixManifest } from '@/mixgen/manifest'

const STAGE: Record<string, string> = { ordering: 'Track order', ranking: 'Transition ranking', automation: 'Automation', selection: 'Critic selection', planning: 'Set planning', performance: 'Long-form performance', closed_loop: 'Closed-loop evaluation', request: 'Request fidelity' }
const STAGE_ORDER = ['request', 'planning', 'ordering', 'closed_loop', 'performance', 'ranking', 'automation', 'selection']

/** What each model is, and what it does in a mix, in plain words. */
const MODEL: Record<string, { label: string; role: string }> = {
  beat_this_small0: { label: 'Beat This!', role: 'Finds beats and downbeats so tracks lock in time' },
  demucs_htdemucs: { label: 'Demucs', role: 'Splits tracks into vocals, drums, bass and other' },
  mixgraph_quality: { label: 'MixGraph', role: 'Predicts which pairs and cue points will mix well' },
  mixgraph_human_cue: { label: 'MixGraph cue prior', role: 'Suggests cue points and blend lengths a DJ would pick' },
  transitionnet: { label: 'TransitionNet v1', role: 'Shapes fader, EQ and filter moves' },
  transitionnet_v2: { label: 'TransitionNet v2', role: 'Designs long, staged transitions' },
  critic_quality: { label: 'DJCritic', role: 'Scores how good each test render sounds' },
  critic_artifact: { label: 'DJCritic artifacts', role: 'Flags clicks, gaps and other glitches in test renders' },
}

export function MlDiagnostics({ m }: { m: MixManifest }) {
  const ml = m.ml
  if (!ml) return null
  const used = ml.models.filter((x) => x.used).length
  const fid = m.requestFidelity
  const met = fid ? fid.checks.filter((c) => c.ok).length : 0
  const groups = STAGE_ORDER.map((s) => [s, ml.decisions.filter((d) => d.stage === s)] as const)
    .concat([['other', ml.decisions.filter((d) => !STAGE_ORDER.includes(d.stage))] as const])
    .filter(([, ds]) => ds.length)
  const aside = [fid ? `request ${met}/${fid.checks.length}` : null, `${used} of ${ml.models.length} models used`].filter(Boolean).join(', ')
  return (
    <MixDisclosure title="How the AI DJ built this mix" icon={<Activity className="size-4" />} testId="ml-diagnostics" aside={aside}>
      <div className="grid min-w-0 gap-6 [overflow-wrap:anywhere]">
        {fid && (
          <section aria-label="Your request" className="grid gap-2">
            <h3 className="font-medium text-foreground">Your request: {met} of {fid.checks.length} met</h3>
            <table className="w-full table-fixed text-left text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="w-6 py-1 font-normal"><span className="sr-only">Met</span></th>
                  <th className="w-[28%] py-1 pr-2 font-normal">Asked for</th>
                  <th className="w-[30%] py-1 pr-2 font-normal">Request</th>
                  <th className="py-1 font-normal">In the mix</th>
                </tr>
              </thead>
              <tbody>
                {fid.checks.map((c) => (
                  <tr key={c.field} className="border-t border-border align-top">
                    <td className="py-1.5">{c.ok ? <Check aria-label="met" className="size-3.5 text-emerald-400" /> : <X aria-label="not met" className="size-3.5 text-destructive" />}</td>
                    <td className="py-1.5 pr-2 text-foreground first-letter:uppercase">{c.field}</td>
                    <td className="py-1.5 pr-2 text-muted-foreground">{c.requested}</td>
                    <td className="py-1.5 text-muted-foreground">{c.achieved}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {fid.interpreter && (
              <p className="text-xs text-muted-foreground">
                Read by {fid.interpreter}
                {fid.corrections?.length ? `, with ${fid.corrections.length} detail${fid.corrections.length > 1 ? 's' : ''} taken straight from your wording` : ''}.
              </p>
            )}
          </section>
        )}

        <section aria-label="Models" className="grid gap-2">
          <h3 className="font-medium text-foreground">Models</h3>
          <table className="w-full table-fixed text-left text-xs">
            <tbody>
              {ml.models.map((x) => {
                const info = MODEL[x.name]
                return (
                  <tr key={x.name} className="border-t border-border align-top first:border-t-0">
                    <td className="py-2 pr-3">
                      <span className="text-foreground">{info?.label ?? x.name}</span>
                      <span className="block text-muted-foreground">{info?.role ?? x.kind}</span>
                      <span className="sr-only">{x.name}</span>
                    </td>
                    <td className={`w-24 py-2 text-right ${x.used ? 'text-emerald-400' : 'text-muted-foreground'}`}>{x.used ? 'used' : x.loaded ? 'not needed' : 'unavailable'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>

        {groups.length > 0 && (
          <section aria-label="Decisions" className="grid gap-2">
            <h3 className="font-medium text-foreground">Decisions</h3>
            <div className="grid gap-1.5">
              {groups.map(([stage, ds]) => (
                <details key={stage} className="group/stage rounded-lg bg-background/50 px-3 py-2 text-xs">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-foreground [&::-webkit-details-marker]:hidden">
                    <span>{STAGE[stage] ?? 'Other'}</span>
                    <span className="text-muted-foreground">{ds.length === 1 ? '1 decision' : `${ds.length} decisions`}</span>
                  </summary>
                  <ul className="mt-2 grid gap-1.5 text-muted-foreground">
                    {ds.map((d, i) => (
                      <li key={i}>
                        {d.pair && <span className="text-foreground">Transition {d.pair}: </span>}
                        {d.decision}
                        <span className="block text-[11px] opacity-70">by {d.model}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
            </div>
          </section>
        )}

        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground">Technical details</summary>
          <div className="mt-3 grid gap-3">
            <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-x-3 gap-y-1">
              {ml.models.map((x) => (
                <div key={x.name} className="contents">
                  <dt className="font-mono">{x.name}</dt>
                  <dd>
                    {x.kind}, {x.version ?? 'no version'}
                    {x.promoted === false ? ' (not promoted)' : ''}
                    {x.sha256 ? `, sha ${x.sha256.slice(0, 10)}` : ''}
                  </dd>
                </div>
              ))}
            </dl>
            <p>Mode: {ml.mode}. Counts: {Object.entries(ml.counts).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', ') || 'none'}.</p>
            <p>Time: {Object.entries(ml.timingsMs).map(([k, v]) => `${k.replace(/_/g, ' ')} ${Math.round(v)} ms`).join(', ')}.</p>
            {ml.fallbacks.length > 0 && (
              <div>
                <p className="text-foreground">Rule fallbacks</p>
                <ul className="mt-1 list-disc pl-5">
                  {ml.fallbacks.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="grid gap-2">
              <p className="text-foreground">Raw prediction and DSP values</p>
              {ml.decisions
                .filter((d) => Object.keys(d.prediction).length > 0 || d.dsp)
                .map((d, i) => (
                  <dl key={i} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 gap-y-0.5 border-t border-border pt-1.5 font-mono text-[11px]">
                    <dt className="col-span-2 font-sans text-foreground">{STAGE[d.stage] ?? d.stage}{d.pair ? `, transition ${d.pair}` : ''}</dt>
                    {[...Object.entries(d.prediction), ...Object.entries(d.dsp ?? {})].map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt>{k}</dt>
                        <dd className="text-foreground">{Array.isArray(v) ? v.join(', ') : v}</dd>
                      </div>
                    ))}
                  </dl>
                ))}
            </div>
          </div>
        </details>
      </div>
    </MixDisclosure>
  )
}
