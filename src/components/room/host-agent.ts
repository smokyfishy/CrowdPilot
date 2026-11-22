/**
 * Drives the host's official player from authoritative room state and turns
 * player events into server commands. Each ENDED/error is reported once per
 * playback revision, and only while this tab holds the controller lease; the
 * server also rejects stale revisions, so a double ENDED can never skip twice.
 */
import { estimateProgressSec } from '@/domain/playback'
import type { PlaybackState, QueueItem } from '@/domain/types'
import type { PlaybackController } from '@/providers/playback/types'
import type { RoomCommand } from '@/server/commands'

export const BLOCKED_TIMEOUT_MS = 3_500
/** Backoff for re-sending an ENDED/error report that failed (network blip, lapsed lease). */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000]

type SendResult = { ok: boolean; error?: { code: string } }

interface AgentDeps {
  controllerId: string
  player: PlaybackController
  now: () => number
  send: (cmd: RoomCommand) => Promise<SendResult>
  blockedTimeoutMs?: number
}

export function videoIdOf(trackKey: string): string {
  return trackKey.startsWith('youtube:') ? trackKey.slice('youtube:'.length) : trackKey
}

export class HostPlaybackAgent {
  private loadedItemId: string | null = null
  private lastPb: PlaybackState | null = null
  private isController = false
  private readonly reported = new Set<number>()
  private blockedTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private blockedReported = false
  private readonly unsubs: Array<() => void>

  constructor(private readonly deps: AgentDeps) {
    this.unsubs = [
      deps.player.onEnded(() => this.report('ended')),
      deps.player.onError((code) => this.report('error', code)),
      deps.player.onPlaying(() => this.handlePlaying()),
    ]
  }

  async sync(pb: PlaybackState, items: QueueItem[]): Promise<void> {
    const prev = this.lastPb
    this.lastPb = pb
    this.isController = pb.controllerId === this.deps.controllerId

    if (!this.isController || !pb.currentItemId || pb.state === 'idle' || pb.state === 'error') {
      if (this.loadedItemId) this.deps.player.stop()
      this.loadedItemId = null
      this.clearBlocked()
      return
    }

    if (pb.currentItemId !== this.loadedItemId) {
      const item = items.find((i) => i.id === pb.currentItemId)
      if (!item) return
      this.loadedItemId = item.id
      await this.deps.player.load(videoIdOf(item.trackKey), Math.floor(estimateProgressSec(pb, this.deps.now())))
      if (this.lastPb !== pb) return // state moved on while loading; the newer sync handles it
      if (pb.state === 'playing') {
        this.deps.player.play()
        this.armBlocked(pb.playbackRevision)
      } else if (pb.state === 'paused') this.deps.player.pause()
      return
    }

    if (pb.state === 'playing' && prev?.state !== 'playing') {
      this.deps.player.play()
      this.armBlocked(pb.playbackRevision)
    } else if (pb.state === 'paused' && prev?.state !== 'paused') {
      this.deps.player.pause()
      this.clearBlocked()
    }
  }

  /** Called from a click on "Tap to start": a real user gesture, so the browser lets the video play. */
  async tapToStart(): Promise<void> {
    const pb = this.lastPb
    if (!pb || !this.isController) return
    this.deps.player.play()
    if (pb.state === 'blocked') {
      await this.deps.send({
        type: 'play',
        expectedRevision: pb.playbackRevision,
        controllerId: this.deps.controllerId,
        positionSec: this.deps.player.currentTime(),
      })
    }
  }

  setVolume(volume: number): void {
    this.deps.player.setVolume(volume)
  }

  currentTime(): number {
    return this.deps.player.currentTime()
  }

  dispose(): void {
    this.clearBlocked()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.unsubs.forEach((u) => u())
  }

  /** Playback really started. If we had reported "blocked" (slow buffering), tell the room it's playing. */
  private handlePlaying(): void {
    this.clearBlocked()
    const pb = this.lastPb
    if (!pb || !this.isController) return
    if (this.blockedReported || pb.state === 'blocked') {
      this.blockedReported = false
      void this.deps.send({
        type: 'play',
        expectedRevision: pb.playbackRevision,
        controllerId: this.deps.controllerId,
        positionSec: this.deps.player.currentTime(),
      })
    }
  }

  /** Deliver a report, retrying transient failures while the revision it refers to is still current. */
  private async deliver(cmd: RoomCommand, revision: number, attempt: number): Promise<void> {
    const r = await this.deps.send(cmd)
    if (r.ok || this.lastPb?.playbackRevision !== revision || !this.isController) return
    const code = r.error?.code
    if (code === 'STALE_REVISION' || code === 'FORBIDDEN' || code === 'INVALID' || code === 'ROOM_CLOSED') return
    if (code === 'NOT_CONTROLLER' && attempt === 0) {
      const claimed = await this.deps.send({ type: 'claimController', controllerId: this.deps.controllerId, takeover: false })
      if (claimed.ok) return this.deliver(cmd, revision, attempt + 1)
      return
    }
    const delay = RETRY_DELAYS_MS[attempt]
    if (delay === undefined) return
    this.retryTimer = setTimeout(() => void this.deliver(cmd, revision, attempt + 1), delay)
  }

  private report(reason: 'ended' | 'error', errorCode?: number): void {
    const pb = this.lastPb
    if (!pb || !this.isController || !pb.currentItemId) return
    if (this.reported.has(pb.playbackRevision)) return
    this.reported.add(pb.playbackRevision)
    this.clearBlocked()
    const cmd: RoomCommand =
      reason === 'ended'
        ? { type: 'advance', reason, expectedRevision: pb.playbackRevision, controllerId: this.deps.controllerId }
        : { type: 'advance', reason, expectedRevision: pb.playbackRevision, controllerId: this.deps.controllerId, errorCode }
    void this.deliver(cmd, pb.playbackRevision, 0)
  }

  private armBlocked(revision: number): void {
    this.clearBlocked()
    this.blockedTimer = setTimeout(() => {
      const pb = this.lastPb
      if (pb && this.isController && pb.state === 'playing' && pb.playbackRevision === revision) {
        this.blockedReported = true
        void this.deps.send({ type: 'blocked', expectedRevision: revision, controllerId: this.deps.controllerId })
      }
    }, this.deps.blockedTimeoutMs ?? BLOCKED_TIMEOUT_MS)
  }

  private clearBlocked(): void {
    if (this.blockedTimer) clearTimeout(this.blockedTimer)
    this.blockedTimer = null
  }
}
