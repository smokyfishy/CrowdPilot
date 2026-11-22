/**
 * MixGraph queue planner (hybrid Jam queue).
 *
 * Hard constraints:
 *  - the current track and an already committed next transition never move;
 *  - pinned items ("play next", Phase 1) keep their order at the head;
 *  - position-locked items keep their index;
 *  - no unlocked request is delayed by more than `maxDisplacement` positions vs FIFO;
 *  - timed slots: the item must be able to start inside [target ± tolerance], using
 *    the allowed truncation range of the preceding tracks; otherwise → conflict.
 * Soft objective: Σ transition cost + fairness (delay) − votes bonus.
 *
 * With aiReorder = false (the room default) the order is exactly FIFO/Phase 1 and the
 * planner only computes transitions, schedule and conflicts.
 * Bounded beam search; tests cross-check optimality against brute force on toy cases.
 */
import { bestTransition, type PlannerOptions, type PlanTrack, DEFAULT_OPTIONS } from './transitions'

export interface QueueCandidate {
  track: PlanTrack
  fifoIndex: number
  pinned: boolean
  lockedIndex?: number
  /** Epoch ms the host wants this item to start. */
  targetStartAt?: number
  votes: number
}

export interface QueuePlanInput {
  now: number
  current: PlanTrack | null
  /** Seconds until the current track's planned mix-out (or end). */
  currentRemainingSec: number
  committedNextId?: string | null
  items: QueueCandidate[]
  aiReorder: boolean
  maxDisplacement?: number
  horizon?: number
  beamWidth?: number
  timedToleranceSec?: number
  /** Fraction of a track's nominal play time that may be cut to meet a timed slot. */
  maxTruncation?: number
  transition?: PlannerOptions
}

export interface ScheduledItem {
  itemId: string
  position: number
  estStartAt: number
  /** Range of feasible start times given truncation flexibility of earlier tracks. */
  earliestStartAt: number
  latestStartAt: number
  transitionStyle: string
  transitionCost: number
}

export interface Conflict {
  itemId: string
  kind: 'timed_slot_unreachable' | 'locked_index_out_of_range'
  message: string
}

export interface QueuePlan {
  order: string[]
  schedule: ScheduledItem[]
  conflicts: Conflict[]
  cost: number
  costParts: { transitions: number; fairness: number; votes: number }
  reordered: boolean
  alternatives: Array<{ order: string[]; cost: number }>
  explored: number
}

const WAIT_WEIGHT = 0.8
const VOTE_WEIGHT = 0.15

export function fifoOrder(items: QueueCandidate[]): QueueCandidate[] {
  return [...items].sort((a, b) => a.fifoIndex - b.fifoIndex)
}

type PairCost = (a: PlanTrack | null, b: PlanTrack) => { cost: number; style: string }

function makePairCost(opts: PlannerOptions): PairCost {
  const cache = new Map<string, { cost: number; style: string }>()
  return (a, b) => {
    if (!a) return { cost: 0, style: 'start' }
    const key = `${a.itemId}>${b.itemId}`
    let v = cache.get(key)
    if (!v) {
      const t = bestTransition(a, b, opts, 0).best
      // standard playback between two unmixable tracks costs a constant: it is not "bad", just not mixed
      v = { cost: t.style === 'sequential' ? 2 : t.costs.total, style: t.style }
      cache.set(key, v)
    }
    return v
  }
}

function nominalSec(t: PlanTrack): number {
  return Math.max(10, t.durationSec)
}

interface Partial {
  seq: QueueCandidate[]
  cost: number
  transitions: number
  fairness: number
  votes: number
  /** Accumulated start-time window (seconds from now) for the NEXT item. */
  minT: number
  maxT: number
  nomT: number
}

function violatesStatic(c: QueueCandidate, pos: number, maxDisp: number): boolean {
  if (c.lockedIndex !== undefined && c.lockedIndex !== pos) return true
  if (pos - c.fifoIndex > maxDisp) return true
  return false
}

function timedOk(c: QueueCandidate, p: Partial, input: QueuePlanInput): boolean {
  if (c.targetStartAt === undefined) return true
  const tol = (input.timedToleranceSec ?? 120) * 1000
  const lo = input.now + p.minT * 1000
  const hi = input.now + p.maxT * 1000
  return c.targetStartAt + tol >= lo && c.targetStartAt - tol <= hi
}

function extend(p: Partial, c: QueueCandidate, prev: PlanTrack | null, pair: PairCost, input: QueuePlanInput): Partial {
  const pos = p.seq.length
  const t = pair(prev, c.track)
  const delay = Math.max(0, pos - c.fifoIndex)
  const fairness = WAIT_WEIGHT * delay
  const votes = VOTE_WEIGHT * c.votes * Math.max(0, c.fifoIndex - pos)
  const trunc = input.maxTruncation ?? 0.5
  const dur = nominalSec(c.track)
  return {
    seq: [...p.seq, c],
    cost: p.cost + t.cost + fairness - votes,
    transitions: p.transitions + t.cost,
    fairness: p.fairness + fairness,
    votes: p.votes + votes,
    minT: p.minT + dur * (1 - trunc),
    maxT: p.maxT + dur,
    nomT: p.nomT + dur,
  }
}

function rootPartial(input: QueuePlanInput): Partial {
  const rem = Math.max(0, input.currentRemainingSec)
  const trunc = input.maxTruncation ?? 0.5
  return { seq: [], cost: 0, transitions: 0, fairness: 0, votes: 0, minT: rem * (1 - trunc), maxT: rem, nomT: rem }
}

/** Head constraints: committed next first, then pinned items in pin order (Phase 1 semantics). */
function splitHead(input: QueuePlanInput): { head: QueueCandidate[]; free: QueueCandidate[] } {
  const items = fifoOrder(input.items)
  const head: QueueCandidate[] = []
  const committed = input.committedNextId ? items.find((i) => i.track.itemId === input.committedNextId) : undefined
  if (committed) head.push(committed)
  for (const i of items) if (i.pinned && i !== committed) head.push(i)
  // Displacement is measured against the baseline order (committed + pins + FIFO), so
  // pins/commits never make ordinary requests look "delayed".
  const free = items.filter((i) => !head.includes(i)).map((i, k) => ({ ...i, fifoIndex: head.length + k }))
  return { head, free }
}

function finish(best: Partial, input: QueuePlanInput, pair: PairCost, alternatives: Partial[], explored: number): QueuePlan {
  const schedule: ScheduledItem[] = []
  const conflicts: Conflict[] = []
  let p = rootPartial(input)
  let prev = input.current
  best.seq.forEach((c, pos) => {
    const t = pair(prev, c.track)
    schedule.push({
      itemId: c.track.itemId,
      position: pos,
      estStartAt: input.now + p.nomT * 1000,
      earliestStartAt: input.now + p.minT * 1000,
      latestStartAt: input.now + p.maxT * 1000,
      transitionStyle: t.style,
      transitionCost: t.cost,
    })
    if (!timedOk(c, p, input)) {
      conflicts.push({ itemId: c.track.itemId, kind: 'timed_slot_unreachable', message: 'This timed song cannot start at its target time with the current queue; it will play at the nearest boundary instead.' })
    }
    if (c.lockedIndex !== undefined && c.lockedIndex !== pos) {
      conflicts.push({ itemId: c.track.itemId, kind: 'locked_index_out_of_range', message: `Locked to position ${c.lockedIndex + 1}, but the queue is shorter.` })
    }
    p = extend(p, c, prev, pair, input)
    prev = c.track
  })
  const fifo = fifoOrder(input.items).map((i) => i.track.itemId)
  const order = best.seq.map((c) => c.track.itemId)
  return {
    order,
    schedule,
    conflicts,
    cost: best.cost,
    costParts: { transitions: best.transitions, fairness: best.fairness, votes: best.votes },
    reordered: order.some((id, i) => fifo[i] !== id),
    alternatives: alternatives.map((a) => ({ order: a.seq.map((c) => c.track.itemId), cost: a.cost })),
    explored,
  }
}

/** FIFO evaluation (used when AI reorder is off, and as the fallback when no feasible reorder exists). */
function evaluateFixed(seq: QueueCandidate[], input: QueuePlanInput, pair: PairCost): Partial {
  let p = rootPartial(input)
  let prev = input.current
  for (const c of seq) {
    p = extend(p, c, prev, pair, input)
    prev = c.track
  }
  return p
}

export function planQueue(input: QueuePlanInput): QueuePlan {
  const opts = input.transition ?? DEFAULT_OPTIONS
  const pair = makePairCost(opts)
  const { head, free } = splitHead(input)
  const fifoSeq = [...head, ...free]
  if (!input.aiReorder || free.length < 2) {
    return finish(evaluateFixed(fifoSeq, input, pair), input, pair, [], 1)
  }
  const maxDisp = input.maxDisplacement ?? 2
  const horizon = Math.min(input.horizon ?? 8, fifoSeq.length)
  const width = input.beamWidth ?? 64
  let beam: Partial[] = [evaluateFixed(head, input, pair)]
  let explored = 0
  for (let depth = head.length; depth < horizon; depth++) {
    const next: Partial[] = []
    for (const p of beam) {
      const used = new Set(p.seq)
      const prev = p.seq.length ? p.seq[p.seq.length - 1].track : input.current
      for (const c of free) {
        if (used.has(c)) continue
        if (violatesStatic(c, depth, maxDisp)) continue
        if (!timedOk(c, p, input)) continue
        // every remaining unplaced item must still be placeable within its displacement ceiling
        const child = extend(p, c, prev, pair, input)
        const remaining = free.filter((x) => x !== c && !used.has(x))
        if (remaining.some((x) => depth + 1 - x.fifoIndex > maxDisp && x.lockedIndex === undefined)) continue
        explored++
        next.push(child)
      }
    }
    if (!next.length) break
    next.sort((a, b) => a.cost - b.cost || orderKey(a).localeCompare(orderKey(b)))
    beam = next.slice(0, width)
  }
  // append any items beyond the horizon in FIFO order
  const complete = beam
    .map((p) => {
      const used = new Set(p.seq)
      const tail = free.filter((x) => !used.has(x))
      let q = p
      let prev = p.seq.length ? p.seq[p.seq.length - 1].track : input.current
      for (const c of tail) {
        q = extend(q, c, prev, pair, input)
        prev = c.track
      }
      return q
    })
    .filter((p) => p.seq.length === fifoSeq.length)
  if (!complete.length) return finish(evaluateFixed(fifoSeq, input, pair), input, pair, [], explored)
  complete.sort((a, b) => a.cost - b.cost || orderKey(a).localeCompare(orderKey(b)))
  return finish(complete[0], input, pair, complete.slice(1, 4), explored)
}

function orderKey(p: Partial): string {
  return p.seq.map((c) => c.track.itemId).join(',')
}

/** Exhaustive reference (toy sizes only): same constraints and objective as planQueue. */
export function bruteForceQueue(input: QueuePlanInput): { order: string[]; cost: number } | null {
  const opts = input.transition ?? DEFAULT_OPTIONS
  const pair = makePairCost(opts)
  const { head, free } = splitHead(input)
  const maxDisp = input.maxDisplacement ?? 2
  let best: Partial | null = null
  const rec = (p: Partial, rest: QueueCandidate[]) => {
    if (!rest.length) {
      if (!best || p.cost < best.cost - 1e-12 || (Math.abs(p.cost - best.cost) <= 1e-12 && orderKey(p) < orderKey(best))) best = p
      return
    }
    const depth = p.seq.length
    const prev = depth ? p.seq[depth - 1].track : input.current
    for (const c of rest) {
      if (violatesStatic(c, depth, maxDisp)) continue
      if (!timedOk(c, p, input)) continue
      rec(
        extend(p, c, prev, pair, input),
        rest.filter((x) => x !== c),
      )
    }
  }
  rec(evaluateFixed(head, input, pair), free)
  const b = best as Partial | null
  return b ? { order: b.seq.map((c) => c.track.itemId), cost: b.cost } : null
}
