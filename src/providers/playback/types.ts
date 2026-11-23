/**
 * Playback seam. Phase 1 has one implementation (the official YouTube IFrame
 * player on the host device). A later DJ phase can supply a controller that
 * owns transitions, without touching the queue or the room state machine.
 */
export interface PlaybackController {
  load(videoId: string, startSec?: number): Promise<void>
  play(): void
  pause(): void
  stop(): void
  /** 0–100, local to this device only. */
  setVolume(volume: number): void
  currentTime(): number
  onEnded(handler: () => void): () => void
  onError(handler: (code: number) => void): () => void
  onPlaying(handler: () => void): () => void
  destroy(): void
}
