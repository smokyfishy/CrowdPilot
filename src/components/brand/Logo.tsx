import { cn } from '@/lib/utils'

/** Wordmark: the label of a record (amber disc with a spindle hole) beside the name in the display serif. */
export function Logo({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2 text-foreground', className)}>
      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5 shrink-0">
        <circle cx="12" cy="12" r="11" fill="currentColor" opacity="0.14" />
        <circle cx="12" cy="12" r="6.5" fill="var(--color-primary)" />
        <circle cx="12" cy="12" r="1.6" fill="var(--color-background)" />
      </svg>
      {!compact && <span className="font-display text-[1.45rem] leading-none tracking-[-0.01em]">CrowdPilot</span>}
    </span>
  )
}
