/** Host-only queue row actions for Phase 2: position lock and timed slot. */
import { useState } from 'react'
import { Clock, Lock, LockOpen } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui'
import type { QueueItem } from '@/domain/types'
import type { RoomCommand } from '@/server/commands'

type Run = (cmd: RoomCommand) => Promise<unknown>

function toLocalTime(ms: number | undefined): string {
  if (!ms) return ''
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Next occurrence of HH:MM in local time (today, or tomorrow if already past). */
export function nextOccurrence(hhmm: string, now = Date.now()): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm)
  if (!m) return null
  const d = new Date(now)
  d.setHours(Number(m[1]), Number(m[2]), 0, 0)
  if (d.getTime() < now - 60_000) d.setDate(d.getDate() + 1)
  return d.getTime()
}

export function QueueDjActions({ item, run }: { item: QueueItem; run: Run }) {
  const [time, setTime] = useState(toLocalTime(item.targetStartAt))
  return (
    <span className="hidden gap-1 sm:flex">
      <button
        type="button"
        aria-pressed={!!item.locked}
        aria-label={item.locked ? `Unlock ${item.title}` : `Lock ${item.title} in place (AI won't move it)`}
        onClick={() => void run({ type: 'lockItem', itemId: item.id, locked: !item.locked })}
        className="grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {item.locked ? <Lock className="size-4 text-primary" aria-hidden /> : <LockOpen className="size-4" aria-hidden />}
      </button>
      <Popover>
        <PopoverTrigger
          aria-label={item.targetStartAt ? `Change timed slot for ${item.title}` : `Schedule ${item.title} for a time`}
          className="grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Clock className={item.targetStartAt ? 'size-4 text-primary' : 'size-4'} aria-hidden />
        </PopoverTrigger>
        <PopoverContent className="grid w-56 gap-2 p-3 text-sm">
          <label className="grid gap-1">
            Start this song at
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="rounded border border-input bg-background px-2 py-1" />
          </label>
          <p className="text-xs text-muted-foreground">If the queue can't reach this time, CrowdPilot shows a conflict instead of cutting songs off.</p>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-full border border-primary px-3 py-1 text-xs font-semibold text-primary"
              onClick={() => {
                const at = nextOccurrence(time)
                if (at) void run({ type: 'scheduleItem', itemId: item.id, targetStartAt: at })
              }}
            >
              Set
            </button>
            {item.targetStartAt && (
              <button type="button" className="rounded-full border border-input px-3 py-1 text-xs" onClick={() => void run({ type: 'scheduleItem', itemId: item.id, targetStartAt: null })}>
                Clear
              </button>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </span>
  )
}
