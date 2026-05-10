import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DEFAULT_CONFIG, loadConfig, type CodeIntelligenceConfig } from '../config.ts'
import { openCodeIntelligenceDb } from '../db/connection.ts'
import { getChunkStats } from '../db/repositories/chunksRepo.ts'
import { getEmbeddingStats } from '../db/repositories/embeddingsRepo.ts'
import { getFileIndexStats, getIndexedFileByPath, pruneDeletedFileRows } from '../db/repositories/filesRepo.ts'
import { getIndexingState } from '../db/repositories/indexingStateRepo.ts'
import { chunkFile } from '../indexing/chunker.ts'
import { detectGeneratedFile } from '../indexing/generated.ts'
import { buildWorkerProcessArgs, parseWorkerProcessEntries, parseWorkerProcessList, runFullRepoIndex, runIncrementalIndex } from '../indexing/indexScheduler.ts'
import { scanRepoFiles } from '../indexing/fileScanner.ts'
import type { CodeIntelligenceLogger } from '../logger.ts'
import { buildBoundedChunkEmbeddingText, MAX_EMBEDDING_TEXT_CHARS } from '../embeddings/embeddingIndexer.ts'
import { MockEmbeddingService } from '../embeddings/mockEmbeddingService.ts'
import { buildContextPack } from '../retrieval/contextPack.ts'
import { retrieveCodeFts, retrieveCodeHybrid } from '../retrieval/retrieveCode.ts'
import type { RepoIdentity } from '../repo/identifyRepo.ts'

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as unknown as CodeIntelligenceLogger

function testConfig(overrides: Partial<CodeIntelligenceConfig> = {}): CodeIntelligenceConfig {
  return {
    ...DEFAULT_CONFIG,
    include: ['**/*'],
    exclude: [...DEFAULT_CONFIG.exclude],
    ...overrides,
    embedding: { ...DEFAULT_CONFIG.embedding, ...(overrides.embedding ?? {}) },
    review: overrides.review ?? { rules: [], status: { filesLoaded: [], errors: [] } },
  }
}

describe('gitignore-backed config', () => {
  it('loads repo-local review rules from config files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-review-config-'))
    try {
      await writeFile(join(root, '.pi-code-intelligence.json'), JSON.stringify({
        review: {
          rules: [
            { id: 'api-tests', severity: 'warning', scope: ['src/api/**'], instruction: 'API changes need route-level regression tests.' },
          ],
        },
      }))
      const config = await loadConfig(root)
      assert.deepEqual(config.review.status.filesLoaded, ['.pi-code-intelligence.json'])
      assert.equal(config.review.rules[0]?.id, 'api-tests')
      assert.equal(config.review.rules[0]?.severity, 'warning')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('loads exclude patterns from repo .gitignore', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-config-'))
    try {
      await writeFile(join(root, '.gitignore'), '# comment\nsessions/**\nsubagents/\n!keep-me.ts\n')
      const config = await loadConfig(root)
      assert(config.exclude.includes('sessions/**'))
      assert(config.exclude.includes('subagents/**'))
      assert.equal(config.exclude.includes('keep-me.ts'), false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('file scanning', () => {
  it('respects include/exclude rules, skips binary files, hashes files, and marks generated files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-scan-'))
    try {
      await mkdir(join(root, 'src', 'generated'), { recursive: true })
      await mkdir(join(root, 'node_modules', 'dep'), { recursive: true })
      await mkdir(join(root, 'sessions'), { recursive: true })
      await mkdir(join(root, 'subagents'), { recursive: true })
      await writeFile(join(root, 'src', 'app.ts'), 'export const app = 1\n')
      await writeFile(join(root, 'src', 'generated', 'client.ts'), '// This file is generated. DO NOT EDIT.\nexport {}\n')
      await writeFile(join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = {}\n')
      await writeFile(join(root, '.env'), 'SECRET=1\n')
      await writeFile(join(root, 'sessions', 'latest.jsonl'), '{"type":"session"}\n')
      await writeFile(join(root, 'subagents', 'index.json'), '{"items":[]}\n')
      await writeFile(join(root, '.gitignore'), 'sessions/**\nsubagents/\n')
      await writeFile(join(root, 'image.png'), Buffer.from([0, 1, 2, 3]))

      const result = await scanRepoFiles(root, await loadConfig(root))
      const paths = result.files.map((file) => file.relativePath).sort()

      assert.deepEqual(paths, ['.gitignore', 'src/app.ts', 'src/generated/client.ts'])
      assert.equal(result.files.find((file) => file.relativePath === 'src/app.ts')?.language, 'typescript')
      assert.equal(result.files.find((file) => file.relativePath === 'src/generated/client.ts')?.generated.isGenerated, true)
      assert(result.files.every((file) => file.fileHash.length === 64))
      assert(result.summary.skippedIgnored >= 1)
      assert(result.summary.skippedBinary >= 1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('generated file detection', () => {
  it('detects configured paths, generated directories, lockfiles, and headers', () => {
    const config = testConfig({ generatedPaths: ['custom/out/**'] })

    assert.equal(detectGeneratedFile('custom/out/api.ts', '', config).isGenerated, true)
    assert.equal(detectGeneratedFile('src/__generated__/types.ts', '', config).isGenerated, true)
    assert.equal(detectGeneratedFile('pnpm-lock.yaml', '', config).isGenerated, true)
    assert.equal(detectGeneratedFile('src/client.ts', '// Code generated by OpenAPI\n', config).isGenerated, true)
    assert.equal(detectGeneratedFile('src/manual.ts', 'export const x = 1\n', config).isGenerated, false)
  })
})

describe('chunking', () => {
  it('chunks markdown headings, TypeScript declarations, config files, and fallback line windows', () => {
    const markdown = chunkFile({ path: 'README.md', language: 'markdown', content: '# Intro\nhello\n## Usage\nrun it\n' })
    assert.equal(markdown.length, 2)
    assert.equal(markdown[0]?.chunkKind, 'markdown_section')
    assert.equal(markdown[1]?.symbolName, 'Usage')

    const ts = chunkFile({
      path: 'src/app.ts',
      language: 'typescript',
      content: 'export function makeApp() {\n  return 1\n}\n\nexport class App {}\n',
    })
    assert(ts.some((chunk) => chunk.symbolName === 'makeApp' && chunk.chunkKind === 'function'))
    assert(ts.some((chunk) => chunk.symbolName === 'App' && chunk.chunkKind === 'class'))

    const config = chunkFile({ path: 'package.json', language: 'json', content: '{"name":"x"}\n' })
    assert.equal(config[0]?.chunkKind, 'config')

    const tests = chunkFile({ path: 'src/app.test.ts', language: 'typescript', content: "describe('invoice routes', () => {\n  it('creates invoices', () => {})\n})\n" })
    assert.equal(tests[0]?.chunkKind, 'test')
    assert.equal(tests[0]?.symbolName, 'invoice routes')

    const fallback = chunkFile({ path: 'notes.txt', content: 'hello\nworld\n' })
    assert.equal(fallback[0]?.chunkKind, 'module')
  })
})

describe('full repo indexing', () => {
  it('upserts file metadata, skips unchanged files on rerun, and marks deleted files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-index-'))
    const storage = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-db-'))
    const db = await openCodeIntelligenceDb(storage)

    try {
      await mkdir(join(root, 'src'), { recursive: true })
      await writeFile(
        join(root, 'src', 'app.ts'),
        'export function createInvoiceRoute() {\n  return "invoice route"\n}\n'
      )
      await writeFile(join(root, 'src', 'generated.ts'), '// @generated\nexport const api = 1\n')

      const identity: RepoIdentity = {
        repoKey: 'test-repo',
        gitRoot: root,
        identitySource: 'path',
      }
      const config = testConfig({ include: ['src/**'], generatedPaths: ['src/generated.ts'] })
      const embeddingService = new MockEmbeddingService(64)

      const first = await runFullRepoIndex({ identity, db, config, logger: silentLogger, embeddingService }, 'test')
      assert.equal(first.scanned, 2)
      assert.equal(first.insertedOrChanged, 2)
      assert.equal(first.skippedUnchanged, 0)
      assert.equal(first.generated, 1)
      assert(first.embeddingsIndexed >= 2)
      assert.equal(getFileIndexStats(db, identity.repoKey).activeFiles, 2)
      assert.equal(getIndexedFileByPath(db, identity.repoKey, 'src/generated.ts')?.is_generated, 1)
      assert.equal(getChunkStats(db, identity.repoKey).chunkedFiles, 2)
      assert(getChunkStats(db, identity.repoKey).totalChunks >= 2)
      assert(getEmbeddingStats(db, identity.repoKey).embeddedChunks >= 2)

      const retrieved = retrieveCodeFts(db, { repoKey: identity.repoKey, query: 'invoice route', maxCodeChunks: 5 })
      assert(retrieved.some((chunk) => chunk.path === 'src/app.ts' && chunk.reasons.includes('fts_match')))

      const hybrid = await retrieveCodeHybrid(db, embeddingService, {
        repoKey: identity.repoKey,
        query: 'create invoice endpoint',
        maxCodeChunks: 5,
      })
      assert(hybrid.some((chunk) => chunk.path === 'src/app.ts'))
      assert(hybrid.some((chunk) => chunk.reasons.includes('semantic_match') || chunk.reasons.includes('fts_match')))

      const contextPack = buildContextPack({ db, repoKey: identity.repoKey, codeContext: hybrid, maxTotalContextChars: 2000 })
      assert.equal(contextPack.freshness.indexState, 'fresh')
      assert(contextPack.promptText.includes('Local Codebase Context'))

      const second = await runFullRepoIndex({ identity, db, config, logger: silentLogger, embeddingService }, 'test')
      assert.equal(second.insertedOrChanged, 0)
      assert.equal(second.skippedUnchanged, 2)
      assert.equal(second.chunksIndexed, 0)
      assert.equal(second.embeddingsIndexed, 0)

      const narrowed = await runFullRepoIndex({ identity, db, config: testConfig({ include: ['src/generated.ts'], generatedPaths: ['src/generated.ts'] }), logger: silentLogger, embeddingService }, 'test')
      assert.equal(narrowed.deleted, 1)
      assert.notEqual(getIndexedFileByPath(db, identity.repoKey, 'src/app.ts')?.deleted_at, null)
      assert.equal(retrieveCodeFts(db, { repoKey: identity.repoKey, query: 'invoice route', maxCodeChunks: 5 }).length, 0)

      await rm(join(root, 'src', 'generated.ts'))
      const third = await runFullRepoIndex({ identity, db, config, logger: silentLogger, embeddingService }, 'test')
      assert.equal(third.deleted, 1)
      assert.notEqual(getIndexedFileByPath(db, identity.repoKey, 'src/generated.ts')?.deleted_at, null)
      assert(getIndexingState(db)?.full_index_completed_at)
    } finally {
      db.close()
      await rm(root, { recursive: true, force: true })
      await rm(storage, { recursive: true, force: true })
    }
  })
})

describe('incremental indexing', () => {
  it('updates changed files, skips unchanged files, ignores excluded files, and cleans deleted files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-incremental-'))
    const storage = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-db-'))
    const db = await openCodeIntelligenceDb(storage)

    try {
      await mkdir(join(root, 'src'), { recursive: true })
      await writeFile(join(root, 'src', 'app.ts'), 'export function oldRoute() {\n  return "old"\n}\n')

      const identity: RepoIdentity = { repoKey: 'incremental-repo', gitRoot: root, identitySource: 'path' }
      const config = testConfig({ include: ['src/**'] })
      const embeddingService = new MockEmbeddingService(64)

      await runFullRepoIndex({ identity, db, config, logger: silentLogger, embeddingService }, 'test')
      assert(retrieveCodeFts(db, { repoKey: identity.repoKey, query: 'oldRoute', maxCodeChunks: 5 }).length > 0)

      await writeFile(join(root, 'src', 'app.ts'), 'export function newRoute() {\n  return "new"\n}\n')
      const changed = await runIncrementalIndex(
        { identity, db, config, logger: silentLogger, embeddingService },
        { changedPaths: ['src/app.ts'], deletedPaths: [], reason: 'test' }
      )
      assert.equal(changed.changedFiles, 1)
      assert(changed.chunksIndexed >= 1)
      assert(retrieveCodeFts(db, { repoKey: identity.repoKey, query: 'newRoute', maxCodeChunks: 5 }).length > 0)

      const unchanged = await runIncrementalIndex(
        { identity, db, config, logger: silentLogger, embeddingService },
        { changedPaths: ['src/app.ts'], deletedPaths: [], reason: 'test' }
      )
      assert.equal(unchanged.skippedUnchanged, 1)

      const ignored = await runIncrementalIndex(
        { identity, db, config, logger: silentLogger, embeddingService },
        { changedPaths: ['.env'], deletedPaths: [], reason: 'test' }
      )
      assert.equal(ignored.skippedIgnored, 1)

      await rm(join(root, 'src', 'app.ts'))
      const deleted = await runIncrementalIndex(
        { identity, db, config, logger: silentLogger, embeddingService },
        { changedPaths: [], deletedPaths: ['src/app.ts'], reason: 'test' }
      )
      assert.equal(deleted.deletedFiles, 1)
      assert.notEqual(getIndexedFileByPath(db, identity.repoKey, 'src/app.ts')?.deleted_at, null)
      assert.equal(retrieveCodeFts(db, { repoKey: identity.repoKey, query: 'newRoute', maxCodeChunks: 5 }).length, 0)
      assert.equal(pruneDeletedFileRows(db, identity.repoKey, new Date(Date.now() + 1000).toISOString()), 1)
      assert.equal(getIndexedFileByPath(db, identity.repoKey, 'src/app.ts'), undefined)
      assert(getIndexingState(db)?.last_incremental_index_at)
    } finally {
      db.close()
      await rm(root, { recursive: true, force: true })
      await rm(storage, { recursive: true, force: true })
    }
  })
})

describe('embedding input bounds', () => {
  it('truncates oversized chunk embedding text before sending it to the model', () => {
    const text = buildBoundedChunkEmbeddingText({
      repoKey: 'repo',
      fileId: 1,
      path: 'sessions/huge.jsonl',
      chunkKind: 'module',
      startLine: 1,
      endLine: 1,
      content: 'x'.repeat(MAX_EMBEDDING_TEXT_CHARS * 2),
      contentHash: 'hash',
    })

    assert(text.length <= MAX_EMBEDDING_TEXT_CHARS)
    assert(text.includes('Embedding input truncated'))
  })
})

describe('worker process coordination', () => {
  it('adds repo and parent markers to worker argv and detects matching worker pids from ps output', () => {
    assert.deepEqual(buildWorkerProcessArgs('repo-123', 42), ['--pi-code-intelligence-worker', '--repo-key=repo-123', '--parent-pid=42'])

    const output = [
      '101 node --import /tmp/tsx /tmp/indexWorker.ts --pi-code-intelligence-worker --repo-key=repo-123 --parent-pid=42',
      '102 node --import /tmp/tsx /tmp/indexWorker.ts --pi-code-intelligence-worker --repo-key=repo-999 --parent-pid=42',
      '103 node /tmp/something-else.js',
      '104 node --import /tmp/tsx /tmp/indexWorker.ts --pi-code-intelligence-worker --repo-key=repo-123 --parent-pid=99',
    ].join('\n')

    assert.deepEqual(parseWorkerProcessList(output, 'repo-123'), [101, 104])
    assert.deepEqual(parseWorkerProcessList(output, 'repo-123', [104]), [101])
    assert.deepEqual(parseWorkerProcessList(output, 'repo-404'), [])
    assert.deepEqual(parseWorkerProcessEntries(output, 'repo-123').map((entry) => entry.parentPid), [42, 99])
  })
})
