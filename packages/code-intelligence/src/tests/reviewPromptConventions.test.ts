import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildCodeIntelligenceReviewPrompt, buildReviewBatchActionPrompt, buildSubagentCodeIntelligenceReviewPrompt, buildSubagentReviewTaskTemplate } from '../extension.ts'
import { buildReviewQueries } from '../pi/reviewContext.ts'
import type { ReviewCodeIntelligenceResult } from '../pi/reviewContext.ts'

const scope = {
  mode: 'git_changes' as const,
  summary: 'Use current git changes.',
  details: 'Changed files: src/api.ts',
}

const intelligence: ReviewCodeIntelligenceResult = {
  enabled: true,
  changedFiles: ['src/api.ts'],
}

function buildDirectReviewPrompt(): string {
  return buildCodeIntelligenceReviewPrompt(scope, undefined, intelligence)
}

describe('review prompt convention guidance', () => {
  it('requires convention checks before suggesting validation fixes', () => {
    const prompt = buildDirectReviewPrompt()

    assert.match(prompt, /Before proposing any validation, parsing, auth, data-access, API, or test fix/)
    assert.match(prompt, /shared schemas, validators, safeParse\/parse helpers/)
    assert.match(prompt, /Do not suggest ad-hoc validation\/parsing\/auth\/test helpers/)
  })

  it('passes convention guidance to review subagents', () => {
    const template = buildSubagentReviewTaskTemplate()

    assert.match(template, /Before proposing any validation, parsing, auth, data-access, API, or test fix/)
    assert.match(template, /Do not suggest ad-hoc validation\/parsing\/auth\/test helpers/)
  })

  it('flags tests-for-tests-sake as AI-slop', () => {
    const prompt = buildDirectReviewPrompt()
    const template = buildSubagentReviewTaskTemplate()
    const queries = buildReviewQueries({ baseQuery: 'base', focus: '', changedFiles: ['src/config.test.ts'] })

    assert.match(prompt, /tests-for-tests-sake/)
    assert.match(prompt, /configuration object/)
    assert.match(template, /tests-for-tests-sake/)
    assert(queries.some((query) => /configuration objects/.test(query) && /without exercising behavior/.test(query)))
  })

  it('includes simplify quality and efficiency review rules', () => {
    const prompt = buildDirectReviewPrompt()
    const template = buildSubagentReviewTaskTemplate()

    for (const text of [prompt, template]) {
      assert.match(text, /stringly-typed code/)
      assert.match(text, /parameter sprawl/)
      assert.match(text, /redundant or derivable state/)
      assert.match(text, /nested conditionals/)
      assert.match(text, /missed concurrency/)
      assert.match(text, /recurring no-op updates/)
      assert.match(text, /unnecessary existence pre-checks/)
      assert.match(text, /overly broad operations/)
    }
  })

  it('requires regression checks, zero-finding challenge, and counterpart checks', () => {
    const prompt = buildDirectReviewPrompt()
    const template = buildSubagentReviewTaskTemplate()

    assert.match(prompt, /regression test/)
    assert.match(prompt, /Before returning no findings/)
    assert.match(prompt, /tests\/counterparts/)
    assert.match(prompt, /coverage row per changed file/)
    assert.match(template, /regression test/)
    assert.match(template, /Before returning no findings/)
    assert.match(template, /tests\/counterparts/)
    assert.match(template, /counterpart tests/)
  })

  it('passes diff preflight warnings into subagent review prompts', () => {
    const prompt = buildSubagentCodeIntelligenceReviewPrompt(scope, undefined, {
      ...intelligence,
      reviewWarnings: 'Code intelligence diff review warnings:\n- [warning] src/api.ts: Added code resembles existing indexed code; check whether an existing helper should be reused. (duplicate_added_text: normalizeProvider; similar to src/existing.ts:1-4)',
    })

    assert.match(prompt, /Preflight warnings to verify/)
    assert.match(prompt, /Added code resembles existing indexed code/)
    assert.match(prompt, /verify\/dismiss preflight warnings with evidence/)
  })

  it('fans out subagent review by review focus, not only file count', () => {
    const prompt = buildSubagentCodeIntelligenceReviewPrompt(scope, undefined, {
      ...intelligence,
      reviewPackets: [{
        file: 'src/api.ts',
        changedRanges: [],
        changedDeclarations: [],
        relatedFiles: [],
        testCounterparts: [],
        testStatus: 'unknown',
        queryFocus: ['api review'],
        relevantSnippets: [],
      }],
    })

    assert.match(prompt, /Worker plan: 3 worker task/)
    assert.match(prompt, /runtime contracts/)
    assert.match(prompt, /regression checks/)
    assert.match(prompt, /DRY\/reuse/)
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
