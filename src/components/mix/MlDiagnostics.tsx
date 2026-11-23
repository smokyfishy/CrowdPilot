/** Technical diagnostics: which learned models ran, what they predicted and what they decided (from the manifest's ML trace). */
import type { MixManifest } from '@/mixgen/manifest'

const STAGE: Record<string, string> = { ordering: 'Track order', ranking: 'Transition ranking', automation: 'Automation', selection: 'Critic selection' }

export function MlDiagnostics({ m }: { m: MixManifest }) {
  const ml = m.ml
  if (!ml) return null
  return (
    <details className="rounded-xl border border-border p-4 text-sm" data-testid="ml-diagnostics">
      <summary className="cursor-pointer font-medium text-foreground">Technical diagnostics — ML models ({ml.mode})</summary>
      <div className="mt-3 grid gap-4">
        <table className="w-full text-left text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 pr-3 font-medium">Model</th>
              <th className="py-1 pr-3 font-medium">Type</th>
              <th className="py-1 pr-3 font-medium">Version</th>
              <th className="py-1 pr-3 font-medium">Weights</th>
              <th className="py-1 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {ml.models.map((x) => (
              <tr key={x.name} className="border-t border-border">
                <td className="py-1 pr-3 text-foreground">{x.name}</td>
                <td className="py-1 pr-3 text-muted-foreground">{x.kind}</td>
                <td className="py-1 pr-3 text-muted-foreground">{x.version ?? '—'}{x.promoted === false ? ' (not promoted)' : ''}</td>
                <td className="py-1 pr-3 font-mono text-muted-foreground">{x.sha256 ? x.sha256.slice(0, 10) : '—'}</td>
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
                {Object.keys(d.prediction).length > 0 && <p className="font-mono text-[11px] text-muted-foreground">prediction {JSON.stringify(d.prediction)}</p>}
                {d.dsp && <p className="font-mono text-[11px] text-muted-foreground">dsp {JSON.stringify(d.dsp)}</p>}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </details>
  )
}
