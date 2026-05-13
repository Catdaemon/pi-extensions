import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_CONFIG } from '../config.ts'
import {
  buildPlanningContextRequest,
  extractMentionedFilePaths,
  findSourceTestCounterparts,
  formatPlanningContextMessage,
  shouldRetrievePlanningContext,
} from '../pi/planningIntegration.ts'
import type { ContextPack } from '../retrieval/contextPack.ts'

describe('planning integration request construction', () => {
  it('detects non-trivial code-change and behavior-tracing prompts while ignoring trivial prompts', () => {
    assert.equal(shouldRetrievePlanningContext('Add a new invoice filter endpoint'), true)
    assert.equal(shouldRetrievePlanningContext('Fix failing tests in src/routes/invoices.ts'), true)
    assert.equal(shouldRetrievePlanningContext('How often does the app refresh the job list?'), true)
    assert.equal(shouldRetrievePlanningContext('Where is route polling configured?'), true)
    assert.equal(shouldRetrievePlanningContext('What controls React Query invalidation for jobs?'), true)
    assert.equal(shouldRetrievePlanningContext('looks good'), false)
    assert.equal(shouldRetrievePlanningContext('ok'), false)
  })

  it('extracts mentioned files and source/test counterpart candidates', () => {
    assert.deepEqual(extractMentionedFilePaths('Update `src/routes/invoices.ts` and README.md'), [
      'src/routes/invoices.ts',
      'README.md',
    ])

    const counterparts = findSourceTestCounterparts(['src/routes/invoices.ts'], DEFAULT_CONFIG)
    assert(counterparts.includes('src/routes/invoices.test.ts'))
    assert(counterparts.includes('test/invoices.test.ts'))
  })

  it('builds compact planning context requests with budgets', () => {
    const request = buildPlanningContextRequest({
      repoKey: 'repo',
      task: 'Refactor src/routes/invoices.ts and add tests',
      config: DEFAULT_CONFIG,
    })

    assert.equal(request.repoKey, 'repo')
    assert.equal(request.query, 'Refactor src/routes/invoices.ts and add tests')
    assert.deepEqual(request.currentFiles, ['src/routes/invoices.ts'])
    assert(request.sourceTestCounterpartFiles?.includes('src/routes/invoices.test.ts'))
    assert.equal(request.maxCodeChunks, DEFAULT_CONFIG.maxCodeChunks)
    assert.equal(request.maxTotalContextChars, DEFAULT_CONFIG.maxTotalContextChars)
  })

  it('formats prompt-ready context without telling the model to dump raw context', () => {
    const pack: ContextPack = {
      codeContext: [
        {
          id: 1,
          path: 'src/routes/invoices.ts',
          chunkKind: 'function',
          startLine: 1,
          endLine: 3,
          content: 'export function route() {}',
          score: 1,
          reasons: ['fts_match'],
        },
      ],
      learnings: [],
      hardRules: [],
      warnings: [],
      freshness: {
        indexState: 'fresh',
        pendingFiles: 0,
        embeddingState: 'ready',
      },
      promptText: '# Local Codebase Context\n...',
    }

    const message = formatPlanningContextMessage(pack)
    assert(message.includes('Use this local code intelligence context silently'))
    assert(message.includes('Freshness: index=fresh, embeddings=ready'))
  })
})
