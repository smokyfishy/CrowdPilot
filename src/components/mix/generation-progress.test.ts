import { describe, expect, it } from 'vitest'
import { PHASES, friendlyError, summarizeProgress } from './generation-progress'

describe('summarizeProgress', () => {
  it('starts at the first phase with no events', () => {
    const s = summarizeProgress({ stage: undefined, events: {}, pass: 'prepare' })
    expect(s.phase).toBe(0)
    expect(s.overall).toBe(0)
    expect(s.message).toMatch(/description/i)
  })

  it('maps the eleven pipeline stages onto four phases', () => {
    const at = (stage: string) => summarizeProgress({ stage, events: {}, pass: 'prepare' }).phase
    expect(['understanding', 'discovering', 'resolving'].map(at)).toEqual([0, 0, 0])
    expect(['acquiring', 'analyzing', 'selecting'].map(at)).toEqual([1, 1, 1])
    expect(['ordering', 'transitions', 'rendering'].map(at)).toEqual([2, 2, 2])
    expect(['validating', 'ready'].map(at)).toEqual([3, 3])
    expect(PHASES).toHaveLength(4)
  })

  it('weights the current stage by its real done/total counts', () => {
    const half = summarizeProgress({ stage: 'analyzing', events: { acquiring: { done: 10, total: 10 }, analyzing: { done: 5, total: 10 } }, pass: 'prepare' })
    const more = summarizeProgress({ stage: 'analyzing', events: { acquiring: { done: 10, total: 10 }, analyzing: { done: 9, total: 10 } }, pass: 'prepare' })
    expect(more.overall).toBeGreaterThan(half.overall)
    // acquiring is in the same block as analyzing: reporting analyzing does not mark acquiring complete
    const acqPartial = summarizeProgress({ stage: 'analyzing', events: { acquiring: { done: 5, total: 10 }, analyzing: { done: 5, total: 10 } }, pass: 'prepare' })
    expect(acqPartial.overall).toBeLessThan(half.overall)
  })

  it('treats earlier stages as complete once a later stage is reached', () => {
    const s = summarizeProgress({ stage: 'selecting', events: { selecting: { done: 0, total: 1 } }, pass: 'prepare' })
    expect(s.overall).toBeGreaterThan(0.45)
    expect(s.overall).toBeLessThan(0.6)
  })

  it('never moves backwards during the render pass when early stages re-run', () => {
    const endOfPrepare = summarizeProgress({ stage: 'transitions', events: { transitions: { done: 11, total: 11 } }, pass: 'prepare' })
    const rerun = summarizeProgress({ stage: 'acquiring', events: { acquiring: { done: 1, total: 12 } }, pass: 'render' })
    expect(rerun.phase).toBe(2)
    expect(rerun.overall).toBeGreaterThanOrEqual(endOfPrepare.overall)
  })

  it('reaches 100% only when ready', () => {
    expect(summarizeProgress({ stage: 'validating', events: { validating: { done: 1, total: 1 } }, pass: 'render' }).overall).toBeLessThan(1)
    expect(summarizeProgress({ stage: 'ready', events: { ready: { done: 1, total: 1 } }, pass: 'render' }).overall).toBe(1)
  })

  it('ignores malformed counts', () => {
    const s = summarizeProgress({ stage: 'analyzing', events: { analyzing: { done: 7, total: 0 }, acquiring: { done: 99, total: 3 } }, pass: 'prepare' })
    expect(s.overall).toBeGreaterThanOrEqual(0)
    expect(s.overall).toBeLessThanOrEqual(1)
  })
})

describe('friendlyError', () => {
  it('explains a too-small catalog result', () => {
    const e = friendlyError('Only 1 recording(s) could be acquired and analyzed — not enough for a mix. x: y')
    expect(e.title).toMatch(/enough/i)
    expect(e.retryable).toBe(true)
  })
  it('explains connection problems', () => {
    expect(friendlyError('Failed to fetch').title).toMatch(/connection/i)
  })
  it('explains an expired session', () => {
    expect(friendlyError('Saving progress failed (401): unauthorized').title).toMatch(/sign/i)
  })
  it('falls back to a generic, retryable message', () => {
    const e = friendlyError('mix planning failed: no feasible path')
    expect(e.retryable).toBe(true)
    expect(e.title).not.toMatch(/feasible/)
  })
})
