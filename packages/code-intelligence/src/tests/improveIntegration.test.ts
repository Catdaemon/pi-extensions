import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { buildImproveQueries, buildImproveReviewConfigContext, buildReviewPackets, buildReviewReportTemplate, buildStructuredReviewRequirements, formatImproveReviewConfigContext, formatReviewPackets, parseChangedRangesFromDiff, parseImproveMode, renderImproveCodeIntelligenceContext, resolveImproveChangedFiles, selectWholeRepoReviewFiles, stripImproveFlags } from '../pi/improveIntegration.ts'
import { DEFAULT_CONFIG } from '../config.ts'
import { openCodeIntelligenceDb } from '../db/connection.ts'
import { upsertIndexedFile } from '../db/repositories/filesRepo.ts'

describe('/improve code intelligence integration', () => {
  it('parses supported mode flags', () => {
    assert.equal(parseImproveMode('--changed focus on API routes'), 'changed')
    assert.equal(parseImproveMode('focus on API routes --review'), 'review')
    assert.equal(parseImproveMode('--tests add coverage'), 'tests')
    assert.equal(parseImproveMode('--conventions'), 'conventions')
    assert.equal(parseImproveMode('--package src/foo.ts'), 'package')
    assert.equal(parseImproveMode('focus on API routes'), 'default')
  })

  it('does not treat longer option names as /improve mode flags', () => {
    assert.equal(parseImproveMode('--changed-files src/foo.ts'), 'default')
    assert.equal(parseImproveMode('--package-name api'), 'default')
    assert.equal(stripImproveFlags('--changed-files src/foo.ts'), '--changed-files src/foo.ts')
  })

  it('strips only standalone mode flags and normalizes focus spacing', () => {
    assert.equal(stripImproveFlags('--changed   focus on src/foo.ts'), 'focus on src/foo.ts')
    assert.equal(stripImproveFlags('focus on src/foo.ts --review'), 'focus on src/foo.ts')
    assert.equal(stripImproveFlags('focus --tests on coverage'), 'focus on coverage')
  })

  it('builds structured review report requirements', () => {
    const template = buildReviewReportTemplate()
    assert.match(template, /## Review Findings/)
    assert.match(template, /## Coverage/)
    assert.match(template, /## Readiness/)
    assert.match(template, /\| File \| Changed areas \| Graph\/source-test context inspected \| Findings \| Validation status \| Skipped reason \|/)

    const requirements = buildStructuredReviewRequirements()
    assert.match(requirements, /severity P0\/P1\/P2\/P3/)
    assert.match(requirements, /one coverage table row for every changed file/)
    assert.match(requirements, /readiness score from 0–5/)
    assert.match(requirements, /graph evidence/)
    assert.match(requirements, /Use this exact report shape/)
  })

  it('filters and formats repo-local review config for changed files', () => {
    const context = buildImproveReviewConfigContext({
      ...DEFAULT_CONFIG,
      review: {
        status: { filesLoaded: ['.pi-code-intelligence.json'], errors: [] },
        rules: [
          { id: 'api-tests', severity: 'warning', scope: ['src/api/**'], instruction: 'API changes need route-level regression tests.' },
          { id: 'docs', severity: 'info', scope: ['docs/**'], instruction: 'Docs changes need examples.' },
        ],
      },
    }, ['src/api/users.ts'])

    assert.equal(context.matchingRules.length, 1)
    assert.equal(context.matchingRules[0]?.id, 'api-tests')
    const formatted = formatImproveReviewConfigContext(context)
    assert.match(formatted, /Repo-local Review Config/)
    assert.match(formatted, /api-tests/)
    assert.doesNotMatch(formatted, /Docs changes/)
  })

  it('adds graph context to review mode context', () => {
    const rendered = renderImproveCodeIntelligenceContext({
      enabled: true,
      mode: 'review',
      changedFiles: ['src/app.ts'],
      contextPack: {
        codeContext: [],
        learnings: [],
        hardRules: [],
        warnings: [],
        freshness: { indexState: 'fresh', pendingFiles: 0, embeddingState: 'ready' },
        promptText: '# Local Codebase Context',
      },
      graphContext: [{
        path: 'src/app.ts',
        declarations: [{ name: 'app', kind: 'function', startLine: 1, exported: true }],
        imports: ['src/lib.ts'],
        importedBy: ['src/app.test.ts'],
        tests: ['src/app.test.ts'],
        counterparts: ['src/app.test.ts'],
        routeScreens: [],
        sameFeature: [],
        calls: [],
        calledBy: [],
        renders: [],
        hooks: [],
        similar: [],
      }],
    })

    assert.match(rendered, /Graph Summary/)
    assert.match(rendered, /Imported by: src\/app.test.ts/)
  })

  it('builds category and bounded per-file improve retrieval queries', () => {
    const queries = buildImproveQueries({
      baseQuery: 'base review',
      focus: 'focus auth paths',
      changedFiles: Array.from({ length: 10 }, (_, index) => `src/file${index}.ts`),
      mode: 'review',
    })

    assert(queries.some((query) => query.includes('Correctness review')))
    assert(queries.some((query) => query.includes('Test review')))
    assert(queries.some((query) => query.includes('Duplication review')))
    assert.equal(queries.filter((query) => query.includes('Per-file review packet retrieval')).length, 8)
  })

  it('parses changed ranges from unified diffs', () => {
    const ranges = parseChangedRangesFromDiff([
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,0 +2,3 @@',
      '+const a = 1',
      '@@ -10 +12 @@',
      '+const b = 2',
    ].join('\n'))

    assert.deepEqual(ranges.get('src/app.ts'), [
      { startLine: 2, endLine: 4, addedLines: 3 },
      { startLine: 12, endLine: 12, addedLines: 1 },
    ])
  })

  it('includes untracked files in git changes review scope', async () => {
    const calls: string[][] = []
    const pi = {
      exec: async (_command: string, args: string[]) => {
        calls.push(args)
        const text = args.includes('ls-files') ? 'src/new.ts\n' : 'src/changed.ts\nsrc/new.ts\n'
        return { stdout: text, stderr: '', code: 0 }
      },
    }

    const files = await resolveImproveChangedFiles(pi as any, { cwd: '/repo' } as any, {
      mode: 'git_changes',
      repoRoot: '/repo',
      summary: 'Use the staged and unstaged git changes in the current worktree.',
      details: '',
    })

    assert.deepEqual(files, ['src/changed.ts', 'src/new.ts'])
    assert(calls.some((args) => args.includes('ls-files') && args.includes('--others') && args.includes('--exclude-standard')))
  })

  it('does not attribute deleted-file hunks to the previous changed file', () => {
    const ranges = parseChangedRangesFromDiff([
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1 +1 @@',
      '+const a = 1',
      'diff --git a/src/deleted.ts b/src/deleted.ts',
      '--- a/src/deleted.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-const old = 1',
      'diff --git a/src/next.ts b/src/next.ts',
      '--- a/src/next.ts',
      '+++ b/src/next.ts',
      '@@ -3,0 +4,2 @@',
      '+const next = 1',
      '+const more = 2',
    ].join('\n'))

    assert.deepEqual(ranges.get('src/app.ts'), [{ startLine: 1, endLine: 1, addedLines: 1 }])
    assert.equal(ranges.has('src/deleted.ts'), false)
    assert.deepEqual(ranges.get('src/next.ts'), [{ startLine: 4, endLine: 5, addedLines: 2 }])
  })

  it('builds per-file review packets from graph context and retrieved snippets', () => {
    const packets = buildReviewPackets(['src/app.ts'], [{
      path: 'src/app.ts',
      declarations: [{ name: 'app', kind: 'function', startLine: 1, exported: true }],
      imports: ['src/lib.ts'],
      importedBy: ['src/app.test.ts'],
      tests: ['src/app.test.ts'],
      counterparts: ['src/app.test.ts'],
      routeScreens: [],
      sameFeature: [],
      calls: ['src/lib.ts#helper'],
      calledBy: ['src/app.test.ts#test'],
      renders: [],
      hooks: [],
      similar: ['src/other.ts'],
    }], [{
      id: 1,
      path: 'src/app.ts',
      chunkKind: 'function',
      startLine: 1,
      endLine: 5,
      content: 'export function app() {}',
      score: 1,
      reasons: ['changed_file'],
      symbolName: 'app',
    }], new Map([['src/app.ts', [{ startLine: 1, endLine: 3, addedLines: 3 }]]]))

    assert.equal(packets[0]?.file, 'src/app.ts')
    assert(packets[0]?.relatedFiles.includes('src/lib.ts'))
    assert(packets[0]?.queryFocus.includes('impact on callers'))
    assert.equal(packets[0]?.relevantSnippets[0]?.symbolName, 'app')
    assert.equal(packets[0]?.changedDeclarations[0]?.name, 'app')
    assert.equal(packets[0]?.testStatus, 'found')
    const rendered = formatReviewPackets(packets)
    assert.match(rendered, /Per-file Review Packets/)
    assert.match(rendered, /imports 1/)
    assert.match(rendered, /src\/app.test.ts/)
    assert.match(rendered, /src\/app.ts:1-5 app/)
    assert.match(rendered, /L1-L3 \(app\)/)

    const missingTestPacket = buildReviewPackets(['src/untested.ts'], [{
      path: 'src/untested.ts',
      declarations: [],
      imports: [],
      importedBy: [],
      tests: [],
      counterparts: [],
      routeScreens: [],
      sameFeature: [],
      calls: [],
      calledBy: [],
      renders: [],
      hooks: [],
      similar: [],
    }])[0]
    assert.equal(missingTestPacket?.testStatus, 'missing_candidate')
  })

  it('builds review packets for every requested file', () => {
    const files = Array.from({ length: 40 }, (_, index) => `src/file${index}.ts`)
    assert.equal(buildReviewPackets(files).length, 40)
  })

  it('selects indexed files for whole-directory review when no changed files exist', async () => {
    const storage = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-whole-repo-review-db-'))
    const db = await openCodeIntelligenceDb(storage)
    try {
      const repoKey = 'whole-repo-review'
      const paths = ['src/api/users.ts', 'src/components/Button.tsx', 'README.md', 'package-lock.json', ...Array.from({ length: 110 }, (_, index) => `src/feature/file${index}.ts`)]
      for (const path of paths) {
        upsertIndexedFile(db, { repoKey, path, language: path.endsWith('.md') ? 'markdown' : 'typescript', fileHash: path, sizeBytes: 100, isGenerated: false })
      }
      const files = selectWholeRepoReviewFiles(db, repoKey, 'api')
      assert.equal(files.length, paths.length - 1)
      assert(files.includes('src/api/users.ts'))
      assert(files.includes('src/components/Button.tsx'))
      assert(!files.includes('package-lock.json'))
    } finally {
      db.close()
      await rm(storage, { recursive: true, force: true })
    }
  })

  it('surfaces unavailable-code-intelligence warnings in the prompt context', () => {
    const rendered = renderImproveCodeIntelligenceContext({
      enabled: false,
      mode: 'default',
      changedFiles: [],
      warning: 'Code intelligence context retrieval failed: database is locked',
    })

    assert.match(rendered, /database is locked/)
    assert.match(rendered, /normal project context only/)
  })
})
