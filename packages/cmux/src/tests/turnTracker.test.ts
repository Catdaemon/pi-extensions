import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createCmuxTurnTrackerForTest } from '../cmuxIntegration.ts'

describe('cmux turn tracker', () => {
  it('does not finish ignored subagent turns', () => {
    const tracker = createCmuxTurnTrackerForTest()
    tracker.start({ key: 'subagent', prompt: 'subagent work', ignored: true, now: 1000 })

    assert.equal(tracker.activeCount(), 0)
    assert.equal(tracker.finish('subagent'), undefined)
  })

  it('keeps workspace running until all tracked turns finish', () => {
    const tracker = createCmuxTurnTrackerForTest()
    tracker.start({ key: 'main', prompt: 'main work', ignored: false, now: 1000 })
    tracker.start({ key: 'worker', prompt: 'worker work', ignored: false, now: 2000 })

    const first = tracker.finish('worker')
    assert.equal(first?.remainingActiveTurns, 1)
    assert.equal(tracker.activeCount(), 1)

    const second = tracker.finish('main')
    assert.equal(second?.remainingActiveTurns, 0)
    assert.equal(tracker.activeCount(), 0)
  })
})
