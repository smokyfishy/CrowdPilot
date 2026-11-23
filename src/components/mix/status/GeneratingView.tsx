/**
 * The active-generation screen: mix title + compact facts, a record platter, the active stage and overall progress, a four-stage
 * stepper, honest tab-dependence copy, and progressively disclosed details.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { Check, Info } from 'lucide-react'
import type { SelectionRow } from '@/mixgen/browser/job'
import { PHASES, summarizeProgress, type Pass, type StageEvents } from '../generation-progress'
import { GenerationPlatter } from '../generate/GenerationPlatter'
import { SelectedTracks } from './SelectedTracks'
import { TechnicalDetails } from './TechnicalDetails'

function Stepper({ phase, done }: { phase: number; done: boolean }) {
  return (
    <ol className="grid grid-cols-4 gap-2" aria-label="Generation stages">
      {PHASES.map((p, i) => {
        const complete = done || i < phase
        const active = !done && i === phase
        return (
          <li key={p.id} className="grid justify-items-center gap-2 text-center" aria-current={active ? 'step' : undefined}>
            <span className="relative flex w-full items-center">
              <span className={`h-px flex-1 ${i === 0 ? 'opacity-0' : complete || active ? 'bg-primary/60' : 'bg-border'}`} />
              <span
                className={`grid size-6 shrink-0 place-items-center rounded-full border text-[10px] transition-colors duration-500 ${
                  complete ? 'border-primary bg-primary text-primary-foreground' : active ? 'border-primary text-primary ring-4 ring-primary/15' : 'border-border text-muted-foreground'
                }`}
              >
                {complete ? <Check className="size-3.5" strokeWidth={3} /> : active ? <span className="size-1.5 rounded-full bg-primary motion-safe:animate-pulse" /> : null}
              </span>
              <span className={`h-px flex-1 ${i === PHASES.length - 1 ? 'opacity-0' : complete ? 'bg-primary/60' : 'bg-border'}`} />
            </span>
            <span className={`text-[11px] leading-tight sm:text-xs ${active ? 'font-semibold text-foreground' : complete ? 'text-foreground/80' : 'text-muted-foreground'}`}>
              <span className="sr-only">{complete ? 'Completed: ' : active ? 'In progress: ' : 'Upcoming: '}</span>
              {p.short}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

export function Disclosure({ summary, children, testId }: { summary: string; children: ReactNode; testId?: string }) {
  return (
    <details className="group text-sm" data-testid={testId}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="text-xs transition-transform group-open:rotate-90">▸</span>
        {summary}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  )
}

export interface GeneratingViewProps {
  title: string
  facts: string[]
  prompt: string
  editPrompt?: string
  events: StageEvents
  stage?: string
  pass: Pass
  running: boolean
  resuming: boolean
  selection: SelectionRow[]
  notice?: ReactNode
}

export function GeneratingView({ title, facts, prompt, editPrompt, events, stage, pass, running, resuming, selection, notice }: GeneratingViewProps) {
  const s = summarizeProgress({ stage, events, pass })
  // Within one pass the shown value never decreases (a stage's total can grow as candidates are added).
  const max = useRef({ pass, v: 0 })
  if (max.current.pass !== pass) max.current = { pass, v: 0 }
  max.current.v = Math.max(max.current.v, s.overall)
  const overall = max.current.v
  const pct = Math.round(overall * 100)
  const message = resuming ? 'Picking up where this mix left off…' : s.message
  const phase = PHASES[s.phase]

  const live = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    // keep the announced region in sync without re-announcing every percent
    if (live.current) live.current.textContent = `${phase.label}. ${message}`
  }, [phase.label, message])

  return (
    <section className="mx-auto grid w-full max-w-2xl gap-8" aria-labelledby="mix-title" data-testid="mix-generating">
      <header className="grid gap-2 text-center">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">{editPrompt ? 'New version' : 'New mix'}</p>
        <h1 id="mix-title" className="text-balance font-display text-[clamp(2rem,6vw,3.25rem)] leading-[1.02] text-foreground">
          {title}
        </h1>
        <p className="text-sm text-muted-foreground">{facts.join(' · ')}</p>
      </header>

      <div className="grid gap-6 rounded-2xl border border-border bg-gradient-to-b from-card to-card/40 px-5 py-7 sm:px-8">
        <GenerationPlatter active={!notice && (running || resuming)} artwork={selection.find((row) => row.selected && row.position === 0)?.artwork} />

        <div className="grid gap-3">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="font-semibold text-foreground">{phase.label}</h2>
            <span className="text-sm tabular-nums text-muted-foreground" aria-hidden>
              {pct}%
            </span>
          </div>
          <p className="min-h-[1.5em] text-sm text-muted-foreground" data-testid="mix-status">
            {message}
          </p>
          <div className="relative h-1.5 overflow-hidden rounded-full bg-foreground/10" role="progressbar" aria-label="Overall progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <div className="h-full rounded-full bg-primary transition-[width] duration-700 ease-out" style={{ width: `${Math.max(2, pct)}%` }} />
            {(running || resuming) && <div aria-hidden className="absolute inset-y-0 left-0 w-1/4 bg-gradient-to-r from-transparent via-white/25 to-transparent motion-safe:animate-[bar-sheen_2.2s_ease-in-out_infinite]" />}
          </div>
          <p ref={live} className="sr-only" aria-live="polite" />
        </div>

        <Stepper phase={s.phase} done={s.stage === 'ready'} />
      </div>

      {notice ?? (
        <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Your mix is being created right here in this browser tab. You can browse other CrowdPilot pages, but closing or reloading this tab pauses it. Reopening the mix resumes it and reuses the tracks already analyzed.
          </span>
        </p>
      )}

      <div className="grid gap-4 border-t border-border pt-5">
        {selection.some((r) => r.selected) && (
          <div className="grid gap-2">
            <h3 className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Your tracks</h3>
            <SelectedTracks rows={selection} />
          </div>
        )}
        <Disclosure summary="Your mix description" testId="mix-description">
          <p className="max-w-[65ch] whitespace-pre-line text-muted-foreground">{editPrompt ? `${prompt}\n\nChange: “${editPrompt}”` : prompt}</p>
        </Disclosure>
        <TechnicalDetails events={events} stage={stage} pass={pass} extra={[['Overall', `${(s.overall * 100).toFixed(1)}%`]]} />
      </div>
    </section>
  )
}
