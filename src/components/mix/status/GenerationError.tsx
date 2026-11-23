/** Failure state: plain-language cause, what to do, a retry and a way back. */
import { Link } from 'react-router-dom'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui'
import { friendlyError } from '../generation-progress'

export function GenerationError({ error, onRetry, prepared }: { error: string; onRetry: () => void; prepared: boolean }) {
  const f = friendlyError(error)
  return (
    <div role="alert" className="grid gap-4 rounded-2xl border border-destructive/30 bg-destructive/[0.06] p-5 sm:p-6" data-testid="mix-error">
      <div className="flex items-start gap-3">
        <AlertTriangle aria-hidden className="mt-0.5 size-5 shrink-0 text-destructive" />
        <div className="grid gap-1">
          <p className="font-semibold text-foreground">{f.title}</p>
          <p className="text-sm text-muted-foreground">{f.hint}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:pl-8">
        {f.retryable && (
          <Button onClick={onRetry} data-testid="mix-retry">
            {prepared ? 'Retry mixing' : 'Try again'}
          </Button>
        )}
        <Link to="/mix" className="inline-flex h-10 items-center rounded-full px-4 text-sm font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
          Start a new mix
        </Link>
      </div>
    </div>
  )
}
