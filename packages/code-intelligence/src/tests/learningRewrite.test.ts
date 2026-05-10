import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseLearningRewrite } from '../pi/learningRewrite.ts'

describe('LLM learning rewrite parsing', () => {
  it('parses nuanced draft guidance without turning it into a hard rule', () => {
    const learning = parseLearningRewrite(JSON.stringify({
      title: 'Prefer type inference over type assertions',
      summary: 'Prefer TypeScript inference or explicit typed declarations over unnecessary type assertions.',
      ruleType: 'style',
      appliesWhen: 'When writing TypeScript code.',
      avoid: 'unnecessary type assertions',
      prefer: 'type inference or explicit typed declarations',
      pathGlobs: ['**/*.ts', '**/*.tsx'],
      languages: ['typescript'],
      confidence: 0.75,
      priority: 70,
      status: 'active',
    }))

    assert.equal(learning?.status, 'draft')
    assert.equal(learning?.confidence, 0.75)
    assert.equal(learning?.ruleType, 'style')
    assert.deepEqual(learning?.languages, ['typescript'])
  })

  it('ignores null and malformed rewrite output', () => {
    assert.equal(parseLearningRewrite('null'), undefined)
    assert.equal(parseLearningRewrite('not json'), undefined)
  })
})
