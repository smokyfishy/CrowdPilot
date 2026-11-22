import { cn } from '@/lib/utils'

/** Loading placeholder. Pulses gently; static under prefers-reduced-motion. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('animate-pulse rounded-md bg-secondary motion-reduce:animate-none', className)} />
}
