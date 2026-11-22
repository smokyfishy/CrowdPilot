/**
 * The host's single, visible, official YouTube player plus the controller
 * lease that guarantees only one host tab/device outputs audio.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { MonitorSpeaker, Volume2 } from 'lucide-react'
import { Button } from '@/components/ui'
import { cn } from '@/lib/utils'
import { LEASE_MS, RENEW_MS } from '@/domain/playback'
import type { DjState, PlaybackState, QueueItem } from '@/domain/types'
import { createYouTubeIframeController, loadYouTubeApi } from '@/providers/playback/youtube-iframe'
import { authHeaders } from '@/client/api'
import { HostDj, playKeyOf } from '@/dj/engine/host-dj'
import { createRoutingController, type OutputKind } from '@/dj/engine/routing-controller'
import type { RoomCommand } from '@/server/commands'
import { useServerClock } from '@/client/hooks'
import { HostPlaybackAgent } from './host-agent'
import { acquireControllerId, type LockManagerLike } from './controller-id'

type Run = (cmd: RoomCommand, opts?: { silent?: boolean }) => Promise<{ ok: boolean; error?: { code: string; message: string } }>

/** Per-tab controller id, guarded by a Web Lock so a duplicated tab never shares it (see controller-id.ts). */
function useControllerId(roomId: string): string | null {
  const [id, setId] = useState<string | null>(null)
  useEffect(() => {
    let release: (() => void) | null = null
    let cancelled = false
    const storage = (() => {
      try {
        return sessionStorage
      } catch {
        return undefined
      }
    })()
    const locks = typeof navigator !== 'undefined' && 'locks' in navigator ? (navigator.locks as unknown as LockManagerLike) : undefined
    void acquireControllerId(roomId, { storage, locks, newId: () => crypto.randomUUID() }).then((r) => {
      if (cancelled) return r.release()
      release = r.release
      setId(r.id)
    })
    return () => {
      cancelled = true
      release?.()
    }
  }, [roomId])
  return id
}

const CLAIM_RETRY_MS = 5_000

export function useController(roomId: string, playback: PlaybackState | undefined, run: Run) {
  const controllerId = useControllerId(roomId)
  const clock = useServerClock()
  const leaseLive = !!playback?.controllerLeaseUntil && playback.controllerLeaseUntil > clock.now()
  const isController = !!controllerId && playback?.controllerId === controllerId && leaseLive
  const free = !playback?.controllerId || !leaseLive
  const lastClaimAt = useRef(0)

  const claim = useCallback(
    async (takeover: boolean) => {
      if (!controllerId) return { ok: false as const }
      lastClaimAt.current = Date.now()
      return run({ type: 'claimController', controllerId, takeover }, { silent: !takeover })
    },
    [run, controllerId],
  )

  // Auto-claim whenever nobody is playing for this room (not just once per mount).
  useEffect(() => {
    if (playback && free && controllerId && Date.now() - lastClaimAt.current > CLAIM_RETRY_MS) void claim(false)
  }, [playback, free, controllerId, claim])

  // Keep the lease alive while this tab is the player.
  useEffect(() => {
    if (!controllerId || playback?.controllerId !== controllerId) return
    const id = setInterval(() => void run({ type: 'renewLease', controllerId }, { silent: true }), RENEW_MS)
    return () => clearInterval(id)
  }, [playback?.controllerId, controllerId, run])

  return { controllerId, isController, otherDeviceActive: !isController && !free, claim, leaseMs: LEASE_MS }
}

interface HostPlayerProps {
  roomId: string
  playback?: PlaybackState
  items: QueueItem[]
  run: Run
  /** Phase 2: AI DJ settings/state (undefined → Phase 1 behaviour only). */
  dj?: DjState
  onHostDj?: (h: HostDj | null) => void
}

export function HostPlayer({ roomId, playback, items, run, dj, onHostDj }: HostPlayerProps) {
  const { controllerId, isController, otherDeviceActive, claim } = useController(roomId, playback, run)
  const clock = useServerClock()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const agentRef = useRef<HostPlaybackAgent | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [volume, setVolume] = useState(80)
  const [output, setOutput] = useState<OutputKind>('youtube')
  const hostDjRef = useRef<HostDj | null>(null)

  useEffect(() => {
    if (!isController || !controllerId || !containerRef.current) return
    const mount = document.createElement('div')
    containerRef.current.appendChild(mount)
    const player = createYouTubeIframeController(mount, async () => {
      try {
        return await loadYouTubeApi()
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : 'The YouTube player could not load.')
        throw e
      }
    })
    const send = (cmd: RoomCommand) => run(cmd, { silent: cmd.type === 'advance' || cmd.type === 'djStatus' || cmd.type === 'saveAnalysis' })
    // Phase 2: authorized waveform items play through the Web Audio DJ decks; YouTube stays on the official player.
    const hostDj = new HostDj({
      roomId,
      controllerId,
      send,
      now: clock.now,
      fetchCtx: { roomId, authHeaders: () => authHeaders(roomId) },
      onChange: () => undefined,
    })
    hostDjRef.current = hostDj
    onHostDj?.(hostDj)
    const routed = createRoutingController(player, hostDj, setOutput)
    const agent = new HostPlaybackAgent({ controllerId, player: routed, now: clock.now, send, playKeyOf })
    agentRef.current = agent
    routed.setVolume(volume)
    return () => {
      agent.dispose()
      routed.destroy()
      agentRef.current = null
      hostDjRef.current = null
      onHostDj?.(null)
      mount.remove()
    }
  }, [isController, controllerId, run, clock])

  useEffect(() => {
    if (playback && agentRef.current) void agentRef.current.sync(playback, items)
    if (playback && dj && hostDjRef.current) hostDjRef.current.sync(playback, items, dj)
  }, [playback, items, isController, dj])

  const setVol = (v: number) => {
    setVolume(v)
    agentRef.current?.setVolume(v)
  }

  if (!isController) {
    return (
      <div className="grid aspect-video min-h-[200px] w-full place-items-center rounded-lg border border-border bg-card p-6 text-center">
        <div className="grid justify-items-center gap-3">
          <MonitorSpeaker className="size-6 text-muted-foreground" aria-hidden />
          <p className="text-foreground">{otherDeviceActive ? 'Music is playing on another of your devices.' : 'Connecting the player…'}</p>
          <Button variant="outline" size="sm" disabled={!controllerId} onClick={() => void claim(true)}>
            {otherDeviceActive ? 'Play here instead' : 'Use this device as the player'}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="grid gap-3">
      {output === 'waveform' && (
        <div className="grid min-h-[120px] w-full place-items-center rounded-lg border border-primary/40 bg-card p-4 text-center text-sm text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">AI DJ decks</span> are playing authorized audio on this device.
          </p>
          {playback?.state === 'blocked' && (
            <Button size="lg" className="mt-3" onClick={() => void agentRef.current?.tapToStart()}>
              Tap to start the music
            </Button>
          )}
        </div>
      )}
      {/* The official YouTube player stays mounted (never re-created); it is only hidden while the DJ decks are the active output. */}
      <div className={cn('relative aspect-video min-h-[200px] w-full overflow-hidden rounded-lg border border-border bg-black', output === 'waveform' && 'hidden')}>
        <div ref={containerRef} className="absolute inset-0 [&_iframe]:h-full [&_iframe]:w-full" />
        {playback?.state === 'blocked' && (
          <div className="absolute inset-0 grid place-items-center bg-black/70">
            <Button size="lg" onClick={() => void agentRef.current?.tapToStart()}>
              Tap to start the music
            </Button>
          </div>
        )}
        {loadError && (
          <div className="absolute inset-0 grid place-items-center bg-card p-6 text-center text-sm text-muted-foreground" role="alert">
            {loadError}
          </div>
        )}
      </div>
      <label className="flex items-center gap-3 text-sm text-muted-foreground">
        <Volume2 className="size-4" aria-hidden />
        <span className="sr-only">Volume on this device</span>
        <input type="range" min={0} max={100} value={volume} onChange={(e) => setVol(Number(e.target.value))} className="flex-1 accent-[var(--color-primary)]" aria-label="Volume on this device" />
      </label>
    </div>
  )
}
