import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildLearningCaptureGuidance } from '../extension.ts'

describe('agent-driven learning capture guidance', () => {
  it('tells the agent to use the explicit learning tool for durable guidance only', () => {
    const guidance = buildLearningCaptureGuidance()

    assert.match(guidance, /code_intelligence_record_learning/)
    assert.match(guidance, /durable repo guidance/)
    assert.match(guidance, /Do not record ordinary one-off task requirements/)
    assert.match(guidance, /Always look up codebase conventions for UI work/)
  })
})
