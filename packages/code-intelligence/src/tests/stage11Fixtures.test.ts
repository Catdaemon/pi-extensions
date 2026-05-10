import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DEFAULT_CONFIG } from '../config.ts'
import { openCodeIntelligenceDb } from '../db/connection.ts'
import { getRelationshipStats, listCodeRelationshipsForPath } from '../db/repositories/relationshipsRepo.ts'
import { MockEmbeddingService } from '../embeddings/mockEmbeddingService.ts'
import { runFullRepoIndex } from '../indexing/indexScheduler.ts'
import type { CodeIntelligenceLogger } from '../logger.ts'
import { retrieveReviewContext } from '../retrieval/graphContext.ts'
import type { RepoIdentity } from '../repo/identifyRepo.ts'
import { writeBuggyChangeFixture, writeReactExpoFixture, writeSchemaAndSimilarityFixture, writeTsImportFixture } from './fixtures.ts'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as CodeIntelligenceLogger

describe('stage 11 fixture repos', () => {
  it('covers TS imports, React/Expo, tests, schemas, similarity, and review context within bounds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-stage11-fixture-'))
    const storage = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-stage11-db-'))
    const db = await openCodeIntelligenceDb(storage)
    try {
      await writeTsImportFixture(root)
      await writeReactExpoFixture(root)
      await writeSchemaAndSimilarityFixture(root)
      await writeBuggyChangeFixture(root)

      const identity: RepoIdentity = { repoKey: 'stage11-fixture-repo', gitRoot: root, identitySource: 'path' }
      await runFullRepoIndex({
        identity,
        db,
        config: { ...DEFAULT_CONFIG, include: ['src/**', 'app/**'], testPaths: ['**/*.test.ts', 'src/**/__tests__/**'] },
        logger: silentLogger,
        embeddingService: new MockEmbeddingService(64),
      }, 'stage11 test')

      const appRels = listCodeRelationshipsForPath(db, identity.repoKey, 'src/app.ts')
      assert(appRels.some((rel) => rel.kind === 'calls' && rel.targetPath === 'src/lib/helper.ts'))

      const screenRels = listCodeRelationshipsForPath(db, identity.repoKey, 'app/(tabs)/home.tsx')
      assert(screenRels.some((rel) => rel.kind === 'renders' && rel.targetName?.includes('Card')))
      assert(screenRels.some((rel) => rel.kind === 'uses_hook' && rel.targetName === 'useThing'))

      const relationshipStats = getRelationshipStats(db, identity.repoKey)
      assert((relationshipStats.byKind.similar_to ?? 0) > 0)

      const review = retrieveReviewContext(db, identity.repoKey, {
        changedFiles: ['src/api/users.ts', 'app/(tabs)/home.tsx'],
        query: 'review user api home screen tests',
      }, { maxFiles: 12, maxItemsPerSection: 6, maxRelatedFiles: 20 })
      assert(review.coverage.some((item) => item.file === 'src/api/users.ts' && item.hasGraphContext))
      assert(review.coverage.some((item) => item.file === 'app/(tabs)/home.tsx' && item.hasGraphContext))
      assert(review.summaries.length <= 12)
    } finally {
      db.close()
      await rm(root, { recursive: true, force: true })
      await rm(storage, { recursive: true, force: true })
    }
  })
})
