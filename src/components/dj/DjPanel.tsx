/**
 * Host AI DJ console. Shows only measured values from the host's own analysis,
 * with confidence flags; the transition card lists the planner's cost components,
 * risks and alternatives, and lets the host override before (and until) commit.
 */
import { useEffect, useState } from 'react'
import { Button, Switch } from '@/components/ui'
import type { FeatureRow } from '@/client/dj-hooks'
import type { DjState, QueueItem } from '@/domain/types'
import { audioKeyOf, type HostDj, type HostDjSnapshot } from '@/dj/engine/host-dj'
import { STYLE_LABEL, type TransitionPlan, type TransitionStyle } from '@/dj/transitions'
import type { RoomCommand } from '@/server/commands'
import { cn } from '@/lib/utils'
import { WaveformView } from './WaveformView'

type Run = (cmd: RoomCommand) => Promise<unknown>

interface Props {
  dj: DjState
  hostDj: HostDj | null
  nowPlaying?: QueueItem
  upNext: QueueItem[]
  features: Map<string, FeatureRow>
  run: Run
}

function useSnapshot(hostDj: HostDj | null): HostDjSnapshot | null {
  const [snap, setSnap] = useState<HostDjSnapshot | null>(null)
  useEffect(() => {
    if (!hostDj) return
    const id = setInterval(() => setSnap(hostDj.snapshot()), 400)
    return () => clearInterval(id)
  }, [hostDj])
  return hostDj ? snap : null
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

function AnalysisLine({ item, feature, live }: { item?: QueueItem; feature?: FeatureRow; live?: HostDjSnapshot['analyses'][string] }) {
  if (!item) return <p className="text-sm text-muted-foreground">—</p>
  const key = audioKeyOf(item)
  if (!key) return <p className="text-sm text-muted-foreground">YouTube embed: standard playback only (no audio access, nothing to analyze).</p>
  const s = live?.summary ?? feature?.summary ?? undefined
  const status = live?.status ?? feature?.status
  if (status === 'analyzing') return <p className="text-sm text-muted-foreground">Analyzing the authorized audio…</p>
  if (status === 'failed') return <p className="text-sm text-destructive">Analysis failed: {live?.error ?? feature?.failure}</p>
  if (!s) return <p className="text-sm text-muted-foreground">Will analyze when loaded.</p>
  return (
    <dl className="grid grid-cols-3 gap-x-3 gap-y-0.5 text-xs tabular-nums">
      <dt className="text-muted-foreground">Tempo</dt>
      <dd className="col-span-2">
        {s.bpm.toFixed(2)} BPM <span className={s.bpmConf < 0.5 ? 'text-warning' : 'text-muted-foreground'}>(conf {Math.round(s.bpmConf * 100)}%{s.stable ? '' : ', drifting'})</span>
      </dd>
      <dt className="text-muted-foreground">Key</dt>
      <dd className="col-span-2">
        {s.key} · {s.camelot} <span className={s.keyConf < 0.2 ? 'text-warning' : 'text-muted-foreground'}>(conf {Math.round(s.keyConf * 100)}%)</span>
      </dd>
      <dt className="text-muted-foreground">Loudness</dt>
      <dd className="col-span-2">
        {s.lufs.toFixed(1)} LUFS · TP {s.truePeak.toFixed(1)} dBTP
      </dd>
      <dt className="text-muted-foreground">Structure</dt>
      <dd className="col-span-2">
        intro {s.introBars} bars · outro {s.outroBars} bars · downbeat conf {Math.round(s.downbeatConf * 100)}%
      </dd>
      {s.flags.length > 0 && (
        <>
          <dt className="text-muted-foreground">Flags</dt>
          <dd className="col-span-2 text-warning">{s.flags.join('; ')}</dd>
        </>
      )}
      {live?.ms !== undefined && (
        <>
          <dt className="text-muted-foreground">Analysis</dt>
          <dd className="col-span-2 text-muted-foreground">{(live.ms / 1000).toFixed(1)} s on this device ({s.v})</dd>
        </>
      )}
    </dl>
  )
}

function TransitionCard({ plan, startsInSec, committed, alternatives, onOverride }: { plan: TransitionPlan; startsInSec: number; committed: boolean; alternatives: TransitionPlan[]; onOverride: (k: 'mix_now' | 'skip' | 'style', s?: TransitionStyle) => void }) {
  const costs = Object.entries(plan.costs).filter(([k]) => k !== 'total')
  return (
    <div className={cn('grid gap-2 rounded-lg border p-3', committed ? 'border-primary' : 'border-border')}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-medium text-foreground">
          {STYLE_LABEL[plan.style]} · {plan.overlapBars} bars
        </p>
        <p className="text-xs tabular-nums text-muted-foreground">{committed ? 'committed' : 'proposed'} · starts in {Math.max(0, Math.round(startsInSec))} s</p>
      </div>
      <p className="text-xs text-muted-foreground tabular-nums">
        out at {fmt(plan.outCueSec)} → in at {fmt(plan.inCueSec)} · tempo {((plan.tempoRatio - 1) * 100).toFixed(1)}% (pitch preserved)
      </p>
      {plan.reasons.length > 0 && <p className="text-xs text-foreground">{plan.reasons.join(' · ')}</p>}
      {plan.risks.length > 0 && <p className="text-xs text-warning">Risks: {plan.risks.join(' · ')}</p>}
      <div className="grid grid-cols-4 gap-1 text-[10px] tabular-nums text-muted-foreground" aria-label="Planner cost components (lower is better)">
        {costs.map(([k, v]) => (
          <span key={k}>
            {k} {v.toFixed(2)}
          </span>
        ))}
        <span className="font-semibold text-foreground">total {plan.costs.total.toFixed(2)}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {!committed && (
          <Button size="sm" variant="outline" onClick={() => onOverride('mix_now')}>
            Mix at next phrase
          </Button>
        )}
        {alternatives.map((a) => (
          <Button key={a.style} size="sm" variant="ghost" onClick={() => onOverride('style', a.style)}>
            {STYLE_LABEL[a.style]} ({a.costs.total.toFixed(1)})
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={() => onOverride('skip')}>
          No mix (standard)
        </Button>
      </div>
    </div>
  )
}

export function DjPanel({ dj, hostDj, nowPlaying, upNext, features, run }: Props) {
  const snap = useSnapshot(hostDj)
  const next = upNext[0]
  const curKey = nowPlaying ? audioKeyOf(nowPlaying) : null
  const nextKey = next ? audioKeyOf(next) : null
  const set = (patch: Extract<RoomCommand, { type: 'djSettings' }>['patch']) => void run({ type: 'djSettings', patch })
  const plan = snap?.committed?.plan ?? snap?.proposal?.plan
  return (
    <section aria-label="AI DJ" className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-2xl text-foreground">AI DJ</h2>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={dj.autopilot} onCheckedChange={(v: boolean) => set({ autopilot: v })} aria-label="Autopilot" />
          Autopilot
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <label className="flex items-center gap-1.5">
          Style
          <select className="rounded border border-input bg-background px-1.5 py-1 text-foreground" value={dj.style} onChange={(e) => set({ style: e.target.value as DjState['style'] })}>
            <option value="balanced">Balanced</option>
            <option value="smooth">Smooth</option>
            <option value="energetic">Energetic</option>
            <option value="creative">Creative</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          Tempo ±
          <select className="rounded border border-input bg-background px-1.5 py-1 text-foreground" value={dj.maxTempoPct} onChange={(e) => set({ maxTempoPct: Number(e.target.value) })}>
            {[0, 2, 4, 6].map((v) => (
              <option key={v} value={v}>
                {v}%
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <Switch checked={dj.aiReorder} onCheckedChange={(v: boolean) => set({ aiReorder: v })} aria-label="AI reordering of unlocked requests" />
          AI picks next (unlocked only)
        </label>
        <label className="flex items-center gap-1.5" title="Covers Audius uploads streamed only under the Open Music License and Jamendo tracks with no-derivatives (ND) or unknown licences: whether live mixing is permitted needs a human rights review.">
          <Switch checked={dj.allowOmlMixing} onCheckedChange={(v: boolean) => set({ allowOmlMixing: v })} aria-label="Mix tracks whose licence needs rights review" />
          Mix tracks pending rights review
        </label>
      </div>

      <div className="grid gap-1.5">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Now · {nowPlaying?.title ?? 'nothing'}</p>
        {curKey && <WaveformView label="Current track waveform with measured beat grid" analysis={hostDj?.analysisFor(curKey)} positionSec={snap?.positionSec} cueOutSec={plan?.outCueSec} />}
        <AnalysisLine item={nowPlaying} feature={curKey ? features.get(curKey) : undefined} live={curKey ? snap?.analyses[curKey] : undefined} />
      </div>
      <div className="grid gap-1.5">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Next · {next?.title ?? 'nothing queued'}</p>
        {nextKey && <WaveformView label="Next track waveform with measured beat grid" analysis={hostDj?.analysisFor(nextKey)} cueInSec={plan?.inCueSec} height={44} />}
        <AnalysisLine item={next} feature={nextKey ? features.get(nextKey) : undefined} live={nextKey ? snap?.analyses[nextKey] : undefined} />
      </div>

      {plan && snap && (
        <TransitionCard
          plan={plan}
          startsInSec={snap.committed?.startsInSec ?? snap.proposal?.startsInSec ?? 0}
          committed={!!snap.committed}
          alternatives={snap.committed ? [] : snap.proposal?.alternatives ?? []}
          onOverride={(k, s) => hostDj?.overrideNext(k, s)}
        />
      )}
      {snap && !plan && dj.autopilot && snap.note && <p className="text-sm text-muted-foreground">{snap.note}</p>}
      {!hostDj && <p className="text-sm text-muted-foreground">The AI DJ runs on the device that plays the music.</p>}
      {snap && hostDj && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground" aria-label="Learned DJ models">
          <span>Learned DJ</span>
          {(['promoted', 'experimental', 'off'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => void hostDj.setMlMode(m)}
              className={cn('rounded-full border px-2 py-0.5', snap.ml.mode === m ? 'border-primary text-foreground' : 'border-border')}
              aria-pressed={snap.ml.mode === m}
            >
              {m === 'promoted' ? 'validated' : m}
            </button>
          ))}
          <span>
            {[snap.ml.active.mixgraph && 'MixGraph', snap.ml.active.transitionNet && 'TransitionNet', snap.ml.active.critic && 'DJCritic'].filter(Boolean).join(' · ') || 'rules only'}
            {snap.ml.last ? ` — ${snap.ml.last}` : ''}
          </span>
        </div>
      )}
      {snap && (
        <p className="text-[11px] tabular-nums text-muted-foreground" aria-label="Master output meter">
          Output peak {Number.isFinite(snap.meter.peakDb) ? snap.meter.peakDb.toFixed(1) : '−∞'} dBFS · RMS {Number.isFinite(snap.meter.rmsDb) ? snap.meter.rmsDb.toFixed(1) : '−∞'} dB · limiter ceiling −1 dB
          {snap.meter.clipCount > 0 ? ` · ${snap.meter.clipCount} clip events` : ''}
        </p>
      )}
    </section>
  )
}
