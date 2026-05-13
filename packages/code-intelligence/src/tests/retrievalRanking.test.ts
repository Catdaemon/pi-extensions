import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { openCodeIntelligenceDb } from '../db/connection.ts'
import type { EmbeddingService } from '../embeddings/EmbeddingService.ts'
import { retrievalRankingAdjustment, retrieveCodeHybrid } from '../retrieval/retrieveCode.ts'

describe('retrieval ranking adjustment', () => {
  it('favors implementation files over docs and tests for implementation queries', () => {
    const query = 'where is code intelligence review prompt built and how does it include graph context for changed files'

    assert(retrievalRankingAdjustment({ path: 'packages/code-intelligence/src/extension.ts', chunk_kind: 'function', symbol_kind: 'function' }, query) > 0)
    assert(retrievalRankingAdjustment({ path: 'packages/code-intelligence/README.md', chunk_kind: 'markdown', symbol_kind: 'heading' }, query) < 0)
    assert(retrievalRankingAdjustment({ path: 'packages/code-intelligence/src/tests/reviewContext.test.ts', chunk_kind: 'function', symbol_kind: 'test_case' }, query) < 0)
  })

  it('does not penalize documentation when the query asks for docs', () => {
    const query = 'README documentation for code intelligence review usage'
    assert.equal(retrievalRankingAdjustment({ path: 'packages/code-intelligence/README.md', chunk_kind: 'markdown', symbol_kind: 'heading' }, query), 0)
  })

  it('falls back when embedding execution fails', async () => {
    const storage = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-retrieval-'))
    const db = await openCodeIntelligenceDb(storage)
    const embeddingService: EmbeddingService = {
      provider: 'transformers',
      modelId: 'test-model',
      dimensions: 2,
      status: 'ready',
      ensureReady: async () => {},
      embedTexts: async () => { throw new Error('embedding failed') },
    }
    try {
      const results = await retrieveCodeHybrid(db, embeddingService, { repoKey: 'retrieval-repo', query: 'anything' })
      assert.deepEqual(results, [])
    } finally {
      db.close()
      await rm(storage, { recursive: true, force: true })
    }
  })
})
