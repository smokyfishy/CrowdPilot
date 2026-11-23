import { UserX } from 'lucide-react'
import type { Actor, Member, RoomEvent } from '@/domain/types'
import type { RoomCommand } from '@/server/commands'
import { announcementFor } from './view-model'

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?'
}

function timeAgo(ms: number) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

interface PeoplePanelProps {
  members: Member[]
  online: Set<string>
  actor?: Actor
  events: RoomEvent[]
  run: (cmd: RoomCommand) => Promise<unknown>
}

export function PeoplePanel({ members, online, actor, events, run }: PeoplePanelProps) {
  const active = members
    .filter((m) => m.status === 'active')
    .sort((a, b) => Number(b.role === 'host') - Number(a.role === 'host') || Number(online.has(b.id)) - Number(online.has(a.id)) || a.joinedAt - b.joinedAt)
  const here = active.filter((m) => online.has(m.id)).length
  const isHost = actor?.role === 'host'

  return (
    <div className="grid gap-8">
      <section aria-labelledby="people-heading" className="grid gap-3">
        <h2 id="people-heading" className="text-base font-semibold text-foreground">
          People <span className="font-normal text-muted-foreground">{here} here now</span>
        </h2>
        <ul className="grid gap-1">
          {active.map((m) => (
            <li key={m.id} className="flex items-center gap-3 py-1">
              <span className="relative grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-xs font-semibold text-foreground">
                {initials(m.displayName)}
                <span
                  className={`absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background ${online.has(m.id) ? 'bg-primary' : 'bg-muted-foreground/40'}`}
                  aria-hidden
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">
                  {m.displayName}
                  {m.id === actor?.memberId && <span className="text-muted-foreground"> (you)</span>}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {m.role === 'host' ? 'Host' : m.signedIn ? 'Guest' : 'Guest, not signed in'}
                  {online.has(m.id) ? '' : ' · away'}
                </span>
              </span>
              {isHost && m.role !== 'host' && (
                <button
                  type="button"
                  onClick={() => run({ type: 'kick', memberId: m.id })}
                  aria-label={`Remove ${m.displayName} from the room`}
                  className="grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-destructive"
                >
                  <UserX className="size-4" aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="activity-heading" className="grid gap-3">
        <h2 id="activity-heading" className="text-base font-semibold text-foreground">
          Activity
        </h2>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">Joins, requests and skips show up here.</p>
        ) : (
          <ol className="grid gap-2 text-sm">
            {events
              .filter((e) => e.type !== 'now_playing')
              .slice(0, 20)
              .map((e) => (
                <li key={e.id} className="flex gap-3 text-muted-foreground">
                  <span className="w-8 shrink-0 tabular-nums">{timeAgo(e.createdAt)}</span>
                  <span className="min-w-0">{announcementFor(e)}</span>
                </li>
              ))}
          </ol>
        )}
      </section>
    </div>
  )
}
