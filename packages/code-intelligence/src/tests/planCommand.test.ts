import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildPlanCommandPrompt } from '../pi/planCommand.ts'

describe('/plan command prompt', () => {
  it('builds an interview-first planning prompt with implementation handoff structure', () => {
    const prompt = buildPlanCommandPrompt({ task: 'Add passkey login to the auth flow' })

    assert.match(prompt, /Do not edit files/)
    assert.match(prompt, /Interview the user/)
    assert.match(prompt, /code_intelligence_search/)
    assert.match(prompt, /code_intelligence_impact/)
    assert.match(prompt, /Milestones with concrete subtasks/)
    assert.match(prompt, /todo_write list early/)
    assert.match(prompt, /Ready-to-run implementation prompt/)
  })

  it('includes code intelligence warnings when context is unavailable', () => {
    const prompt = buildPlanCommandPrompt({ task: 'Refactor billing', warning: 'Code intelligence is not enabled.' })

    assert.match(prompt, /Code intelligence warning:/)
    assert.match(prompt, /Code intelligence is not enabled\./)
  })
})
