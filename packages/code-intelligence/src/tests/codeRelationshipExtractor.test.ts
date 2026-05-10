import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DEFAULT_CONFIG } from '../config.ts'
import { openCodeIntelligenceDb } from '../db/connection.ts'
import { getRelationshipStats, listCodeRelationshipsForPath } from '../db/repositories/relationshipsRepo.ts'
import { runFullRepoIndex, runIncrementalIndex } from '../indexing/indexScheduler.ts'
import type { CodeIntelligenceLogger } from '../logger.ts'
import type { RepoIdentity } from '../repo/identifyRepo.ts'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as CodeIntelligenceLogger

describe('code relationship extraction', () => {
  it('stores call, render, hook, and construct relationships and replaces them on edit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-code-rels-'))
    const storage = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-code-rels-db-'))
    const db = await openCodeIntelligenceDb(storage)
    try {
      await mkdir(join(root, 'src'), { recursive: true })
      await writeFile(join(root, 'src', 'app.tsx'), [
        'export function helper() { return 1 }',
        'export function useThing() { return helper() }',
        'export class Service {}',
        'export function Child() { return <View /> }',
        'export function App() {',
        '  const service = new Service()',
        '  useThing()',
        '  helper()',
        '  return <Child />',
        '}',
      ].join('\n'))
      const identity: RepoIdentity = { repoKey: 'code-rels-repo', gitRoot: root, identitySource: 'path' }
      const config = { ...DEFAULT_CONFIG, include: ['src/**'] }

      await runFullRepoIndex({ identity, db, config, logger: silentLogger }, 'test')
      const relationships = listCodeRelationshipsForPath(db, identity.repoKey, 'src/app.tsx')
      assert(relationships.some((rel) => rel.kind === 'calls' && rel.sourceName === 'App' && rel.targetName === 'helper'))
      assert(relationships.some((rel) => rel.kind === 'uses_hook' && rel.sourceName === 'App' && rel.targetName === 'useThing'))
      assert(relationships.some((rel) => rel.kind === 'renders' && rel.sourceName === 'App' && rel.targetName === 'Child'))
      assert(relationships.some((rel) => rel.kind === 'constructs' && rel.sourceName === 'App' && rel.targetName === 'Service'))
      assert((getRelationshipStats(db, identity.repoKey).byKind.renders ?? 0) >= 1)

      await writeFile(join(root, 'src', 'app.tsx'), 'export function App() { return 1 }\n')
      await runIncrementalIndex({ identity, db, config, logger: silentLogger }, { changedPaths: ['src/app.tsx'], deletedPaths: [], reason: 'test' })
      assert.equal(listCodeRelationshipsForPath(db, identity.repoKey, 'src/app.tsx').length, 0)
    } finally {
      db.close()
      await rm(root, { recursive: true, force: true })
      await rm(storage, { recursive: true, force: true })
    }
  })

  it('refreshes dependent file code relationships during incremental indexing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-code-rels-incremental-deps-'))
    const storage = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-code-rels-incremental-deps-db-'))
    const db = await openCodeIntelligenceDb(storage)
    try {
      await mkdir(join(root, 'src'), { recursive: true })
      await writeFile(join(root, 'src', 'app.ts'), "import { helper } from './helper'\nexport function app() { return helper() }\n")
      await writeFile(join(root, 'src', 'helper.ts'), 'export function helper() { return 1 }\n')
      const identity: RepoIdentity = { repoKey: 'code-rels-incremental-deps-repo', gitRoot: root, identitySource: 'path' }
      const config = { ...DEFAULT_CONFIG, include: ['src/**'] }

      await runFullRepoIndex({ identity, db, config, logger: silentLogger }, 'test')
      const initialCall = listCodeRelationshipsForPath(db, identity.repoKey, 'src/app.ts').find((rel) => rel.kind === 'calls' && rel.targetName === 'helper')
      assert(initialCall)
      assert.equal(initialCall.targetPath, 'src/helper.ts')
      assert(initialCall.targetEntityId)

      await writeFile(join(root, 'src', 'helper.ts'), 'export function renamedHelper() { return 1 }\n')
      await runIncrementalIndex({ identity, db, config, logger: silentLogger }, { changedPaths: ['src/helper.ts'], deletedPaths: [], reason: 'test' })
      const refreshedCall = listCodeRelationshipsForPath(db, identity.repoKey, 'src/app.ts').find((rel) => rel.kind === 'calls' && rel.targetName === 'helper')
      assert(refreshedCall)
      assert.equal(refreshedCall.targetPath, null)
      assert.equal(refreshedCall.targetEntityId, null)
      assert.equal(refreshedCall.confidence, 0.6)

      await writeFile(join(root, 'src', 'helper.ts'), 'export function helper() { return 2 }\n')
      await runIncrementalIndex({ identity, db, config, logger: silentLogger }, { changedPaths: ['src/helper.ts'], deletedPaths: [], reason: 'test' })
      const restoredCall = listCodeRelationshipsForPath(db, identity.repoKey, 'src/app.ts').find((rel) => rel.kind === 'calls' && rel.targetName === 'helper')
      assert(restoredCall)
      assert.equal(restoredCall.targetPath, 'src/helper.ts')
      assert(restoredCall.targetEntityId)
    } finally {
      db.close()
      await rm(root, { recursive: true, force: true })
      await rm(storage, { recursive: true, force: true })
    }
  })

  it('resolves imported cross-file call targets after full indexing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-code-rels-cross-file-'))
    const storage = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-code-rels-cross-file-db-'))
    const db = await openCodeIntelligenceDb(storage)
    try {
      await mkdir(join(root, 'src'), { recursive: true })
      await writeFile(join(root, 'src', 'app.ts'), "import { helper } from './helper'\nexport function app() { return helper() }\n")
      await writeFile(join(root, 'src', 'helper.ts'), 'export function helper() { return 1 }\n')
      const identity: RepoIdentity = { repoKey: 'code-rels-cross-file-repo', gitRoot: root, identitySource: 'path' }
      const config = { ...DEFAULT_CONFIG, include: ['src/**'] }

      await runFullRepoIndex({ identity, db, config, logger: silentLogger }, 'test')
      const relationships = listCodeRelationshipsForPath(db, identity.repoKey, 'src/app.ts')
      const call = relationships.find((rel) => rel.kind === 'calls' && rel.sourceName === 'app' && rel.targetName === 'helper')
      assert(call)
      assert.equal(call.targetPath, 'src/helper.ts')
      assert(call.targetEntityId)
    } finally {
      db.close()
      await rm(root, { recursive: true, force: true })
      await rm(storage, { recursive: true, force: true })
    }
  })
})
