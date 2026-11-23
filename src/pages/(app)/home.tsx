/**
 * /home — the host's start page: sign in, create a room, reopen your rooms.
 * The rooms directory is app-scoped and RBAC-filtered to the caller's own rows.
 */
import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AuthOverlay, useAuth, useQuery, useUser } from 'deepspace'
import { Button, Input, Label, Skeleton, useToast } from '@/components/ui'
import { Logo } from '@/components/brand/Logo'
import { roomApi } from '@/client/api'
import { C } from '@/schemas/names'

interface RoomRow {
  code: string
  name: string
  status: 'open' | 'closed' | 'expired'
  lastActivityAt: number
}

const STATUS_LABEL: Record<RoomRow['status'], string> = { open: 'Open', closed: 'Closed', expired: 'Ended after 24 h idle' }

function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  const min = Math.round(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} h ago`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function JoinByCode() {
  const navigate = useNavigate()
  const [code, setCode] = useState('')
  const cleaned = code.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 6)
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (cleaned.length === 6) navigate(`/join/${cleaned}`)
      }}
      className="flex items-end gap-2"
    >
      <div className="grid gap-1.5">
        <Label htmlFor="home-code">Have a code?</Label>
        <Input
          id="home-code"
          value={cleaned}
          onChange={(e) => setCode(e.target.value)}
          placeholder="K7MQ2P"
          autoComplete="off"
          spellCheck={false}
          className="w-[11ch] font-semibold tracking-[0.14em]"
        />
      </div>
      <Button type="submit" variant="outline" disabled={cleaned.length !== 6}>
        Join
      </Button>
    </form>
  )
}

function SignedOut() {
  const [open, setOpen] = useState(false)
  return (
    <div className="mx-auto grid max-w-xl gap-8 py-16">
      <div>
        <h1 className="font-display text-5xl leading-none text-foreground">Host a room</h1>
        <p className="mt-4 text-muted-foreground">
          Hosts sign in so their rooms stay theirs. Guests don't have to: they can join with just a name.
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button size="lg" onClick={() => setOpen(true)} data-testid="home-sign-in">
          Sign in to start
        </Button>
      </div>
      <div className="border-t border-border pt-6">
        <JoinByCode />
      </div>
      {open && (
        <AuthOverlay
          onClose={() => setOpen(false)}
          providers={['google', 'github']}
          title="Sign in to CrowdPilot"
          description="Host rooms and keep your name across devices."
          logo={<Logo compact />}
        />
      )}
    </div>
  )
}

function CreateRoom() {
  const { user } = useUser()
  const navigate = useNavigate()
  const { error } = useToast()
  const firstName = (user?.name ?? '').split(' ')[0]
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const placeholder = firstName ? `${firstName}'s room` : 'Friday night'

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    const r = await roomApi.create(name.trim() || placeholder)
    setBusy(false)
    if (r.ok) navigate(`/room/${r.value.roomId}`)
    else error("Couldn't create the room", r.error.message)
  }

  return (
    <form onSubmit={submit} className="grid gap-3 rounded-xl border border-border bg-card p-5 sm:p-6">
      <Label htmlFor="room-name" className="text-base font-semibold text-foreground">
        New room
      </Label>
      <div className="flex flex-wrap gap-2">
        <Input
          id="room-name"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          placeholder={placeholder}
          className="min-w-0 flex-1 basis-56"
        />
        <Button type="submit" loading={busy}>
          Start room
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">You'll get a code and QR to share. Guests can add up to 3 songs at a time until you change it.</p>
    </form>
  )
}

function YourRooms() {
  const { records, status } = useQuery<RoomRow>(C.rooms, { orderBy: 'lastActivityAt', orderDir: 'desc', limit: 30 })
  const rooms = [...records].sort((a, b) => Number(b.data.status === 'open') - Number(a.data.status === 'open'))
  return (
    <section aria-labelledby="your-rooms" className="grid gap-3">
      <h2 id="your-rooms" className="font-display text-3xl text-foreground">
        Your rooms
      </h2>
      {status === 'loading' ? (
        <div className="grid gap-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : status === 'error' ? (
        <p className="text-muted-foreground">Your rooms couldn't load. Check your connection; this list updates on its own once you're back online.</p>
      ) : rooms.length === 0 ? (
        <p className="text-muted-foreground">No rooms yet. Start one above and it will appear here.</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {rooms.map((room) => (
            <li key={room.recordId}>
              <Link to={`/room/${room.recordId}`} className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-accent">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-foreground">{room.data.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {STATUS_LABEL[room.data.status] ?? 'Open'} · active {relativeTime(Number(room.data.lastActivityAt))}
                  </p>
                </div>
                <span className="font-semibold tracking-[0.14em] text-muted-foreground tabular-nums">{room.data.code}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default function Home() {
  const { isLoaded, isSignedIn } = useAuth()
  return (
    <div className="mx-auto w-full max-w-3xl px-[max(16px,env(safe-area-inset-left))] py-10">
      <title>Your rooms · CrowdPilot</title>
      {!isLoaded ? null : !isSignedIn ? (
        <SignedOut />
      ) : (
        <div className="grid gap-10">
          <CreateRoom />
          <YourRooms />
          <JoinByCode />
        </div>
      )}
    </div>
  )
}
