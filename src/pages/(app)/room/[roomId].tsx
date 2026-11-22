/**
 * /room/:roomId — the live listening room. Host console on wide screens,
 * mobile-first guest view with bottom tabs on phones. All data is read live
 * from the room's own RecordRoom scope; every write is a server command.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { RecordScope, usePresenceRoom } from 'deepspace'
import { ListMusic, Search as SearchIcon, Settings2, UserPlus, Users } from 'lucide-react'
import { Button, Skeleton, useToast } from '@/components/ui'
import { cn } from '@/lib/utils'
import { roomApi, type RoomPreview } from '@/client/api'
import { useActor, useMyVotes, useRoomCommand, useRoomData, useServerClock } from '@/client/hooks'
import { estimateProgressSec } from '@/domain/playback'
import type { Actor, DomainError } from '@/domain/types'
import type { RoomCommand } from '@/server/commands'
import { isRoomId, roomScope } from '@/server/room-tools'
import { roomSchemas } from '@/schemas'
import { InviteDialog } from '@/components/room/InviteDialog'
import { JoinCard } from '@/components/room/JoinCard'
import { NowPlaying } from '@/components/room/NowPlaying'
import { PeoplePanel } from '@/components/room/PeoplePanel'
import { QueueList } from '@/components/room/QueueList'
import { ReactionBar, ReactionLayer } from '@/components/room/Reactions'
import { SearchPanel } from '@/components/room/SearchPanel'
import { SettingsDialog } from '@/components/room/SettingsDialog'
import { HostPlayer } from '@/components/room/HostPlayer'
import { announcementFor, onlineMemberIds } from '@/components/room/view-model'

function StateScreen({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="mx-auto grid max-w-md gap-4 px-4 py-24 text-center">
      <h1 className="font-display text-4xl text-foreground">{title}</h1>
      <p className="text-muted-foreground">{body}</p>
      {action ?? (
        <Link to="/" className="justify-self-center rounded-full border border-input px-5 py-2.5 text-sm font-semibold hover:bg-accent">
          Back to CrowdPilot
        </Link>
      )}
    </div>
  )
}

export default function RoomPage() {
  const { roomId = '' } = useParams()
  if (!isRoomId(roomId)) return <StateScreen title="Room not found" body="This link doesn't point to a CrowdPilot room. Ask the host for a new invite." />
  return (
    <RecordScope roomId={roomScope(roomId)} schemas={roomSchemas}>
      <Room roomId={roomId} />
    </RecordScope>
  )
}

function Room({ roomId }: { roomId: string }) {
  const { status, actor, error, join } = useActor(roomId)
  const [preview, setPreview] = useState<RoomPreview | null>(null)
  const [previewError, setPreviewError] = useState<DomainError | null>(null)

  useEffect(() => {
    let cancelled = false
    roomApi.preview(roomId).then((r) => {
      if (cancelled) return
      if (r.ok) setPreview(r.value)
      else setPreviewError(r.error)
    })
    return () => {
      cancelled = true
    }
  }, [roomId])

  if (previewError?.code === 'NOT_FOUND') return <StateScreen title="Room not found" body="This room doesn't exist. Check the link or the code with the host." />
  if (preview && preview.status !== 'open' && status !== 'joined')
    return <StateScreen title="This room has ended" body={`${preview.name} is closed. The host can start a new room any time.`} />
  if (status === 'kicked') return <StateScreen title="You've left this room" body="The host removed you from this room." />
  if (status === 'error') return <StateScreen title="Something went wrong" body={error?.message ?? 'Reload the page to try again.'} />
  if (status === 'needs-join' && preview) return <JoinCard preview={preview} join={join} />
  if (status === 'joined' && actor) return <RoomShell roomId={roomId} actor={actor} />
  return (
    <div className="mx-auto grid max-w-md gap-4 px-4 py-24" aria-busy="true" aria-label="Loading room">
      <Skeleton className="h-6 w-1/2" />
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-11 w-full" />
    </div>
  )
}

type MobileTab = 'room' | 'search' | 'people'

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}

function RoomShell({ roomId, actor }: { roomId: string; actor: Actor }) {
  const wide = useMediaQuery('(min-width: 1024px)')
  const data = useRoomData()
  const myVotes = useMyVotes(actor.memberId)
  const presence = usePresenceRoom(roomScope(roomId))
  const { error: toastError, info } = useToast()
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<MobileTab>('room')
  const [inviteOpen, setInviteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const isHost = actor.role === 'host'
  const clock = useServerClock()

  const onError = useCallback(
    (e: DomainError) => {
      if (e.code === 'STALE_REVISION') info('Updated', 'Someone changed this at the same moment. Showing the latest.')
      else toastError(e.code === 'RATE_LIMITED' ? 'Slow down a little' : "That didn't work", e.message)
    },
    [info, toastError],
  )
  const command = useRoomCommand(roomId, onError)
  const run = useCallback(
    async (cmd: RoomCommand, opts?: { silent?: boolean }) => {
      const r = await command(cmd, opts)
      return r.ok ? { ok: true as const } : { ok: false as const, error: r.error }
    },
    [command],
  )

  // Tell presence which member this tab is, so anonymous guests show as online.
  const { updateState } = presence
  useEffect(() => {
    updateState({ memberId: actor.memberId })
  }, [updateState, actor.memberId])

  const online = useMemo(() => onlineMemberIds(data.members, presence.peers, actor.memberId), [data.members, presence.peers, actor.memberId])
  const me = data.members.find((m) => m.id === actor.memberId)

  // Screen-reader announcement of the newest activity.
  const [announcement, setAnnouncement] = useState('')
  const lastEventId = useRef<string | null>(null)
  useEffect(() => {
    const newest = data.events[0]
    if (!newest) return
    if (lastEventId.current && newest.id !== lastEventId.current) setAnnouncement(announcementFor(newest))
    lastEventId.current = newest.id
  }, [data.events])

  const playbackCmd = useCallback(
    async (cmd: RoomCommand) => {
      setBusy(true)
      await run(cmd)
      setBusy(false)
    },
    [run],
  )
  const rev = data.playback?.playbackRevision ?? 0
  const onPlay = () => playbackCmd({ type: 'play', expectedRevision: rev })
  const onPause = () =>
    playbackCmd({ type: 'pause', expectedRevision: rev, positionSec: data.playback ? estimateProgressSec(data.playback, clock.now()) : 0 })
  const onSkip = () => playbackCmd({ type: 'advance', reason: 'skip', expectedRevision: rev })

  const voteExisting = (trackKey: string) => {
    const existing = [...data.upNext, ...(data.nowPlaying ? [data.nowPlaying] : [])].find((i) => i.trackKey === trackKey)
    if (existing && !myVotes.has(existing.id)) void run({ type: 'vote', itemId: existing.id })
  }

  if (data.status === 'loading' || !data.room) {
    return (
      <div className="mx-auto grid max-w-6xl gap-6 p-6" aria-busy="true" aria-label="Loading room">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-6 lg:grid-cols-3">
          <Skeleton className="aspect-square" />
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </div>
    )
  }

  const room = data.room
  if (me?.status === 'kicked') return <StateScreen title="You've left this room" body="The host removed you from this room." />
  if (room.status !== 'open') return <StateScreen title="This room has ended" body={`${room.name} is closed. Thanks for listening.`} />

  const nowPlaying = (
    <NowPlaying
      item={data.nowPlaying}
      playback={data.playback}
      isHost={isHost}
      queueEmpty={data.upNext.length === 0}
      busy={busy}
      onPlay={onPlay}
      onPause={onPause}
      onSkip={onSkip}
      compact={!wide}
      player={
        isHost ? (
          <HostPlayer
            roomId={roomId}
            playback={data.playback}
            items={data.nowPlaying ? [data.nowPlaying, ...data.upNext] : data.upNext}
            run={run}
          />
        ) : undefined
      }
    />
  )
  const queue = (
    <QueueList
      items={data.upNext}
      history={data.history}
      actor={actor}
      myVotes={myVotes}
      queueRevision={room.queueRevision}
      run={run}
      onFindSongs={() => setTab('search')}
    />
  )
  const search = (
    <SearchPanel roomId={roomId} room={room} isHost={isHost} activeKeys={data.activeKeys} run={run} onVoteExisting={voteExisting} />
  )
  const people = <PeoplePanel members={data.members} online={online} actor={actor} events={data.events} run={run} />

  return (
    <div className={cn('relative min-h-full', !wide && 'pb-20')}>
      <title>{`${room.name} · CrowdPilot`}</title>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>

      {data.status === 'error' && (
        <div role="status" className="bg-secondary px-4 py-2 text-center text-sm text-foreground">
          Connection lost. Reconnecting… Changes you make will apply once you're back.
        </div>
      )}

      <header className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-[max(16px,env(safe-area-inset-left))] pb-2 pt-5">
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-3xl leading-tight text-foreground">{room.name}</h1>
          <p className="text-sm text-muted-foreground">
            Hosted by {isHost ? 'you' : room.hostName}
            {!room.guestRequestsEnabled && ' · requests paused'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setInviteOpen(true)}>
          <UserPlus aria-hidden /> Invite{room.code ? ` · ${room.code}` : ''}
        </Button>
        {isHost && (
          <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)} aria-label="Room settings">
            <Settings2 aria-hidden />
            <span className="hidden sm:inline">Settings</span>
          </Button>
        )}
      </header>

      {/* Exactly one layout is mounted, so the host never gets two players. */}
      {wide ? (
      <div className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)_minmax(0,0.85fr)] gap-0 px-[max(16px,env(safe-area-inset-left))] py-4">
        <section aria-label="Now playing" className="relative grid content-start gap-6 pr-8">
          {nowPlaying}
          <ReactionBar run={run} />
          <ReactionLayer reactions={data.reactions} />
        </section>
        <div className="border-l border-border px-8">{queue}</div>
        <div className="grid content-start gap-10 border-l border-border pl-8">
          {search}
          {people}
        </div>
      </div>

      ) : (
      <div className="px-[max(16px,env(safe-area-inset-left))] py-4">
        {tab === 'room' && (
          <div className="relative grid gap-6">
            {nowPlaying}
            <ReactionBar run={run} />
            <ReactionLayer reactions={data.reactions} />
            <div className="border-t border-border pt-5">{queue}</div>
          </div>
        )}
        {tab === 'search' && search}
        {tab === 'people' && people}
      </div>
      )}

      {!wide && (
      <nav
        aria-label="Room sections"
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-3 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
      >
        {(
          [
            ['room', 'Queue', ListMusic],
            ['search', 'Add songs', SearchIcon],
            ['people', 'People', Users],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            aria-current={tab === id ? 'page' : undefined}
            onClick={() => setTab(id)}
            className={cn('grid justify-items-center gap-0.5 py-2.5 text-xs', tab === id ? 'font-semibold text-foreground shadow-[inset_0_2px_0_var(--color-primary)]' : 'text-muted-foreground')}
          >
            <Icon className="size-5" aria-hidden />
            {label}
          </button>
        ))}
      </nav>
      )}

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} roomName={room.name} roomId={roomId} code={room.code} />
      {isHost && <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} room={room} run={run} />}
    </div>
  )
}
