import { randomUUID } from 'node:crypto'
import { and, asc, eq, sql } from 'drizzle-orm'
import type { CodeIntelligenceDb } from '../connection.ts'
import { learnings, machineRules } from '../schema.ts'
import type { CodebaseLearning } from '../../learnings/types.ts'
import { generateMachineRuleDrafts } from '../../rules/machineRuleGeneration.ts'
import type { MachineRule, MachineRuleStatus, RetrievedMachineRule } from '../../rules/types.ts'

export type MachineRuleRow = {
  id: string
  learning_id: string
  repo_key: string
  rule_kind: string
  pattern: string
  message: string
  path_globs_json: string | null
  languages_json: string | null
  severity: string
  status: MachineRuleStatus
  created_at: string
  updated_at: string
}

export function regenerateMachineRulesForLearning(db: CodeIntelligenceDb, learning: CodebaseLearning): MachineRule[] {
  disableMachineRulesForLearning(db, learning.id)
  const drafts = generateMachineRuleDrafts(learning)
  const now = new Date().toISOString()
  const rules = drafts.map((draft) => ({ ...draft, id: randomUUID(), createdAt: now, updatedAt: now }))
  for (const rule of rules) db.insert(machineRules).values(ruleToDrizzle(rule)).run()
  return rules
}

export function disableMachineRulesForLearning(db: CodeIntelligenceDb, learningId: string): number {
  return db
    .update(machineRules)
    .set({ status: 'disabled', updatedAt: new Date().toISOString() })
    .where(and(eq(machineRules.learningId, learningId), eq(machineRules.status, 'active')))
    .run().changes
}

export function listMachineRules(db: CodeIntelligenceDb, repoKey: string, status?: MachineRuleStatus): MachineRule[] {
  const rows = status
    ? db.select().from(machineRules).where(and(eq(machineRules.repoKey, repoKey), eq(machineRules.status, status))).orderBy(asc(machineRules.severity), asc(machineRules.ruleKind), asc(machineRules.pattern)).all()
    : db.select().from(machineRules).where(eq(machineRules.repoKey, repoKey)).orderBy(asc(machineRules.status), asc(machineRules.severity), asc(machineRules.ruleKind), asc(machineRules.pattern)).all()
  return rows.map((row) => rowToMachineRule(ruleToRow(row)))
}

export function retrieveHardRules(db: CodeIntelligenceDb, repoKey: string): RetrievedMachineRule[] {
  return db
    .select({ rule: machineRules })
    .from(machineRules)
    .innerJoin(learnings, eq(learnings.id, machineRules.learningId))
    .where(and(eq(machineRules.repoKey, repoKey), eq(machineRules.status, 'active'), eq(learnings.status, 'active'), sql`${learnings.confidence} >= 0.8`))
    .orderBy(asc(machineRules.severity), sql`${learnings.priority} DESC`, asc(machineRules.ruleKind))
    .all()
    .map((row) => ({ ...rowToMachineRule(ruleToRow(row.rule)), reasons: ['hard_rule_match'] }))
}

export function getMachineRuleStats(db: CodeIntelligenceDb, repoKey: string): { totalRules: number; activeRules: number | null; disabledRules: number | null } {
  return db.get(sql`SELECT
        COUNT(*) AS totalRules,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS activeRules,
        SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) AS disabledRules
       FROM machine_rules
       WHERE repo_key = ${repoKey}`) as { totalRules: number; activeRules: number | null; disabledRules: number | null }
}

function ruleToDrizzle(rule: MachineRule): typeof machineRules.$inferInsert {
  return {
    id: rule.id,
    learningId: rule.learningId,
    repoKey: rule.repoKey,
    ruleKind: rule.ruleKind,
    pattern: rule.pattern,
    message: rule.message,
    pathGlobsJson: rule.pathGlobs ? JSON.stringify(rule.pathGlobs) : null,
    languagesJson: rule.languages ? JSON.stringify(rule.languages) : null,
    severity: rule.severity,
    status: rule.status,
    createdAt: rule.createdAt ?? new Date().toISOString(),
    updatedAt: rule.updatedAt ?? new Date().toISOString(),
  }
}

function ruleToRow(row: typeof machineRules.$inferSelect): MachineRuleRow {
  return {
    id: row.id,
    learning_id: row.learningId,
    repo_key: row.repoKey,
    rule_kind: row.ruleKind,
    pattern: row.pattern,
    message: row.message,
    path_globs_json: row.pathGlobsJson,
    languages_json: row.languagesJson,
    severity: row.severity,
    status: row.status as MachineRuleStatus,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

export function rowToMachineRule(row: MachineRuleRow): MachineRule {
  return {
    id: row.id,
    learningId: row.learning_id,
    repoKey: row.repo_key,
    ruleKind: row.rule_kind as MachineRule['ruleKind'],
    pattern: row.pattern,
    message: row.message,
    pathGlobs: parseJsonArray(row.path_globs_json),
    languages: parseJsonArray(row.languages_json),
    severity: row.severity as MachineRule['severity'],
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function parseJsonArray(value: string | null): string[] | undefined {
  if (!value) return undefined
  const parsed = JSON.parse(value)
  return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : undefined
}
