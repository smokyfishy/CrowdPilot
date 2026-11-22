import { describe, expect, it } from 'vitest'
import {
  LEASE_MS,
  MAX_CONSECUTIVE_FAILURES,
  estimateProgressSec,
  fifoSelector,
  planAdvance,
  planBlocked,
  planClaimController,
  planPause,
  planPlay,
  planRenewLease,
} from './playback'
import type { Actor, PlaybackState, QueueItem, Result } from './types'

const host: Actor = { memberId: 'h', identityKey: 'user:h', role: 'host', displayName: 'Host', signedIn: true }
const guest: Actor = { memberId: 'g', identityKey: 'guest:g', role: 'guest', displayName: 'Gus', signedIn: false }
const NOW = 1_000_000

function pb(p: Partial<PlaybackState> = {}): PlaybackState {
  return {
    currentItemId: 'cur',
    state: 'playing',
    startedAt: NOW - 30_000,
    pausedAtSec: null,
    playbackRevision: 5,
    controllerId: 'tabA',
    controllerLeaseUntil: NOW + 60_000,
    errorReason: null,
    consecutiveFailures: 0,
    updatedAt: NOW - 30_000,
    ...p,
  }
}

function item(id: string, p: Partial<QueueItem> = {}): QueueItem {
  return {
    id,
    trackKey: `youtube:${id}`,
    title: id,
    requestedByMemberId: 'g',
    requestedByName: 'Gus',
    enqueueSeq: 1,
    sortKey: `a-${id}`,
    pinnedAt: null,
    status: 'queued',
    voteCount: 0,
    createdAt: 1,
    ...p,
  }
}

const items = () => [item('cur', { status: 'playing', sortKey: 'a0' }), item('n1', { sortKey: 'a1' }), item('n2', { sortKey: 'a2' })]
const code = (r: Result<unknown>) => (r.ok ? 'OK' : r.error.code)

describe('planAdvance', () => {
  it('ended marks played and starts next, revision+1', () => {
    const r = planAdvance(pb(), items(), host, { reason: 'ended', expectedRevision: 5, controllerId: 'tabA' }, NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.finished).toEqual({ itemId: 'cur', status: 'played' })
    expect(r.value.startItemId).toBe('n1')
    expect(r.value.next).toMatchObject({ currentItemId: 'n1', state: 'playing', startedAt: NOW, playbackRevision: 6, pausedAtSec: null })
  })

  it('is idempotent per revision: second call with old revision is STALE_REVISION', () => {
    const first = planAdvance(pb(), items(), host, { reason: 'ended', expectedRevision: 5, controllerId: 'tabA' }, NOW)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const again = planAdvance(first.value.next, items(), host, { reason: 'ended', expectedRevision: 5, controllerId: 'tabA' }, NOW)
    expect(code(again)).toBe('STALE_REVISION')
  })

  it('rejects ended from a non-controller tab with NOT_CONTROLLER', () => {
    const r = planAdvance(pb(), items(), host, { reason: 'ended', expectedRevision: 5, controllerId: 'tabB' }, NOW)
    expect(code(r)).toBe('NOT_CONTROLLER')
  })

  it('rejects ended when the controller lease has expired', () => {
    const r = planAdvance(pb({ controllerLeaseUntil: NOW - 1 }), items(), host, { reason: 'ended', expectedRevision: 5, controllerId: 'tabA' }, NOW)
    expect(code(r)).toBe('NOT_CONTROLLER')
  })

  it('guest skip is FORBIDDEN; host skip from a non-controller tab is allowed', () => {
    expect(code(planAdvance(pb(), items(), guest, { reason: 'skip', expectedRevision: 5 }, NOW))).toBe('FORBIDDEN')
    const r = planAdvance(pb(), items(), host, { reason: 'skip', expectedRevision: 5, controllerId: 'tabB' }, NOW)
    expect(r.ok && r.value.finished).toEqual({ itemId: 'cur', status: 'skipped' })
  })

  it('error 150 marks unavailable with a reason and never played', () => {
    const r = planAdvance(pb(), items(), host, { reason: 'error', expectedRevision: 5, controllerId: 'tabA', errorCode: 150 }, NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.finished?.status).toBe('unavailable')
    expect(r.value.finished?.failureReason).toMatch(/embed/i)
    expect(r.value.next.consecutiveFailures).toBe(1)
    expect(r.value.startItemId).toBe('n1')
  })

  it('consecutive failure guard: third unavailable stops with error state', () => {
    const r = planAdvance(
      pb({ consecutiveFailures: MAX_CONSECUTIVE_FAILURES - 1 }),
      items(),
      host,
      { reason: 'error', expectedRevision: 5, controllerId: 'tabA', errorCode: 100 },
      NOW,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.startItemId).toBeNull()
    expect(r.value.next.state).toBe('error')
    expect(r.value.next.currentItemId).toBeNull()
    expect(r.value.next.errorReason).toBeTruthy()
  })

  it('ended resets consecutiveFailures', () => {
    const r = planAdvance(pb({ consecutiveFailures: 2 }), items(), host, { reason: 'ended', expectedRevision: 5, controllerId: 'tabA' }, NOW)
    expect(r.ok && r.value.next.consecutiveFailures).toBe(0)
  })

  it('empty queue after advance goes idle', () => {
    const r = planAdvance(pb(), [item('cur', { status: 'playing' })], host, { reason: 'ended', expectedRevision: 5, controllerId: 'tabA' }, NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.startItemId).toBeNull()
    expect(r.value.next).toMatchObject({ state: 'idle', currentItemId: null, startedAt: null })
  })
})

describe('planPlay / planPause / planBlocked', () => {
  it('play with nothing current starts the next track', () => {
    const r = planPlay(pb({ currentItemId: null, state: 'idle', startedAt: null }), items().slice(1), host, { expectedRevision: 5 }, NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.startItemId).toBe('n1')
    expect(r.value.next).toMatchObject({ currentItemId: 'n1', state: 'playing', startedAt: NOW, playbackRevision: 6 })
  })

  it('play on an empty queue is INVALID', () => {
    expect(code(planPlay(pb({ currentItemId: null, state: 'idle' }), [], host, { expectedRevision: 5 }, NOW))).toBe('INVALID')
  })

  it('play resumes a paused track at pausedAtSec', () => {
    const r = planPlay(pb({ state: 'paused', pausedAtSec: 42, startedAt: null }), items(), host, { expectedRevision: 5 }, NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.startItemId).toBeNull()
    expect(r.value.next).toMatchObject({ state: 'playing', startedAt: NOW - 42_000, pausedAtSec: null, currentItemId: 'cur' })
  })

  it('guest play is FORBIDDEN and stale revisions are rejected', () => {
    expect(code(planPlay(pb({ state: 'paused' }), items(), guest, { expectedRevision: 5 }, NOW))).toBe('FORBIDDEN')
    expect(code(planPlay(pb({ state: 'paused' }), items(), host, { expectedRevision: 4 }, NOW))).toBe('STALE_REVISION')
  })

  it('pause stores pausedAtSec', () => {
    const r = planPause(pb(), host, { expectedRevision: 5, positionSec: 31.5 }, NOW)
    expect(r.ok && r.value).toMatchObject({ state: 'paused', pausedAtSec: 31.5, startedAt: null, playbackRevision: 6 })
    expect(code(planPause(pb(), guest, { expectedRevision: 5, positionSec: 1 }, NOW))).toBe('FORBIDDEN')
  })

  it('blocked is accepted only from the controller', () => {
    expect(code(planBlocked(pb(), host, { expectedRevision: 5, controllerId: 'tabB' }, NOW))).toBe('NOT_CONTROLLER')
    const r = planBlocked(pb(), host, { expectedRevision: 5, controllerId: 'tabA' }, NOW)
    expect(r.ok && r.value.state).toBe('blocked')
  })
})

describe('controller lease', () => {
  it('claim succeeds when no controller is set', () => {
    const r = planClaimController(pb({ controllerId: null, controllerLeaseUntil: null }), host, { controllerId: 'tabB', takeover: false }, NOW)
    expect(r.ok && r.value).toMatchObject({ controllerId: 'tabB', controllerLeaseUntil: NOW + LEASE_MS })
  })

  it('claim against a live lease is FORBIDDEN without takeover, ok with takeover', () => {
    expect(code(planClaimController(pb(), host, { controllerId: 'tabB', takeover: false }, NOW))).toBe('FORBIDDEN')
    const r = planClaimController(pb(), host, { controllerId: 'tabB', takeover: true }, NOW)
    expect(r.ok && r.value.controllerId).toBe('tabB')
  })

  it('claim succeeds when the lease expired, and guests can never claim', () => {
    expect(code(planClaimController(pb({ controllerLeaseUntil: NOW - 1 }), host, { controllerId: 'tabB', takeover: false }, NOW))).toBe('OK')
    expect(code(planClaimController(pb({ controllerId: null }), guest, { controllerId: 'x', takeover: true }, NOW))).toBe('FORBIDDEN')
  })

  it('renew extends the lease only for the current controller', () => {
    const r = planRenewLease(pb(), host, 'tabA', NOW + 10)
    expect(r.ok && r.value.controllerLeaseUntil).toBe(NOW + 10 + LEASE_MS)
    expect(code(planRenewLease(pb(), host, 'tabB', NOW))).toBe('NOT_CONTROLLER')
  })
})

describe('estimateProgressSec', () => {
  it('derives progress from authoritative state', () => {
    expect(estimateProgressSec(pb({ startedAt: NOW - 12_500 }), NOW)).toBeCloseTo(12.5)
    expect(estimateProgressSec(pb({ state: 'paused', pausedAtSec: 7 }), NOW)).toBe(7)
    expect(estimateProgressSec(pb({ state: 'idle', startedAt: null, currentItemId: null }), NOW)).toBe(0)
  })
})

describe('fifoSelector', () => {
  it('respects pins', () => {
    const list = [item('a', { sortKey: 'a1' }), item('b', { sortKey: 'a2', pinnedAt: 10 })]
    expect(fifoSelector.select(list)?.id).toBe('b')
  })
})
