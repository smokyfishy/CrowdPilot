/** The four-step flow, highlighted from the mix's real status. */
const STEPS = ['Describe', 'Discover', 'Generate', 'Listen'] as const

export function stepFor(status?: string): number {
  switch (status) {
    case undefined:
    case 'draft':
      return 0
    case 'working':
    case 'review':
      return 1
    case 'rendering':
      return 2
    case 'ready':
      return 3
    default:
      return 1
  }
}

export function MixSteps({ current, failed }: { current: number; failed?: boolean }) {
  return (
    <ol className="flex flex-wrap items-center gap-2 text-sm" aria-label="Progress" data-testid="mix-steps">
      {STEPS.map((s, i) => {
        const done = i < current
        const active = i === current
        return (
          <li key={s} className="flex items-center gap-2" aria-current={active ? 'step' : undefined}>
            <span
              className={`grid size-6 place-items-center rounded-full text-xs font-semibold ${
                active ? (failed ? 'bg-destructive text-white' : 'bg-primary text-primary-foreground') : done ? 'bg-primary/25 text-primary' : 'border border-border text-muted-foreground'
              }`}
            >
              {done ? '✓' : i + 1}
            </span>
            <span className={active ? 'font-semibold text-foreground' : done ? 'text-foreground' : 'text-muted-foreground'}>{s}</span>
            {i < STEPS.length - 1 && <span aria-hidden className="mx-1 h-px w-6 bg-border" />}
          </li>
        )
      })}
    </ol>
  )
}
