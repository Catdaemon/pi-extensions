import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { openCodeIntelligenceDb } from '../db/connection.ts'
import { createLearning, isDatabaseLockedError, listLearnings, retrieveLearningFts } from '../db/repositories/learningsRepo.ts'
import { getLearningEmbeddingStats } from '../db/repositories/learningEmbeddingsRepo.ts'
import { embedLearningIfReady } from '../embeddings/learningEmbeddingIndexer.ts'
import { MockEmbeddingService } from '../embeddings/mockEmbeddingService.ts'
import { extractManualLearning } from '../learnings/extractLearning.ts'
import { buildContextPack } from '../retrieval/contextPack.ts'
import { retrieveLearningsHybrid } from '../retrieval/retrieveLearnings.ts'

describe('manual codebase learnings', () => {
  it('recognizes transient SQLite lock errors', () => {
    assert.equal(isDatabaseLockedError(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })), true)
    assert.equal(isDatabaseLockedError(new Error('database is busy')), true)
    assert.equal(isDatabaseLockedError(new Error('schema mismatch')), false)
  })

  it('extracts obvious manual learning patterns', () => {
    const avoid = extractManualLearning('Do not use moment.js, use date-fns')
    assert.equal(avoid?.ruleType, 'avoid_pattern')
    assert.equal(avoid?.avoid, 'moment.js')
    assert.equal(avoid?.prefer, 'date-fns')

    const prefer = extractManualLearning('prefer Zustand over React context')
    assert.equal(prefer?.ruleType, 'prefer_pattern')
    assert.equal(prefer?.prefer, 'Zustand')
    assert.equal(prefer?.avoid, 'React context')

    const tests = extractManualLearning('always add tests under test/api')
    assert.equal(tests?.ruleType, 'testing_convention')
    assert.deepEqual(tests?.pathGlobs, ['test/api'])

    const makeSure = extractManualLearning('make sure we use explicit return types instead of inferred API response types')
    assert.equal(makeSure?.ruleType, 'prefer_pattern')
    assert.equal(makeSure?.prefer, 'explicit return types')
    assert.equal(makeSure?.avoid, 'inferred API response types')
    assert.equal(makeSure?.status, 'draft')

    const favor = extractManualLearning('favor integration tests over mocked route handlers')
    assert.equal(favor?.ruleType, 'prefer_pattern')
    assert.equal(favor?.prefer, 'integration tests')
    assert.equal(favor?.avoid, 'mocked route handlers')

    const alwaysTests = extractManualLearning('always write tests for changes we make')
    assert.equal(alwaysTests?.ruleType, 'testing_convention')
    assert.equal(alwaysTests?.status, 'active')
  })

  it('stores, dedupes, embeds, and retrieves learnings in context packs', async () => {
    const storage = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-learning-db-'))
    const db = await openCodeIntelligenceDb(storage)
    const repoKey = 'learning-repo'
    const embeddingService = new MockEmbeddingService(64)

    try {
      const candidate = extractManualLearning('Do not use moment.js, use date-fns')
      assert(candidate)
      const learning = createLearning(db, repoKey, candidate)
      assert.equal(learning.status, 'active')
      assert.equal(listLearnings(db, repoKey, 'active').length, 1)

      const duplicate = createLearning(db, repoKey, candidate)
      assert.equal(duplicate.id, learning.id)
      assert.equal(listLearnings(db, repoKey, 'active').length, 1)

      assert.equal(await embedLearningIfReady(db, embeddingService, learning), true)
      assert.equal(getLearningEmbeddingStats(db, repoKey).embeddedLearnings, 1)

      const fts = retrieveLearningFts(db, { repoKey, query: 'moment date-fns', limit: 5 })
      assert.equal(fts[0]?.id, learning.id)
      assert(fts[0]?.reasons.includes('fts_match'))

      const hybrid = await retrieveLearningsHybrid(db, embeddingService, { repoKey, query: 'date handling library', maxLearnings: 5 })
      assert(hybrid.some((item) => item.id === learning.id))

      const pack = buildContextPack({ db, repoKey, codeContext: [], learnings: hybrid, maxTotalContextChars: 4000 })
      assert(pack.promptText.includes('Relevant Codebase Learnings'))
      assert(pack.promptText.includes('date-fns'))
    } finally {
      db.close()
      await rm(storage, { recursive: true, force: true })
    }
  })
})
