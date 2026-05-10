import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { openCodeIntelligenceDb } from '../db/connection.ts'
import { createLearning } from '../db/repositories/learningsRepo.ts'
import { listMachineRules, retrieveHardRules } from '../db/repositories/rulesRepo.ts'
import { extractManualLearning } from '../learnings/extractLearning.ts'
import { buildContextPack } from '../retrieval/contextPack.ts'

describe('machine-checkable rules', () => {
  it('generates forbidden_import from avoid dependency learnings', async () => {
    const { db, storage } = await setupDb()
    try {
      const candidate = extractManualLearning('Do not use moment.js, use date-fns')
      assert(candidate)
      const learning = createLearning(db, 'rules-repo', candidate)
      const rules = listMachineRules(db, 'rules-repo', 'active')
      assert.equal(rules.length, 1)
      assert.equal(rules[0]?.learningId, learning.id)
      assert.equal(rules[0]?.ruleKind, 'forbidden_import')
      assert.equal(rules[0]?.pattern, 'moment')
      assert.equal(rules[0]?.severity, 'error')
    } finally {
      db.close()
      await rm(storage, { recursive: true, force: true })
    }
  })

  it('generates forbidden_path_edit from generated-code learnings', async () => {
    const { db, storage } = await setupDb()
    try {
      const candidate = extractManualLearning('Never edit src/generated/**')
      assert(candidate)
      createLearning(db, 'rules-repo', candidate)
      const rules = listMachineRules(db, 'rules-repo', 'active')
      assert.equal(rules[0]?.ruleKind, 'forbidden_path_edit')
      assert.equal(rules[0]?.pattern, 'src/generated/**')
    } finally {
      db.close()
      await rm(storage, { recursive: true, force: true })
    }
  })

  it('generates required_test_path and includes hard rules in context packs', async () => {
    const { db, storage } = await setupDb()
    try {
      const candidate = extractManualLearning('Always add tests under test/api')
      assert(candidate)
      createLearning(db, 'rules-repo', candidate)
      const rules = retrieveHardRules(db, 'rules-repo')
      assert.equal(rules[0]?.ruleKind, 'required_test_path')
      assert.equal(rules[0]?.pattern, 'test/api/**')
      assert(rules[0]?.reasons.includes('hard_rule_match'))

      const pack = buildContextPack({ db, repoKey: 'rules-repo', codeContext: [], hardRules: rules })
      assert(pack.promptText.includes('## Hard Rules'))
      assert(pack.promptText.includes('required_test_path'))
    } finally {
      db.close()
      await rm(storage, { recursive: true, force: true })
    }
  })

  it('does not create hard rules for draft or low-confidence learnings', async () => {
    const { db, storage } = await setupDb()
    try {
      const candidate = extractManualLearning('Do not use left-pad, use native code')
      assert(candidate)
      createLearning(db, 'rules-repo', { ...candidate, status: 'draft', confidence: 0.7 })
      assert.equal(listMachineRules(db, 'rules-repo', 'active').length, 0)
    } finally {
      db.close()
      await rm(storage, { recursive: true, force: true })
    }
  })
})

async function setupDb() {
  const storage = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-rules-db-'))
  const db = await openCodeIntelligenceDb(storage)
  return { db, storage }
}
