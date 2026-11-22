/** Transition inspector: every value and curve comes from the renderer's manifest. */
import type { ManifestCurve, ManifestTransition } from '@/mixgen/manifest'
import { fmtTime } from './MixPlayer'

function Curve({ c, color, db, total, label }: { c?: ManifestCurve; color: string; db?: boolean; total: number; label: string }) {
  if (!c || !c.t.length) return null
  const W = 300
  const H = 56
  const y = (v: number) => (db ? H - 4 - ((Math.max(-40, Math.min(6, v)) + 40) / 46) * (H - 8) : H - 4 - Math.max(0, Math.min(1, v)) * (H - 8))
  const xs = (t: number) => (total > 0 ? (t / total) * W : 0)
  const d = c.t.map((t, i) => `${i ? 'L' : 'M'}${xs(t).toFixed(1)},${y(c.v[i]).toFixed(1)}`).join(' ')
  return (
    <figure className="grid gap-1">
      <figcaption className="text-xs text-muted-foreground">{label}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-14 w-full rounded bg-[#171513]" role="img" aria-label={label}>
        <path d={d} fill="none" stroke={color} strokeWidth={1.75} />
      </svg>
    </figure>
  )
}

export function TransitionInspector({ t, onClose, onSeek }: { t: ManifestTransition; onClose: () => void; onSeek: (s: number) => void }) {
  const total = Math.max(t.overlapSec, ...t.curves.out.gain.t, ...t.curves.in.gain.t, 0.5)
  const rows: Array<[string, string]> = [
    ['Technique', t.label],
    ['Starts at', `${fmtTime(t.mixStartSec)} (mix)`],
    ['Overlap', `${t.overlapBars} bars · ${t.overlapSec.toFixed(1)} s`],
    ['Outgoing cue', `${t.outCueSec.toFixed(2)} s into the outgoing track`],
    ['Incoming cue', `${t.inCueSec.toFixed(2)} s into the incoming track`],
    ['Tempo adjustment', t.tempoAdjustPct === 0 ? 'none' : `${t.tempoAdjustPct > 0 ? '+' : ''}${t.tempoAdjustPct}% (pitch preserved), back to original over ${t.tempoRecoverySec} s`],
    ['Beat alignment', `splice refined ${t.beatAlignment.spliceLagMs} ms (correlation ${t.beatAlignment.spliceCorrelation}); beat-grid confidence ${t.beatAlignment.outBpmConf} → ${t.beatAlignment.inBpmConf}; downbeat ${t.beatAlignment.outDownbeatConf} → ${t.beatAlignment.inDownbeatConf}`],
  ]
  return (
    <section aria-label="Transition details" className="grid gap-4 rounded-xl border border-primary/40 bg-card p-4" data-testid="transition-inspector">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.14em] text-primary">Transition {t.index + 1}</p>
          <h3 className="font-semibold text-foreground">
            {t.fromTitle} → {t.toTitle}
          </h3>
        </div>
        <div className="flex gap-2">
          <button type="button" className="rounded-full border border-border px-3 py-1 text-sm hover:bg-accent" onClick={() => onSeek(Math.max(0, t.mixStartSec - 8))}>
            Listen
          </button>
          <button type="button" className="rounded-full border border-border px-3 py-1 text-sm hover:bg-accent" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[10rem_1fr]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="text-foreground">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-2">
          <p className="text-sm font-medium text-foreground">Outgoing deck</p>
          <Curve c={t.curves.out.gain} color="#e8d3a8" total={total} label="Fader (gain 0–1)" />
          <Curve c={t.curves.out.low} color="#c9842e" db total={total} label="Low EQ (dB)" />
          <Curve c={t.curves.out.mid} color="#7f9c8a" db total={total} label="Mid EQ (dB)" />
          <Curve c={t.curves.out.high} color="#8a87b8" db total={total} label="High EQ (dB)" />
          <Curve c={t.curves.out.filter} color="#b5654a" total={total} label="Filter knob (−1 LP … +1 HP)" />
          <Curve c={t.curves.echoSend} color="#c2a35a" total={total} label="Echo send" />
        </div>
        <div className="grid gap-2">
          <p className="text-sm font-medium text-foreground">Incoming deck</p>
          <Curve c={t.curves.in.gain} color="#e8d3a8" total={total} label="Fader (gain 0–1)" />
          <Curve c={t.curves.in.low} color="#c9842e" db total={total} label="Low EQ (dB)" />
          <Curve c={t.curves.in.mid} color="#7f9c8a" db total={total} label="Mid EQ (dB)" />
          <Curve c={t.curves.in.high} color="#8a87b8" db total={total} label="High EQ (dB)" />
          <Curve c={t.curves.in.filter} color="#b5654a" total={total} label="Filter knob (−1 LP … +1 HP)" />
        </div>
      </div>
      {t.effects.length > 0 && (
        <div className="text-sm">
          <p className="font-medium text-foreground">Effect timing</p>
          <ul className="mt-1 grid gap-0.5 text-muted-foreground">
            {t.effects.map((e, i) => (
              <li key={i}>
                {fmtTime(e.startSec)}–{fmtTime(e.endSec)} · {e.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid gap-1 text-sm text-muted-foreground">
        {t.reasons.length > 0 && <p>Why: {t.reasons.join('; ')}</p>}
        {t.risks.length > 0 && <p>Risks noted by the planner: {t.risks.join('; ')}</p>}
      </div>
    </section>
  )
}
