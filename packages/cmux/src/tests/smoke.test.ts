import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import cmuxIntegration, { isCmuxEnvironment } from '../../index.ts'

describe('pi-cmux package', () => {
  it('exports a Pi extension factory', () => {
    assert.equal(typeof cmuxIntegration, 'function')
  })

  it('detects cmux environment only with workspace and surface ids', () => {
    assert.equal(isCmuxEnvironment({}), false)
    assert.equal(isCmuxEnvironment({ CMUX_WORKSPACE_ID: 'w' }), false)
    assert.equal(isCmuxEnvironment({ CMUX_WORKSPACE_ID: 'w', CMUX_SURFACE_ID: 's' }), true)
  })
})
