import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DEFAULT_CONFIG } from '../config.ts'
import { openCodeIntelligenceDb } from '../db/connection.ts'
import { getFileRelationshipStats, listFileRelationshipsForPath } from '../db/repositories/fileRelationshipsRepo.ts'
import { getIndexingState } from '../db/repositories/indexingStateRepo.ts'
import { extractFileRelationshipsForFile, resolveImportPath } from '../indexing/relationshipExtractor.ts'
import { runFullRepoIndex, runIncrementalIndex } from '../indexing/indexScheduler.ts'
import type { CodeIntelligenceLogger } from '../logger.ts'
import type { RepoIdentity } from '../repo/identifyRepo.ts'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as CodeIntelligenceLogger

describe('file relationship extraction', () => {
  it('resolves relative imports with extensions and index files', () => {
    const activePaths = new Set(['src/lib/foo.ts', 'src/components/Button/index.tsx'])
    assert.equal(resolveImportPath('src/app.ts', './lib/foo', activePaths), 'src/lib/foo.ts')
    assert.equal(resolveImportPath('src/app.ts', './components/Button', activePaths), 'src/components/Button/index.tsx')
    assert.equal(resolveImportPath('src/app.ts', 'react', activePaths), undefined)
  })

  it('extracts imports, counterparts, route screens, and same-feature relationships', () => {
    const activePaths = new Set([
      'src/app/profile.tsx',
      'src/features/profile/screens/ProfileScreen.tsx',
      'src/features/profile/components/Card.tsx',
      'src/app/profile.test.tsx',
    ])
    const relationships = extractFileRelationshipsForFile({
      repoKey: 'repo',
      path: 'src/app/profile.tsx',
      content: "import ProfileScreen from '../features/profile/screens/ProfileScreen'\nexport default ProfileScreen\n",
      activePaths,
      config: DEFAULT_CONFIG,
    })
    assert(relationships.some((rel) => rel.kind === 'imports' && rel.targetPath === 'src/features/profile/screens/ProfileScreen.tsx'))
    assert(relationships.some((rel) => rel.kind === 'route_screen' && rel.targetPath === 'src/features/profile/screens/ProfileScreen.tsx'))
    assert(relationships.some((rel) => rel.kind === 'test_counterpart' && rel.targetPath === 'src/app/profile.test.tsx'))
  })

  it('stores file relationships during indexing, replaces them on change, and deletes them on file deletion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-relationships-'))
    const storage = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-relationships-db-'))
    const db = await openCodeIntelligenceDb(storage)
    try {
      await mkdir(join(root, 'src', 'lib'), { recursive: true })
      await writeFile(join(root, 'src', 'app.ts'), "import { helper } from './lib/helper'\nexport const app = helper()\n")
      await writeFile(join(root, 'src', 'app.test.ts'), "import { app } from './app'\ntest('app', () => app)\n")
      await writeFile(join(root, 'src', 'lib', 'helper.ts'), 'export function helper() { return 1 }\n')
      const identity: RepoIdentity = { repoKey: 'relationships-repo', gitRoot: root, identitySource: 'path' }
      const config = { ...DEFAULT_CONFIG, include: ['src/**'] }

      await runFullRepoIndex({ identity, db, config, logger: silentLogger }, 'test')
      const appRelationships = listFileRelationshipsForPath(db, identity.repoKey, 'src/app.ts')
      assert(appRelationships.some((rel) => rel.kind === 'imports' && rel.targetPath === 'src/lib/helper.ts'))
      assert(appRelationships.some((rel) => rel.kind === 'test_counterpart' && rel.targetPath === 'src/app.test.ts'))
      assert.equal(getFileRelationshipStats(db, identity.repoKey).byKind.imports, 2)
      assert(getIndexingState(db)?.progress_relationships_extracted! > 0)

      await writeFile(join(root, 'src', 'app.ts'), 'export const app = 2\n')
      await runIncrementalIndex({ identity, db, config, logger: silentLogger }, { changedPaths: ['src/app.ts'], deletedPaths: [], reason: 'test' })
      const changedRelationships = listFileRelationshipsForPath(db, identity.repoKey, 'src/app.ts')
      assert.equal(changedRelationships.some((rel) => rel.kind === 'imports'), false)
      assert(changedRelationships.some((rel) => rel.kind === 'test_counterpart'))

      await rm(join(root, 'src', 'app.ts'))
      await runIncrementalIndex({ identity, db, config, logger: silentLogger }, { changedPaths: [], deletedPaths: ['src/app.ts'], reason: 'test' })
      assert.equal(listFileRelationshipsForPath(db, identity.repoKey, 'src/app.ts').length, 0)
    } finally {
      db.close()
      await rm(root, { recursive: true, force: true })
      await rm(storage, { recursive: true, force: true })
    }
  })
})
