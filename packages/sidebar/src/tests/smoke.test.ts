import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { STATUS_CARD_OVERLAY_WIDTH, getStatusCardTop, registerStatusCard, unregisterStatusCard, updateStatusCardLayout } from '../../index.ts'

describe('@catdaemon/pi-sidebar', () => {
  it('exports shared status-card helpers', () => {
    assert.equal(STATUS_CARD_OVERLAY_WIDTH, 44)
  })

  it('stacks visible cards by order', () => {
    registerStatusCard('test-a', 10)
    registerStatusCard('test-b', 20)
    try {
      updateStatusCardLayout('test-a', { visible: true, height: 3 })
      updateStatusCardLayout('test-b', { visible: true, height: 2 })
      assert.equal(getStatusCardTop('test-a'), 0)
      assert.equal(getStatusCardTop('test-b'), 4)
    } finally {
      unregisterStatusCard('test-a')
      unregisterStatusCard('test-b')
    }
  })
})
