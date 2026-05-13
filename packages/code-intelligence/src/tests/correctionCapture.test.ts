import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DEFAULT_CONFIG } from '../config.ts'
import { openCodeIntelligenceDb } from '../db/connection.ts'
import { listLearningEvents } from '../db/repositories/eventsRepo.ts'
import { listLearnings } from '../db/repositories/learningsRepo.ts'
import { MockEmbeddingService } from '../embeddings/mockEmbeddingService.ts'
import { maybeCorrectionSignal, correctionConfidence, activationStatusForConfidence } from '../learnings/detectCorrection.ts'
import { captureCorrectionLearning, createOrReuseLearning } from '../pi/correctionCapture.ts'
import type { CodeIntelligenceRuntime } from '../lifecycle/activate.ts'
import { ServiceRegistry } from '../lifecycle/serviceRegistry.ts'
import type { RepoIdentity } from '../repo/identifyRepo.ts'

describe('automatic correction capture', () => {
  it('detects correction signals and applies confidence policy', () => {
    assert.equal(maybeCorrectionSignal("No, don't use React context here. We use Zustand stores."), true)
    assert.equal(maybeCorrectionSignal('Looks good, thanks'), false)
    assert.equal(activationStatusForConfidence(correctionConfidence('Never edit generated clients')), 'active')
    assert.equal(activationStatusForConfidence(correctionConfidence('that is wrong here')), 'draft')
    assert.equal(maybeCorrectionSignal("let's always use subagents if available"), false)
    assert.equal(maybeCorrectionSignal("Let's add sort/filter/pagination using codebase conventions (always look up and use codebase conventions for ui work) for each of the tables"), true)
    assert.equal(maybeCorrectionSignal("let's ensure we use proper type inference instead of using the as keyword"), true)
    assert.equal(maybeCorrectionSignal("let's ensure we're writing tests for anything we add"), true)
    assert.equal(maybeCorrectionSignal('make sure we use explicit return types instead of inferred API response types'), true)
    assert.equal(maybeCorrectionSignal('favor integration tests over mocked route handlers'), true)
    assert.equal(maybeCorrectionSignal('actually never mind, it did succeed. the freeze is undesirable'), false)
  })

  it('captures high-confidence corrections as active learnings and dedupes repeats', async () => {
    const storage = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-correction-db-'))
    const db = await openCodeIntelligenceDb(storage)
    const runtime = makeRuntime(db, storage)

    try {
      const first = await captureCorrectionLearning(runtime, "No, don't use React context. Use Zustand")
      assert.equal(first.kind, 'stored')
      assert.equal(first.kind === 'stored' ? first.status : undefined, 'active')
      assert.equal(listLearnings(db, runtime.identity.repoKey, 'active').length, 1)
      const learning = listLearnings(db, runtime.identity.repoKey, 'active')[0]
      assert.equal(learning?.avoid, 'React context')
      assert.equal(learning?.prefer, 'Zustand')

      const second = await captureCorrectionLearning(runtime, "Don't use React context, use Zustand")
      assert.equal(second.kind, 'stored')
      assert.equal(listLearnings(db, runtime.identity.repoKey, 'active').length, 1)
      assert(listLearningEvents(db, runtime.identity.repoKey).some((event) => event.event_kind === 'correction_captured'))
    } finally {
      db.close()
      await rm(storage, { recursive: true, force: true })
    }
  })

  it('ignores conversational or generic fallback captures', async () => {
    const storage = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-correction-db-'))
    const db = await openCodeIntelligenceDb(storage)
    const runtime = makeRuntime(db, storage)

    try {
      const result = await captureCorrectionLearning(runtime, 'that is wrong here')
      assert.equal(result.kind, 'ignored')
      assert.equal(listLearnings(db, runtime.identity.repoKey, 'draft').length, 0)
    } finally {
      db.close()
      await rm(storage, { recursive: true, force: true })
    }
  })

  it('captures softer use-instead guidance as a nuanced draft learning', async () => {
    const storage = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-correction-db-'))
    const db = await openCodeIntelligenceDb(storage)
    const runtime = makeRuntime(db, storage)

    try {
      const result = await captureCorrectionLearning(runtime, "let's ensure we use proper type inference instead of using the as keyword")
      assert.equal(result.kind, 'stored')
      assert.equal(result.kind === 'stored' ? result.status : undefined, 'draft')
      const learning = listLearnings(db, runtime.identity.repoKey, 'draft')[0]
      assert.equal(learning?.prefer, 'proper type inference')
      assert.equal(learning?.avoid, 'the as keyword')
    } finally {
      db.close()
      await rm(storage, { recursive: true, force: true })
    }
  })

  it('captures parenthesized always guidance inside task requests', async () => {
    const storage = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-correction-db-'))
    const db = await openCodeIntelligenceDb(storage)
    const runtime = makeRuntime(db, storage)

    try {
      const text = 'Let\'s add sort/filter/pagination using codebase conventions (always look up and use codebase conventions for ui work) for each of the tables'
      const result = await captureCorrectionLearning(runtime, text)
      assert.equal(result.kind, 'stored')
      assert.equal(result.kind === 'stored' ? result.status : undefined, 'active')
      const learning = listLearnings(db, runtime.identity.repoKey, 'active')[0]
      assert.equal(learning?.ruleType, 'prefer_pattern')
      assert.match(learning?.summary ?? '', /always look up and use codebase conventions for ui work/i)
    } finally {
      db.close()
      await rm(storage, { recursive: true, force: true })
    }
  })

  it('captures softer tests-for-changes guidance as a testing convention', async () => {
    const storage = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-correction-db-'))
    const db = await openCodeIntelligenceDb(storage)
    const runtime = makeRuntime(db, storage)

    try {
      const result = await captureCorrectionLearning(runtime, "let's ensure we're writing tests for anything we add")
      assert.equal(result.kind, 'stored')
      assert.equal(result.kind === 'stored' ? result.status : undefined, 'draft')
      const learning = listLearnings(db, runtime.identity.repoKey, 'draft')[0]
      assert.equal(learning?.ruleType, 'testing_convention')
      assert.equal(learning?.title, 'Add tests for new changes')
      assert.equal(learning?.prefer, 'tests for new or changed behavior')
    } finally {
      db.close()
      await rm(storage, { recursive: true, force: true })
    }
  })

  it('uses an LLM rewrite hook when available', async () => {
    const storage = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-correction-db-'))
    const db = await openCodeIntelligenceDb(storage)
    const runtime = makeRuntime(db, storage)

    try {
      const result = await captureCorrectionLearning(runtime, "let's ensure we use proper type inference instead of using the as keyword", {
        rewrite: async () => ({
          title: 'Prefer type inference over type assertions',
          summary: 'Prefer TypeScript inference or explicit typed declarations over unnecessary `as` assertions.',
          ruleType: 'style',
          appliesWhen: 'When writing TypeScript code.',
          avoid: 'unnecessary `as` assertions',
          prefer: 'type inference or explicit typed declarations',
          pathGlobs: ['**/*.ts', '**/*.tsx'],
          languages: ['typescript'],
          confidence: 0.75,
          priority: 70,
          status: 'draft',
        }),
      })
      assert.equal(result.kind, 'stored')
      const learning = listLearnings(db, runtime.identity.repoKey, 'draft')[0]
      assert.equal(learning?.title, 'Prefer type inference over type assertions')
      assert.deepEqual(learning?.languages, ['typescript'])
    } finally {
      db.close()
      await rm(storage, { recursive: true, force: true })
    }
  })

  it('does not reuse semantically retrieved learnings with a different rule type', async () => {
    const storage = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-correction-db-'))
    const db = await openCodeIntelligenceDb(storage)
    const runtime = makeRuntime(db, storage)

    try {
      const first = await captureCorrectionLearning(runtime, 'never use the as keyword in typescript')
      assert.equal(first.kind, 'stored')
      const second = await captureCorrectionLearning(runtime, 'always check the sqlite db to validate my complaints', {
        rewrite: async () => ({
          title: 'Check SQLite DB when validating capture complaints',
          summary: 'Always check the SQLite learning DB when validating user complaints about learning capture.',
          ruleType: 'workflow',
          appliesWhen: 'When investigating whether a learning was captured.',
          prefer: 'checking the SQLite learning DB',
          confidence: 0.9,
          priority: 80,
          status: 'active',
        }),
      })
      assert.equal(second.kind, 'stored')
      const learnings = listLearnings(db, runtime.identity.repoKey, 'active')
      assert.equal(learnings.length, 2)
      assert(learnings.some((learning) => learning.title.includes('as keyword')))
      assert(learnings.some((learning) => learning.summary.toLowerCase().includes('sqlite learning db')))
    } finally {
      db.close()
      await rm(storage, { recursive: true, force: true })
    }
  })

  it('does not reuse a learning just because one domain term overlaps', async () => {
    const storage = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-correction-db-'))
    const db = await openCodeIntelligenceDb(storage)
    const runtime = makeRuntime(db, storage)

    try {
      const first = await createOrReuseLearning(runtime, {
        title: 'Run DB migrations with bunx supabase migration up',
        summary: 'Run DB migrations with bunx supabase migration up.',
        ruleType: 'workflow',
        appliesWhen: 'When applying database migrations.',
        prefer: 'bunx supabase migration up',
        confidence: 0.9,
        priority: 70,
        status: 'active',
      })
      const second = await createOrReuseLearning(runtime, {
        title: 'Generate migrations and do not hand-edit SQL files',
        summary: 'Only one migration is allowed per branch; always generate migrations and never hand-edit SQL files.',
        ruleType: 'workflow',
        appliesWhen: 'When creating database migrations.',
        avoid: 'hand-editing SQL migration files',
        prefer: 'generated migrations, one migration per branch',
        confidence: 0.9,
        priority: 80,
        status: 'active',
      })

      assert.equal(first.reused, false)
      assert.equal(second.reused, false)
      assert.notEqual(first.learning.id, second.learning.id)
      assert.equal(listLearnings(db, runtime.identity.repoKey, 'active').length, 2)
    } finally {
      db.close()
      await rm(storage, { recursive: true, force: true })
    }
  })

  it('reuses semantically similar learnings instead of creating duplicates', async () => {
    const storage = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-correction-db-'))
    const db = await openCodeIntelligenceDb(storage)
    const runtime = makeRuntime(db, storage)

    try {
      const first = await captureCorrectionLearning(runtime, 'Prefer type inference over the as keyword')
      assert.equal(first.kind, 'stored')
      const second = await captureCorrectionLearning(runtime, 'Prefer inferred types over as assertions', {
        rewrite: async () => ({
          title: 'Prefer inferred types over as assertions',
          summary: 'Prefer inferred types over unnecessary as assertions.',
          ruleType: 'prefer_pattern',
          appliesWhen: 'When writing TypeScript code.',
          avoid: 'the as keyword',
          prefer: 'type inference',
          confidence: 0.9,
          priority: 70,
          status: 'active',
        }),
      })
      assert.equal(second.kind, 'stored')
      assert.equal(listLearnings(db, runtime.identity.repoKey).filter((learning) => learning.status === 'active' || learning.status === 'draft').length, 1)
    } finally {
      db.close()
      await rm(storage, { recursive: true, force: true })
    }
  })

  it('stores ambiguous corrections as draft', async () => {
    const storage = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-correction-db-'))
    const db = await openCodeIntelligenceDb(storage)
    const runtime = makeRuntime(db, storage)

    try {
      const result = await captureCorrectionLearning(runtime, "we don't use mocked API route changes here; API route changes should be integration tested")
      assert.equal(result.kind, 'stored')
      assert.equal(result.kind === 'stored' ? result.status : undefined, 'draft')
      assert.equal(listLearnings(db, runtime.identity.repoKey, 'draft').length, 1)
    } finally {
      db.close()
      await rm(storage, { recursive: true, force: true })
    }
  })
})

function makeRuntime(db: ReturnType<typeof openCodeIntelligenceDb> extends Promise<infer T> ? T : never, storageDir: string): CodeIntelligenceRuntime {
  const identity: RepoIdentity = { repoKey: 'correction-repo', gitRoot: storageDir, identitySource: 'path' }
  const services = new ServiceRegistry()
  services.set('embeddingService', new MockEmbeddingService(64))
  return {
    identity,
    storageDir,
    db,
    config: DEFAULT_CONFIG,
    activatedAt: new Date().toISOString(),
    services,
    indexScheduler: undefined as unknown as CodeIntelligenceRuntime['indexScheduler'],
    fileWatcher: undefined as unknown as CodeIntelligenceRuntime['fileWatcher'],
  }
}
