/**
 * Phase 2 AI DJ commands. Same contract as Phase 1 commands: host-only writes
 * through RBAC-bypassing room tools, validated inputs, stale-revision rejection.
 * The browser audio graph stays authoritative for real playback; these records
 * only describe settings, analysis summaries and the proposed/committed plan.
 */
import type { ActionTools } from 'deepspace/worker'
import { checkHost } from '../domain/rules'
import { fail, ok } from '../domain/types'
import type { Actor, DjState, DjStatus, Result, TransitionSummary } from '../domain/types'
import { isWaveformSource } from '../providers/catalog/types'
import { C, STATE_ID } from '../schemas/names'
import { RoomRepo } from './repo'

export type FeatureStatus = 'ready' | 'low_confidence' | 'cannot_mix' | 'failed'

export type DjCommand =
  | { type: 'djSettings'; patch: Partial<Pick<DjState, 'autopilot' | 'aiReorder' | 'maxTempoPct' | 'style' | 'allowOmlMixing'>> }
  | {
      type: 'djStatus'
      status: DjStatus
      note?: string
      transition?: TransitionSummary | null
      expectedPlaybackRevision: number
      controllerId: string
    }
  | { type: 'saveAnalysis'; trackKey: string; status: FeatureStatus; analyzerVersion: string; summary?: Record<string, unknown>; failure?: string }
  | { type: 'correctAnalysis'; trackKey: string; corrections: { bpm?: number; firstBeat?: number; downbeatPhase?: number; note?: string } | null }
  | { type: 'setMixSource'; itemId: string; action: 'accept' | 'reject' }
  | { type: 'scheduleItem'; itemId: string; targetStartAt: number | null }
  | { type: 'lockItem'; itemId: string; locked: boolean }

export const DJ_COMMAND_TYPES: ReadonlySet<string> = new Set(['djSettings', 'djStatus', 'saveAnalysis', 'correctAnalysis', 'setMixSource', 'scheduleItem', 'lockItem'])

async function writeDj(tools: ActionTools, next: DjState): Promise<void> {
  // create(…, recordId) upserts the singleton (documented in docs/DECISIONS.md).
  const r = await tools.create(C.dj, { ...next }, STATE_ID)
  if (!r.success) throw new Error(`dj_state write failed: ${r.error}`)
}

export async function executeDjCommand(tools: ActionTools, actor: Actor, cmd: DjCommand, now: number): Promise<Result<void>> {
  const host = checkHost(actor)
  if (!host.ok) return host
  const repo = new RoomRepo(tools)

  switch (cmd.type) {
    case 'djSettings': {
      const cur = await repo.djState()
      const p = cmd.patch
      const next: DjState = {
        ...cur,
        autopilot: p.autopilot ?? cur.autopilot,
        aiReorder: p.aiReorder ?? cur.aiReorder,
        maxTempoPct: p.maxTempoPct === undefined ? cur.maxTempoPct : Math.max(0, Math.min(6, p.maxTempoPct)),
        style: p.style ?? cur.style,
        allowOmlMixing: p.allowOmlMixing ?? cur.allowOmlMixing,
        updatedAt: now,
      }
      // Turning autopilot off cancels a proposal (a committed mix already playing finishes on the device).
      if (p.autopilot === false && (cur.status === 'proposed' || cur.status === 'committed')) {
        next.status = 'idle'
        next.transition = null
        next.planRevision = cur.planRevision + 1
      }
      await writeDj(tools, next)
      return ok(undefined)
    }

    case 'djStatus': {
      const pb = await repo.playback()
      if (!pb) return fail('NOT_FOUND', 'Playback state missing.')
      if (pb.controllerId !== cmd.controllerId || !pb.controllerLeaseUntil || pb.controllerLeaseUntil <= now) {
        return fail('NOT_CONTROLLER', 'Another device is playing for this room.')
      }
      if (pb.playbackRevision !== cmd.expectedPlaybackRevision) return fail('STALE_REVISION', 'Playback changed — replanning.')
      if (cmd.transition && cmd.transition.fromItemId !== pb.currentItemId) return fail('STALE_REVISION', 'The current song changed — replanning.')
      if (cmd.transition) {
        const to = await repo.item(cmd.transition.toItemId)
        if (!to || to.status !== 'queued') return fail('STALE_REVISION', 'The next song left the queue — replanning.')
      }
      const cur = await repo.djState()
      const next: DjState = {
        ...cur,
        status: cmd.status,
        statusNote: (cmd.note ?? '').slice(0, 200),
        transition: cmd.transition === undefined ? cur.transition : cmd.transition,
        planRevision: cur.planRevision + 1,
        basedOnPlaybackRevision: pb.playbackRevision,
        updatedAt: now,
      }
      await writeDj(tools, next)
      return ok(undefined)
    }

    case 'saveAnalysis': {
      if (!isWaveformSource(cmd.trackKey)) return fail('INVALID', 'Only authorized waveform sources can be analyzed.')
      const existing = await repo.features(cmd.trackKey)
      const data = {
        trackKey: cmd.trackKey,
        status: cmd.status,
        analyzerVersion: cmd.analyzerVersion.slice(0, 40),
        summary: cmd.summary ?? null,
        failure: (cmd.failure ?? '').slice(0, 200),
        analyzedAt: now,
      }
      if (existing) await tools.update(C.features, existing.recordId, data)
      else {
        const r = await tools.create(C.features, { ...data, corrections: null })
        if (!r.success && !/unique/i.test(String(r.error))) throw new Error(`features write failed: ${r.error}`)
      }
      return ok(undefined)
    }

    case 'correctAnalysis': {
      const existing = await repo.features(cmd.trackKey)
      if (!existing) return fail('NOT_FOUND', 'That track has not been analyzed yet.')
      await tools.update(C.features, existing.recordId, { corrections: cmd.corrections })
      return ok(undefined)
    }

    case 'setMixSource': {
      const item = await repo.item(cmd.itemId)
      if (!item || item.status !== 'queued') return fail('NOT_FOUND', 'That song is no longer waiting in the queue.')
      if (!item.mixTrackKey || !item.mixMatch) return fail('INVALID', 'There is no proposed mixable version for that song.')
      await tools.update(C.queue, item.id, { mixMatch: { ...item.mixMatch, status: cmd.action === 'accept' ? 'accepted' : 'rejected' } })
      return ok(undefined)
    }

    case 'scheduleItem': {
      const item = await repo.item(cmd.itemId)
      if (!item || item.status !== 'queued') return fail('NOT_FOUND', 'That song is no longer waiting in the queue.')
      if (cmd.targetStartAt !== null && (cmd.targetStartAt < now - 60_000 || cmd.targetStartAt > now + 24 * 3_600_000)) {
        return fail('INVALID', 'Pick a time within the next 24 hours.')
      }
      await tools.update(C.queue, item.id, { targetStartAt: cmd.targetStartAt })
      return ok(undefined)
    }

    case 'lockItem': {
      const item = await repo.item(cmd.itemId)
      if (!item || item.status !== 'queued') return fail('NOT_FOUND', 'That song is no longer waiting in the queue.')
      await tools.update(C.queue, item.id, { locked: cmd.locked })
      return ok(undefined)
    }
  }
}
