import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DEFAULT_CONFIG } from '../config.ts'
import { openCodeIntelligenceDb } from '../db/connection.ts'
import { runFullRepoIndex } from '../indexing/indexScheduler.ts'
import type { CodeIntelligenceLogger } from '../logger.ts'
import { formatGraphContextSummary, formatGraphEdgeDetails, retrieveGraphContextForFiles, retrieveGraphContextForQuery, retrieveGraphEdgeDetailsForFiles, retrieveImpactContextForDiff, retrieveReviewContext } from '../retrieval/graphContext.ts'
import type { RepoIdentity } from '../repo/identifyRepo.ts'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as CodeIntelligenceLogger

describe('graph context retrieval', () => {
  it('summarizes declarations, imports, imported-by files, and tests for files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-graph-context-'))
    const storage = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-graph-context-db-'))
    const db = await openCodeIntelligenceDb(storage)
    try {
      await mkdir(join(root, 'src', 'lib'), { recursive: true })
      await writeFile(join(root, 'src', 'app.ts'), "import { helper } from './lib/helper'\nexport function app() { return helper() }\n")
      await writeFile(join(root, 'src', 'app.test.ts'), "import { app } from './app'\ntest('app', () => app())\n")
      await writeFile(join(root, 'src', 'lib', 'helper.ts'), 'export function helper() { return 1 }\n')
      const identity: RepoIdentity = { repoKey: 'graph-context-repo', gitRoot: root, identitySource: 'path' }
      await runFullRepoIndex({ identity, db, config: { ...DEFAULT_CONFIG, include: ['src/**'] }, logger: silentLogger }, 'test')

      const [summary] = retrieveGraphContextForFiles(db, identity.repoKey, ['src/app.ts'])
      assert(summary)
      assert(summary.declarations.some((decl) => decl.name === 'app' && decl.kind === 'function'))
      assert(summary.imports.includes('src/lib/helper.ts'))
      assert(summary.importedBy.includes('src/app.test.ts'))
      assert(summary.tests.includes('src/app.test.ts'))
      assert(summary.calls.some((item) => item.includes('helper')))
      const byQuery = retrieveGraphContextForQuery(db, identity.repoKey, 'what calls app helper?', [])
      assert(byQuery.some((item) => item.path === 'src/app.ts'))
      const impact = retrieveImpactContextForDiff(db, identity.repoKey, ['src/app.ts'])
      assert(impact.changedFiles.includes('src/app.ts'))
      assert(impact.directlyRelatedFiles.includes('src/app.test.ts'))
      assert(impact.testFiles.includes('src/app.test.ts'))

      const review = retrieveReviewContext(db, identity.repoKey, { changedFiles: ['src/app.ts'], query: 'review app helper' })
      assert(review.coverage.some((item) => item.file === 'src/app.ts' && item.hasGraphContext && item.hasTestsOrCounterparts))
      assert(review.summaries.some((item) => item.path === 'src/app.ts'))

      const edgeDetails = retrieveGraphEdgeDetailsForFiles(db, identity.repoKey, ['src/app.ts'])
      assert(edgeDetails[0]?.fileEdges.some((edge) => edge.kind === 'imports' && edge.targetPath === 'src/lib/helper.ts'))
      assert(edgeDetails[0]?.codeEdges.some((edge) => edge.kind === 'calls' && edge.targetName === 'helper'))
      const edgeText = formatGraphEdgeDetails(edgeDetails)
      assert(edgeText.includes('## Graph Edge Details'))
      assert(edgeText.includes('outgoing imports: src/app.ts -> src/lib/helper.ts'))

      const text = formatGraphContextSummary([summary])
      assert(text.includes('## Graph Summary'))
      assert(text.includes('Declarations: export function app'))
      assert(text.includes('Imported by: src/app.test.ts'))
      assert(text.includes('Calls/constructs:'))
    } finally {
      db.close()
      await rm(root, { recursive: true, force: true })
      await rm(storage, { recursive: true, force: true })
    }
  })
})
