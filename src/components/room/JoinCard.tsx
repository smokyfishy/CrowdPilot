import { useState, type FormEvent } from 'react'
import { AuthOverlay, useAuth, useUser } from 'deepspace'
import { Button, Input, Label } from '@/components/ui'
import { Logo } from '@/components/brand/Logo'
import type { RoomPreview } from '@/client/api'
import type { Result } from '@/domain/types'

interface JoinCardProps {
  preview: RoomPreview
  join: (displayName: string) => Promise<Result<void>>
}

export function JoinCard({ preview, join }: JoinCardProps) {
  const { isSignedIn } = useAuth()
  const { user } = useUser()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [authOpen, setAuthOpen] = useState(false)
  const guestAllowed = preview.allowAnonymousGuests && preview.guestJoinAvailable
  const defaultName = user?.name ?? ''

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const r = await join((name || defaultName).trim())
    setBusy(false)
    if (!r.ok) setError(r.error.message)
  }

  return (
    <div className="mx-auto grid w-full max-w-md gap-8 px-[max(16px,env(safe-area-inset-left))] py-14">
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {preview.hostName} invited you · {preview.participantCount} {preview.participantCount === 1 ? 'person' : 'people'} here
        </p>
        <h1 className="font-display text-5xl leading-[0.98] text-foreground [overflow-wrap:anywhere]">{preview.name}</h1>
        <p className="text-muted-foreground">
          {preview.guestRequestsEnabled ? 'Search YouTube, add songs and vote on what plays next.' : 'Requests are paused right now, but you can follow along and vote.'}
        </p>
      </div>

      <form onSubmit={submit} className="grid gap-4">
        {(isSignedIn || guestAllowed) && (
          <div className="grid gap-1.5">
            <Label htmlFor="join-name">Your name in this room</Label>
            <Input
              id="join-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={defaultName || 'e.g. Maya'}
              maxLength={32}
              autoComplete="nickname"
              required={!isSignedIn || !defaultName}
            />
          </div>
        )}
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        {isSignedIn ? (
          <Button type="submit" size="lg" loading={busy}>
            Join room
          </Button>
        ) : (
          <>
            {guestAllowed && (
              <Button type="submit" size="lg" loading={busy}>
                Join as guest
              </Button>
            )}
            <Button type="button" size="lg" variant={guestAllowed ? 'outline' : 'default'} onClick={() => setAuthOpen(true)}>
              Sign in with Google or GitHub
            </Button>
            {!guestAllowed && <p className="text-sm text-muted-foreground">This room asks guests to sign in before joining.</p>}
          </>
        )}
      </form>

      {authOpen && (
        <AuthOverlay
          onClose={() => setAuthOpen(false)}
          providers={['google', 'github']}
          title={`Join ${preview.name}`}
          description="Sign in so your requests and votes follow you across devices."
          logo={<Logo compact />}
        />
      )}
    </div>
  )
}
