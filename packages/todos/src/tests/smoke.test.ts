import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import extension from '../../index.ts'

describe('pi-agent-todos package', () => {
  it('exports a Pi extension factory', () => {
    assert.equal(typeof extension, 'function')
  })
})
