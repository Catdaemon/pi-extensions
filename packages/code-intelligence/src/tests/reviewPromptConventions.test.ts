import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildCodeIntelligenceReviewPrompt, buildReviewBatchActionPrompt, buildSubagentReviewTaskTemplate } from '../extension.ts'
import type { ImproveCodeIntelligenceResult } from '../pi/improveIntegration.ts'

const scope = {
  mode: 'git_changes' as const,
  summary: 'Use current git changes.',
  details: 'Changed files: src/api.ts',
}

const intelligence: ImproveCodeIntelligenceResult = {
  enabled: true,
  mode: 'review',
  changedFiles: ['src/api.ts'],
}

describe('review prompt convention guidance', () => {
  it('requires convention checks before suggesting validation fixes', () => {
    const prompt = buildCodeIntelligenceReviewPrompt(scope, undefined, intelligence)

    assert.match(prompt, /Before proposing any validation, parsing, auth, data-access, API, or test fix/)
    assert.match(prompt, /shared schemas, validators, safeParse\/parse helpers/)
    assert.match(prompt, /Do not suggest ad-hoc validation\/parsing\/auth\/test helpers/)
  })

  it('passes convention guidance to review subagents', () => {
    const template = buildSubagentReviewTaskTemplate()

    assert.match(template, /Before proposing any validation, parsing, auth, data-access, API, or test fix/)
    assert.match(template, /ad-hoc validation\/parsing when shared schemas or local conventions exist/)
  })

  it('requires fix actions to inspect local patterns before editing', () => {
    const prompt = buildReviewBatchActionPrompt([
      {
        action: 'fix',
        finding: {
          id: 'CI-1',
          title: 'Missing validation',
          file: 'src/api.ts',
          suggestedFix: 'Add validation.',
        },
      },
    ])

    assert.match(prompt, /inspect related local patterns before editing/)
    assert.match(prompt, /Use existing schemas\/helpers\/middleware\/test factories/)
  })
})
