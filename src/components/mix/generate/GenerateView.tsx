/**
 * Generate: CrowdPilot building the set. Everything shown is driven by the job's real progress
 * events (summarizeProgress maps the pipeline's stages onto four listener-facing phases and one
 * overall fraction from real done/total counts). The spinning platter is a loading treatment
 * only — it echoes the decks on the Listen page and carries no data.
 */
import { ChevronDown } from 'lucide-react'
import { PHASES, summarizeProgress } from '../generation-progress'
import { specFacts } from '../labels'
import type { MixData, useMixJob } from '../useMixJob'
import { STAGES, STAGE_LABEL } from '@/mixgen/types'
import type { SelectionRow } from '@/mixgen/browser/job'
import './generate.css'

type Job = ReturnType<typeof useMixJob>

export function GenerateView({ job, data }: { job: Job; data: MixData }) {
  const p = summarizeProgress({ stage: job.stage, events: job.events, pass: job.pass })
  const phase = PHASES[Math.max(0, p.phase)]
  const facts = specFacts(data.spec)
  const selected = job.selection.filter((r: SelectionRow) => r.selected).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  const render = job.events.rendering
  const rendering = p.stage === 'rendering'
  const pct = Math.round(p.overall * 100)
  const active = job.running || job.resuming
  return (
    <section className="grid gap-10" aria-labelledby="gen-title" data-testid="mix-generating">
      <div className="grid items-center gap-8 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] md:gap-12">
        <div className="gen-platter mx-auto w-44 md:w-full" data-spin={active ? '1' : '0'} aria-hidden>
          <div className="gen-vinyl">
            <div className="gen-label">
              {selected[0]?.artwork ? <img src={selected[0].artwork} alt="" className="size-full rounded-full object-cover" /> : null}
            </div>
          </div>
        </div>
        <div className="grid min-w-0 gap-6">
          <header className="grid gap-2">
            <h1 id="gen-title" className="font-display text-[clamp(2.25rem,5.5vw,3.75rem)] leading-[0.95] text-foreground">{data.title}</h1>
            <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
              {facts.map((f) => (
                <span key={f}>{f}</span>
              ))}
            </p>
          </header>

          <ol className="grid grid-cols-4 gap-2" aria-label="Progress">
            {PHASES.map((ph, i) => {
              const done = i < p.phase || p.stage === 'ready'
              const now = i === p.phase && p.stage !== 'ready'
              return (
                <li key={ph.id} className="grid gap-2" aria-current={now ? 'step' : undefined}>
                  <span className={`h-0.5 rounded-full ${done ? 'bg-foreground/70' : now ? 'bg-primary' : 'bg-muted'}`} />
                  <span className={`text-xs ${now ? 'text-foreground' : done ? 'text-muted-foreground' : 'text-muted-foreground/60'}`}>
                    {done && <span className="sr-only">Done: </span>}
                    {ph.short}
                  </span>
                </li>
              )
            })}
          </ol>

          <div className="grid gap-3" aria-live="polite">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="text-xl font-semibold text-foreground">{p.stage === 'ready' ? 'Ready' : phase.label}</h2>
              <span className="text-sm tabular-nums text-muted-foreground">{pct}%</span>
            </div>
            <div className="relative h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Overall progress">
              <div className="absolute inset-y-0 left-0 rounded-full bg-primary transition-[width] duration-700 ease-out" style={{ width: `${Math.max(2, pct)}%` }} />
              {active && <div className="gen-sheen absolute inset-y-0 w-1/4" />}
            </div>
            <p className="text-sm text-foreground">
              {p.message}
              {rendering && render && render.total > 1 && <span className="text-muted-foreground"> Track {Math.min(render.total, render.done + 1)} of {render.total}.</span>}
            </p>
            {rendering && (
              <p className="max-w-[60ch] text-sm text-muted-foreground">
                This is the real audio being made: every transition is beat-matched, EQ'd and recorded into one continuous mix, not a playlist.
              </p>
            )}
          </div>

          <p className="max-w-[62ch] text-xs leading-relaxed text-muted-foreground">
            {active
              ? 'Your mix is being made in this browser tab. You can visit other CrowdPilot pages while it works; if you close the tab, it pauses and picks up again when you reopen this mix — analyzed tracks are kept, discovery and downloads run again.'
              : 'Your mix is made in the browser tab that started it.'}
          </p>
        </div>
      </div>

      {selected.length > 0 && (
        <section aria-labelledby="gen-tracks" className="grid gap-3">
          <h2 id="gen-tracks" className="text-sm text-muted-foreground">
            {selected.length} tracks chosen
          </h2>
          <ol className="gen-tracks">
            {selected.map((r: SelectionRow, i: number) => (
              <li key={r.trackKey} className="grid gap-1.5" style={{ animationDelay: `${Math.min(i, 12) * 40}ms` }}>
                <span className="aspect-square w-full rounded-md bg-muted bg-cover bg-center shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]" style={r.artwork ? { backgroundImage: `url("${r.artwork}")` } : undefined} aria-hidden />
                <span className="truncate text-xs text-foreground">{r.title}</span>
                <span className="-mt-1 truncate text-[11px] text-muted-foreground">{r.artist}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="grid gap-2">
        <details className="group rounded-xl bg-card px-5 py-3.5">
          <summary className="flex cursor-pointer list-none items-center justify-between text-sm text-foreground">
            Your mix description
            <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
          </summary>
          <p className="mt-3 max-w-[75ch] text-sm text-muted-foreground">{data.editPrompt ? `Edit: “${data.editPrompt}”` : data.prompt}</p>
        </details>
        <details className="group rounded-xl bg-card px-5 py-3.5">
          <summary className="flex cursor-pointer list-none items-center justify-between text-sm text-foreground">
            View technical details
            <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
          </summary>
          <ol className="mt-3 grid gap-1 text-xs text-muted-foreground" data-testid="mix-progress">
            {STAGES.map((s) => {
              const e = job.events[s]
              const cur = s === p.stage
              return (
                <li key={s} className={`grid grid-cols-[1rem_11rem_minmax(0,1fr)] gap-2 ${cur ? 'text-foreground' : ''}`}>
                  <span aria-hidden>{e && e.total > 0 && e.done >= e.total ? '✓' : cur ? '•' : ''}</span>
                  <span>{STAGE_LABEL[s]}</span>
                  <span className="truncate tabular-nums">
                    {e && e.total > 1 ? `${e.done}/${e.total} ` : ''}
                    {e?.detail ?? ''}
                  </span>
                </li>
              )
            })}
          </ol>
        </details>
      </div>
    </section>
  )
}
