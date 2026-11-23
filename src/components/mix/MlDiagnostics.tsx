/** Technical diagnostics: which learned models ran, what they predicted and what they decided (from the manifest's ML trace). */
import { Activity } from 'lucide-react'
import { MixDisclosure } from './MixDisclosure'
import type { MixManifest } from '@/mixgen/manifest'

const STAGE: Record<string, string> = { ordering: 'Track order', ranking: 'Transition ranking', automation: 'Automation', selection: 'Critic selection', planning: 'Set planning', performance: 'Long-form performance', closed_loop: 'Closed-loop evaluation' }

export function MlDiagnostics({ m }: { m: MixManifest }) {
  const ml = m.ml
  if (!ml) return null
  return (
    <MixDisclosure title={`Technical diagnostics ? ML models (${ml.mode})`} icon={<Activity className="size-4" />} testId="ml-diagnostics">
      <div className="grid min-w-0 gap-4 [overflow-wrap:anywhere]">
        <table className="w-full table-fixed text-left text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="w-[40%] py-1 pr-2 font-medium md:w-[22%]">Model</th>
              <th className="hidden w-[29%] py-1 pr-2 font-medium md:table-cell">Type</th>
              <th className="w-[30%] py-1 pr-2 font-medium md:w-[19%]">Version</th>
              <th className="hidden w-[13%] py-1 pr-2 font-medium md:table-cell">Weights</th>
              <th className="py-1 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {ml.models.map((x) => (
              <tr key={x.name} className="border-t border-border align-top">
                <td className="py-2 pr-2 text-foreground">
                  {x.name}
                  <span className="mt-1 block text-muted-foreground md:hidden">{x.kind}</span>
                  {x.sha256 && <span className="mt-1 block font-mono text-muted-foreground md:hidden">SHA {x.sha256.slice(0, 10)}</span>}
                </td>
                <td className="hidden py-2 pr-2 text-muted-foreground md:table-cell">{x.kind}</td>
                <td className="py-2 pr-2 text-muted-foreground">{x.version ?? '—'}{x.promoted === false ? ' (not promoted)' : ''}</td>
                <td className="hidden py-2 pr-2 font-mono text-muted-foreground md:table-cell">{x.sha256 ? x.sha256.slice(0, 10) : '—'}</td>
                <td className={`py-1 ${x.used ? 'text-emerald-400' : x.loaded ? 'text-amber-400' : 'text-muted-foreground'}`}>{x.used ? 'used' : x.loaded ? 'loaded, not used' : 'not loaded'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-muted-foreground">
          Counts: {Object.entries(ml.counts).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(' · ') || 'none'}. Time:{' '}
          {Object.entries(ml.timingsMs).map(([k, v]) => `${k} ${Math.round(v)} ms`).join(' · ')}.
        </p>
        {ml.fallbacks.length > 0 && (
          <div>
            <p className="font-medium text-foreground">Fallbacks (rules used)</p>
            <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
              {ml.fallbacks.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <p className="font-medium text-foreground">Decisions (model → prediction → decision → DSP)</p>
          <ol className="mt-1 grid gap-2 text-xs">
            {ml.decisions.map((d, i) => (
              <li key={i} className="rounded-lg border border-border p-2">
                <p className="text-foreground">
                  <span className="text-primary">{STAGE[d.stage] ?? d.stage}</span>
                  {d.pair ? ` · transition ${d.pair}` : ''} · {d.model}
                </p>
                <p className="text-muted-foreground">{d.decision}</p>
                {(Object.keys(d.prediction).length > 0 || d.dsp) && (
                  <details className="mt-2 rounded-md bg-background/65 px-2 py-1.5">
                    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Prediction and DSP values</summary>
                    {([['Prediction', d.prediction], ['DSP', d.dsp]] as const).map(([label, values]) => {
                      const entries = Object.entries(values ?? {})
                      if (!entries.length) return null
                      return (
                        <div key={label} className="mt-2">
                          <p className="mb-1 font-medium text-muted-foreground">{label}</p>
                          <dl className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 gap-y-1.5 font-mono text-[11px]">
                            {entries.map(([key, value]) => (
                              <div key={key} className="contents">
                                <dt className="text-muted-foreground">{key}</dt>
                                <dd className="text-foreground">{Array.isArray(value) ? value.join(', ') : value}</dd>
                              </div>
                            ))}
                          </dl>
                        </div>
                      )
                    })}
                  </details>
                )}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </MixDisclosure>
  )
}
