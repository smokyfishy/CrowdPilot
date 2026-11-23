import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

export function MixDisclosure({ title, icon, children, testId }: { title: string; icon: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <details className="group/disclosure min-w-0 rounded-xl border border-border bg-card text-sm" data-testid={testId}>
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 rounded-xl px-3 py-2 text-foreground transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">{icon}</span>
        <span className="min-w-0 flex-1 font-medium">{title}</span>
        <ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-open/disclosure:rotate-180" />
      </summary>
      <div className="min-w-0 border-t border-border px-3 py-4 sm:px-4">{children}</div>
    </details>
  )
}
