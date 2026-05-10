import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { openCodeIntelligenceDb } from '../db/connection.ts'
import { upsertIndexedFile } from '../db/repositories/filesRepo.ts'
import { replaceEntitiesForFile, listEntitiesForPath, getEntityStats } from '../db/repositories/entitiesRepo.ts'
import { replaceCodeRelationshipsForFile, getRelationshipStats } from '../db/repositories/relationshipsRepo.ts'
import { replaceFileRelationshipsForFile, listFileRelationshipsForPath, getFileRelationshipStats } from '../db/repositories/fileRelationshipsRepo.ts'
import { resetCodeIndex, resetEmbeddings } from '../db/repositories/maintenanceRepo.ts'

const repoKey = 'graph-repo'

describe('graph repositories', () => {
  it('replaces entities and relationships for a file and reports stats', async () => {
    const { db, storage } = await setupDb()
    try {
      const file = upsertIndexedFile(db, { repoKey, path: 'src/app.ts', language: 'typescript', fileHash: 'a', sizeBytes: 10, isGenerated: false })
      const entities = replaceEntitiesForFile(db, repoKey, 'src/app.ts', [
        { repoKey, fileId: file.id, path: 'src/app.ts', name: 'App', kind: 'component', startLine: 1, endLine: 3, exported: true },
        { repoKey, fileId: file.id, path: 'src/app.ts', name: 'useThing', kind: 'hook', startLine: 5, endLine: 8 },
      ])
      assert.equal(entities.length, 2)
      assert.deepEqual(getEntityStats(db, repoKey).byKind, { component: 1, hook: 1 })

      replaceCodeRelationshipsForFile(db, repoKey, 'src/app.ts', [
        { repoKey, sourceEntityId: entities[0]!.id, targetEntityId: entities[1]!.id, sourcePath: 'src/app.ts', targetPath: 'src/app.ts', sourceName: 'App', targetName: 'useThing', kind: 'uses_hook', confidence: 0.8 },
      ])
      replaceFileRelationshipsForFile(db, repoKey, 'src/app.ts', [
        { repoKey, sourcePath: 'src/app.ts', targetPath: 'src/app.test.ts', kind: 'test_counterpart', confidence: 0.7 },
      ])
      assert.deepEqual(getRelationshipStats(db, repoKey).byKind, { uses_hook: 1 })
      assert.deepEqual(getFileRelationshipStats(db, repoKey).byKind, { test_counterpart: 1 })
      assert.equal(listFileRelationshipsForPath(db, repoKey, 'src/app.ts').length, 1)

      replaceEntitiesForFile(db, repoKey, 'src/app.ts', [
        { repoKey, fileId: file.id, path: 'src/app.ts', name: 'App', kind: 'component', startLine: 1, endLine: 3 },
      ])
      assert.equal(listEntitiesForPath(db, repoKey, 'src/app.ts').length, 1)
    } finally {
      db.close()
      await rm(storage, { recursive: true, force: true })
    }
  })

  it('reset code index deletes graph while embedding reset preserves it', async () => {
    const { db, storage } = await setupDb()
    try {
      const file = upsertIndexedFile(db, { repoKey, path: 'src/app.ts', language: 'typescript', fileHash: 'a', sizeBytes: 10, isGenerated: false })
      const [entity] = replaceEntitiesForFile(db, repoKey, 'src/app.ts', [
        { repoKey, fileId: file.id, path: 'src/app.ts', name: 'App', kind: 'component', startLine: 1 },
      ])
      replaceCodeRelationshipsForFile(db, repoKey, 'src/app.ts', [
        { repoKey, sourceEntityId: entity!.id, sourcePath: 'src/app.ts', targetName: 'Other', kind: 'renders', confidence: 0.4 },
      ])
      replaceFileRelationshipsForFile(db, repoKey, 'src/app.ts', [
        { repoKey, sourcePath: 'src/app.ts', targetPath: 'src/app.test.ts', kind: 'test_counterpart', confidence: 0.7 },
      ])

      resetEmbeddings(db, repoKey)
      assert.equal(getEntityStats(db, repoKey).totalEntities, 1)
      assert.equal(getRelationshipStats(db, repoKey).totalRelationships, 1)

      const reset = resetCodeIndex(db, repoKey)
      assert.equal(reset.deletedEntities, 1)
      assert.equal(reset.deletedCodeRelationships, 1)
      assert.equal(reset.deletedFileRelationships, 1)
      assert.equal(getEntityStats(db, repoKey).totalEntities, 0)
      assert.equal(getRelationshipStats(db, repoKey).totalRelationships, 0)
      assert.equal(getFileRelationshipStats(db, repoKey).totalRelationships, 0)
    } finally {
      db.close()
      await rm(storage, { recursive: true, force: true })
    }
  })
})

async function setupDb() {
  const storage = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-graph-db-'))
  const db = await openCodeIntelligenceDb(storage)
  return { db, storage }
}
