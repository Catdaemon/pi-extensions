import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { eq } from 'drizzle-orm'
import { DEFAULT_CONFIG } from '../config.ts'
import { openCodeIntelligenceDb } from '../db/connection.ts'
import { codeEntities, codeRelationships, learnings } from '../db/schema.ts'
import { getChunkStats } from '../db/repositories/chunksRepo.ts'
import { getEmbeddingStats } from '../db/repositories/embeddingsRepo.ts'
import { getEmbeddingStatus } from '../db/repositories/embeddingStatusRepo.ts'
import { getIndexedFileByPath } from '../db/repositories/filesRepo.ts'
import { getLearningEmbeddingStats } from '../db/repositories/learningEmbeddingsRepo.ts'
import { createLearning, getLearning, listLearnings, updateLearningStatus } from '../db/repositories/learningsRepo.ts'
import {
  consolidateSimilarLearnings,
  findStaleLearnings,
  forgetAllLearnings,
  forgetLearning,
  resetCodeIndex,
  resetEmbeddings,
  supersedeLearning,
} from '../db/repositories/maintenanceRepo.ts'
import { listMachineRules } from '../db/repositories/rulesRepo.ts'
import { MockEmbeddingService } from '../embeddings/mockEmbeddingService.ts'
import { embedLearningIfReady } from '../embeddings/learningEmbeddingIndexer.ts'
import { extractManualLearning } from '../learnings/extractLearning.ts'
import { runFullRepoIndex } from '../indexing/indexScheduler.ts'
import { retrieveLearningsHybrid } from '../retrieval/retrieveLearnings.ts'
import type { RepoIdentity } from '../repo/identifyRepo.ts'
import type { CodeIntelligenceLogger } from '../logger.ts'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as CodeIntelligenceLogger

describe('maintenance controls', () => {
  it('forgets a learning and disables derived rules', async () => {
    const { db, storage } = await setupDb()
    try {
      const candidate = extractManualLearning('Do not use moment.js, use date-fns')
      assert(candidate)
      const learning = createLearning(db, 'maintenance-repo', candidate)
      assert.equal(listMachineRules(db, 'maintenance-repo', 'active').length, 1)

      assert.equal(forgetLearning(db, learning.id), true)
      assert.equal(listLearnings(db, 'maintenance-repo', 'rejected').length, 1)
      assert.equal(listMachineRules(db, 'maintenance-repo', 'active').length, 0)
      assert.equal(listMachineRules(db, 'maintenance-repo', 'disabled').length, 1)
    } finally {
      db.close()
      await rm(storage, { recursive: true, force: true })
    }
  })

  it('updates learning status and refreshes derived machine rules', async () => {
    const { db, storage } = await setupDb()
    try {
      const candidate = extractManualLearning('Do not use moment.js, use date-fns')
      assert(candidate)
      const learning = createLearning(db, 'maintenance-repo', { ...candidate, status: 'draft' })
      assert.equal(listMachineRules(db, 'maintenance-repo', 'active').length, 0)

      updateLearningStatus(db, learning.id, 'active')
      assert.equal(getLearning(db, learning.id)?.status, 'active')
      assert.equal(listMachineRules(db, 'maintenance-repo', 'active').length, 1)

      updateLearningStatus(db, learning.id, 'draft')
      assert.equal(getLearning(db, learning.id)?.status, 'draft')
      assert.equal(listMachineRules(db, 'maintenance-repo', 'active').length, 0)
    } finally {
      db.close()
      await rm(storage, { recursive: true, force: true })
    }
  })

  it('forgets all active and draft learnings without deleting records', async () => {
    const { db, storage } = await setupDb()
    try {
      const first = extractManualLearning('Do not use moment.js, use date-fns')
      const second = extractManualLearning('that is wrong here')
      assert(first && second)
      createLearning(db, 'maintenance-repo', first)
      createLearning(db, 'maintenance-repo', { ...second, status: 'draft', confidence: 0.65 })

      assert.equal(forgetAllLearnings(db, 'maintenance-repo'), 2)
      assert.equal(listLearnings(db, 'maintenance-repo', 'active').length, 0)
      assert.equal(listLearnings(db, 'maintenance-repo', 'draft').length, 0)
      assert.equal(listLearnings(db, 'maintenance-repo', 'rejected').length, 2)
    } finally {
      db.close()
      await rm(storage, { recursive: true, force: true })
    }
  })

  it('supersedes a learning, disables derived rules, and removes it from retrieval', async () => {
    const { db, storage } = await setupDb()
    try {
      const oldLearning = createLearning(db, 'maintenance-repo', extractManualLearning('Do not use moment.js, use date-fns')!)
      const replacement = createLearning(db, 'maintenance-repo', extractManualLearning('Do not use moment, use date-fns')!)
      assert.equal(listMachineRules(db, 'maintenance-repo', 'active').length, 2)

      assert.equal(
        supersedeLearning(db, {
          repoKey: 'maintenance-repo',
          supersededLearningId: oldLearning.id,
          replacementLearningId: replacement.id,
          reason: 'test',
        }),
        true
      )
      assert.equal(getLearning(db, oldLearning.id)?.status, 'superseded')
      assert.equal(getLearning(db, oldLearning.id)?.supersededBy, replacement.id)
      assert.equal(listMachineRules(db, 'maintenance-repo', 'active').some((rule) => rule.learningId === oldLearning.id), false)

      const results = await retrieveLearningsHybrid(db, undefined, { repoKey: 'maintenance-repo', query: 'moment date-fns' })
      assert.equal(results.some((learning) => learning.id === oldLearning.id), false)
      assert.equal(results.some((learning) => learning.id === replacement.id), true)
    } finally {
      db.close()
      await rm(storage, { recursive: true, force: true })
    }
  })

  it('detects stale low-confidence learnings and boosts retrieved learnings', async () => {
    const { db, storage } = await setupDb()
    try {
      const stale = createLearning(db, 'maintenance-repo', {
        ...extractManualLearning('Prefer Zustand over React context')!,
        confidence: 0.65,
        priority: 20,
      })
      const fresh = createLearning(db, 'maintenance-repo', extractManualLearning('Do not use moment.js, use date-fns')!)
      const oldDate = '2026-01-01T00:00:00.000Z'
      db.update(learnings).set({ updatedAt: oldDate, createdAt: oldDate, lastUsedAt: null }).where(eq(learnings.id, stale.id)).run()

      const staleLearnings = findStaleLearnings(db, {
        repoKey: 'maintenance-repo',
        inactiveDays: 30,
        now: new Date('2026-05-09T00:00:00.000Z'),
        includeDrafts: true,
      })
      assert.equal(staleLearnings.map((learning) => learning.id).includes(stale.id), true)
      assert.equal(staleLearnings.map((learning) => learning.id).includes(fresh.id), false)

      const before = getLearning(db, stale.id)!
      const results = await retrieveLearningsHybrid(db, undefined, { repoKey: 'maintenance-repo', query: 'zustand context' })
      assert.equal(results.some((learning) => learning.id === stale.id), true)
      const after = getLearning(db, stale.id)!
      assert(after.confidence > before.confidence)
      assert(after.priority > before.priority)
      assert(after.lastUsedAt)
    } finally {
      db.close()
      await rm(storage, { recursive: true, force: true })
    }
  })

  it('consolidates similar learnings by superseding duplicates and boosting the keeper', async () => {
    const { db, storage } = await setupDb()
    try {
      const keeper = createLearning(db, 'maintenance-repo', { ...extractManualLearning('Do not use moment, use date-fns')!, confidence: 0.9, priority: 70 })
      const duplicate = createLearning(db, 'maintenance-repo', { ...extractManualLearning('Do not use moment.js, use date-fns')!, confidence: 0.7, priority: 60 })
      assert.notEqual(keeper.id, duplicate.id)

      const result = consolidateSimilarLearnings(db, 'maintenance-repo')
      assert.equal(result.supersededCount, 1)
      assert.equal(getLearning(db, duplicate.id)?.status, 'superseded')
      assert.equal(getLearning(db, duplicate.id)?.supersededBy, keeper.id)
      assert(Math.abs((getLearning(db, keeper.id)?.confidence ?? 0) - 0.92) < 0.0001)
      assert.equal(listMachineRules(db, 'maintenance-repo', 'active').some((rule) => rule.learningId === duplicate.id), false)
    } finally {
      db.close()
      await rm(storage, { recursive: true, force: true })
    }
  })

  it('resets code index without deleting learnings and resets embeddings without deleting FTS data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-maintenance-repo-'))
    const { db, storage } = await setupDb()
    try {
      await mkdir(join(root, 'src'), { recursive: true })
      await writeFile(join(root, 'src', 'app.ts'), 'export function app() { return "invoice" }\n')
      const identity: RepoIdentity = { repoKey: 'maintenance-repo', gitRoot: root, identitySource: 'path' }
      const embeddingService = new MockEmbeddingService(64)
      await runFullRepoIndex(
        { identity, db, config: { ...DEFAULT_CONFIG, include: ['src/**'] }, logger: silentLogger, embeddingService },
        'test'
      )
      const learning = createLearning(db, 'maintenance-repo', extractManualLearning('Do not use moment.js, use date-fns')!)
      await embedLearningIfReady(db, embeddingService, learning)

      assert(getChunkStats(db, 'maintenance-repo').totalChunks > 0)
      assert(getEmbeddingStats(db, 'maintenance-repo').embeddedChunks > 0)
      assert.equal(getLearningEmbeddingStats(db, 'maintenance-repo').embeddedLearnings, 1)

      const embeddingReset = resetEmbeddings(db, 'maintenance-repo')
      assert(embeddingReset.deletedChunkEmbeddings > 0)
      assert.equal(embeddingReset.deletedLearningEmbeddings, 1)
      assert.equal(getEmbeddingStatus(db)?.status, 'not_started')
      assert(getChunkStats(db, 'maintenance-repo').totalChunks > 0)
      assert.equal(listLearnings(db, 'maintenance-repo', 'active').length, 1)

      const entity = db.select().from(codeEntities).where(eq(codeEntities.repoKey, 'maintenance-repo')).get()
      assert(entity)
      db.insert(codeRelationships).values({
        repoKey: 'stale-mismatched-repo-key',
        sourceEntityId: entity.id,
        targetEntityId: entity.id,
        sourcePath: 'src/app.ts',
        targetPath: 'src/app.ts',
        sourceName: 'app',
        targetName: 'app',
        kind: 'calls',
        confidence: 0.5,
        metadataJson: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run()

      const indexReset = resetCodeIndex(db, 'maintenance-repo')
      assert.equal(indexReset.deletedFiles, 1)
      assert(getIndexedFileByPath(db, 'maintenance-repo', 'src/app.ts') === undefined)
      assert.equal(getChunkStats(db, 'maintenance-repo').totalChunks, 0)
      assert.equal(listLearnings(db, 'maintenance-repo', 'active').length, 1)
    } finally {
      db.close()
      await rm(root, { recursive: true, force: true })
      await rm(storage, { recursive: true, force: true })
    }
  })
})

async function setupDb() {
  const storage = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-maintenance-db-'))
  const db = await openCodeIntelligenceDb(storage)
  return { db, storage }
}
