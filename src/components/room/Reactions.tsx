import { useEffect, useRef, useState } from 'react'
import type { Reaction } from '@/domain/types'
import { REACTION_EMOJI } from '@/domain/reactions'
import type { RoomCommand } from '@/server/commands'

export function ReactionBar({ run, disabled }: { run: (cmd: RoomCommand) => Promise<unknown>; disabled?: boolean }) {
  return (
    <div className="flex gap-2" role="group" aria-label="Send a reaction">
      {REACTION_EMOJI.map((emoji) => (
        <button
          key={emoji}
          type="button"
          disabled={disabled}
          onClick={() => run({ type: 'react', emoji })}
          className="grid h-10 flex-1 place-items-center rounded-full border border-border bg-card text-lg transition-transform hover:bg-accent active:scale-95 disabled:opacity-50"
          aria-label={`React ${emoji}`}
        >
          <span aria-hidden>{emoji}</span>
        </button>
      ))}
    </div>
  )
}

/** Floats reactions that arrive after mount; under reduced motion they appear briefly without moving. */
export function ReactionLayer({ reactions }: { reactions: Reaction[] }) {
  const mountedAt = useRef(Date.now() - 2_000)
  const seen = useRef(new Set<string>())
  const [floating, setFloating] = useState<Array<Reaction & { left: number }>>([])

  useEffect(() => {
    const fresh = reactions.filter((r) => !seen.current.has(r.id) && r.createdAt >= mountedAt.current)
    for (const r of reactions) seen.current.add(r.id)
    if (fresh.length === 0) return
    setFloating((f) => [...f, ...fresh.map((r) => ({ ...r, left: 10 + Math.random() * 80 }))].slice(-12))
    const ids = new Set(fresh.map((r) => r.id))
    const t = setTimeout(() => setFloating((f) => f.filter((r) => !ids.has(r.id))), 2_600)
    return () => clearTimeout(t)
  }, [reactions])

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {floating.map((r) => (
        <span key={r.id} className="absolute bottom-6 flex animate-float-up flex-col items-center motion-reduce:animate-none" style={{ left: `${r.left}%` }}>
          <span className="text-3xl">{r.emoji}</span>
          <span className="rounded-full bg-background/80 px-1.5 text-[10px] text-muted-foreground">{r.memberName}</span>
        </span>
      ))}
    </div>
  )
}
