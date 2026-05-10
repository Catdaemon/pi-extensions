import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import piWebTools from '../../index.ts'

describe('pi-web-tools package', () => {
  it('exports a Pi extension factory', () => {
    assert.equal(typeof piWebTools, 'function')
  })
})
