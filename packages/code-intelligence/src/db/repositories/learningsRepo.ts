import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import type { CodeIntelligenceDb } from '../connection.ts'
import { learnings } from '../schema.ts'
import type { CodebaseLearning, LearningCandidate, LearningStatus, RetrievedLearning } from '../../learnings/types.ts'
import { buildLearningEmbeddingText } from '../../learnings/embeddingText.ts'
import { appendLearningEvent } from './eventsRepo.ts'
import { regenerateMachineRulesForLearning } from './rulesRepo.ts'

export type LearningRow = {
  id: string
  repo_key: string
  package_key: string | null
  title: string
  summary: string
  rule_type: string
  applies_when: string
  avoid: string | null
  prefer: string | null
  path_globs_json: string | null
  languages_json: string | null
  examples_json: string | null
  source_kind: string
  source_ref: string | null
  source_timestamp: string
  confidence: number
  priority: number
  status: LearningStatus
  embedding_text: string
  embedding_model: string | null
  embedding_dimensions: number | null
  embedding_version: string | null
  embedding_text_hash: string | null
  created_at: string
  updated_at: string
  last_used_at: string | null
  superseded_by: string | null
}

export function createLearning(db: CodeIntelligenceDb, repoKey: string, candidate: LearningCandidate): CodebaseLearning {
  const duplicate = findDuplicateLearning(db, repoKey, candidate)
  if (duplicate) {
    const updated = updateLearningConfidence(db, duplicate.id, Math.min(1, duplicate.confidence + 0.05))
    const learning = updated ?? duplicate
    regenerateMachineRulesForLearning(db, learning)
    return learning
  }

  const now = new Date().toISOString()
  const sourceTimestamp = candidate.source?.timestamp ?? now
  const learning: CodebaseLearning = {
    id: randomUUID(),
    repoKey,
    packageKey: candidate.packageKey,
    title: candidate.title,
    summary: candidate.summary,
    ruleType: candidate.ruleType,
    appliesWhen: candidate.appliesWhen,
    avoid: candidate.avoid,
    prefer: candidate.prefer,
    pathGlobs: candidate.pathGlobs,
    languages: candidate.languages,
    examples: candidate.examples,
    source: {
      kind: candidate.source?.kind ?? 'manual_note',
      ref: candidate.source?.ref,
      timestamp: sourceTimestamp,
    },
    confidence: candidate.confidence,
    priority: candidate.priority,
    status: candidate.status,
    embeddingText: buildLearningEmbeddingText(candidate),
    createdAt: now,
    updatedAt: now,
  }

  db.insert(learnings).values(toDrizzleValues(learning)).run()
  upsertLearningFts(db, learning)
  regenerateMachineRulesForLearning(db, learning)
  return learning
}

export function getLearning(db: CodeIntelligenceDb, id: string): CodebaseLearning | undefined {
  const row = db.select().from(learnings).where(eq(learnings.id, id)).get()
  return row ? rowToLearning(learningToRow(row)) : undefined
}

export function listLearnings(db: CodeIntelligenceDb, repoKey: string, status?: LearningStatus): CodebaseLearning[] {
  const rows = status
    ? db.select().from(learnings).where(and(eq(learnings.repoKey, repoKey), eq(learnings.status, status))).orderBy(desc(learnings.priority), desc(learnings.updatedAt)).all()
    : db.select().from(learnings).where(eq(learnings.repoKey, repoKey)).orderBy(learnings.status, desc(learnings.priority), desc(learnings.updatedAt)).all()
  return rows.map((row) => rowToLearning(learningToRow(row)))
}

export function updateLearningStatus(db: CodeIntelligenceDb, id: string, status: LearningStatus): CodebaseLearning | undefined {
  const now = new Date().toISOString()
  db.update(learnings).set({ status, updatedAt: now }).where(eq(learnings.id, id)).run()
  const learning = getLearning(db, id)
  if (learning) regenerateMachineRulesForLearning(db, learning)
  return learning
}

export function retrieveLearningFts(db: CodeIntelligenceDb, input: { repoKey: string; query: string; limit?: number; packageKey?: string }): RetrievedLearning[] {
  const query = sanitizeFtsQuery(input.query)
  if (!query) return []
  const packageKey = input.packageKey ?? null
  const rows = db.all(sql`SELECT l.*, bm25(learning_fts) AS rank
       FROM learning_fts
       JOIN learnings l ON l.id = learning_fts.learning_id
       WHERE learning_fts MATCH ${query}
         AND l.repo_key = ${input.repoKey}
         AND l.status = 'active'
         AND l.confidence >= 0.5
         AND (${packageKey} IS NULL OR l.package_key IS NULL OR l.package_key = ${packageKey})
       ORDER BY rank ASC, l.priority DESC, l.confidence DESC
       LIMIT ${input.limit ?? 8}`)

  return (rows as Array<LearningRow & { rank: number }>).map((row) => ({
    ...rowToLearning(row),
    score: 1 / (1 + Math.max(0, row.rank)) + row.confidence * 0.1 + row.priority / 1000,
    reasons: ['fts_match'],
  }))
}

export function markLearningsUsed(db: CodeIntelligenceDb, learningIds: string[], usedAt = new Date().toISOString()): void {
  if (learningIds.length === 0) return
  db.transaction((tx) => {
    for (const id of new Set(learningIds)) {
      const before = tx.select({ repoKey: learnings.repoKey, confidence: learnings.confidence, priority: learnings.priority }).from(learnings).where(and(eq(learnings.id, id), eq(learnings.status, 'active'))).get()
      const result = tx
        .update(learnings)
        .set({
          lastUsedAt: usedAt,
          updatedAt: usedAt,
          confidence: sql`MIN(1, ${learnings.confidence} + 0.01)`,
          priority: sql`MIN(100, ${learnings.priority} + 1)`,
        })
        .where(and(eq(learnings.id, id), eq(learnings.status, 'active')))
        .run()
      if (before && result.changes > 0) {
        appendLearningEvent(tx as unknown as CodeIntelligenceDb, {
          repoKey: before.repoKey,
          learningId: id,
          eventKind: 'retrieved',
          payload: { confidenceBefore: before.confidence, priorityBefore: before.priority },
        })
      }
    }
  })
}

export function upsertLearningFts(db: CodeIntelligenceDb, learning: CodebaseLearning): void {
  db.run(sql`DELETE FROM learning_fts WHERE learning_id = ${learning.id}`)
  db.run(sql`INSERT INTO learning_fts(title, summary, applies_when, avoid, prefer, embedding_text, learning_id) VALUES (${learning.title}, ${learning.summary}, ${learning.appliesWhen}, ${learning.avoid ?? ''}, ${learning.prefer ?? ''}, ${learning.embeddingText}, ${learning.id})`)
}

function findDuplicateLearning(db: CodeIntelligenceDb, repoKey: string, candidate: LearningCandidate): CodebaseLearning | undefined {
  const rows = db
    .select()
    .from(learnings)
    .where(and(eq(learnings.repoKey, repoKey), or(eq(learnings.status, 'active'), eq(learnings.status, 'draft'))))
    .all()
    .map(learningToRow)
  const avoid = normalize(candidate.avoid)
  const prefer = normalize(candidate.prefer)
  const title = normalize(candidate.title)
  const duplicate = rows.find((row) => {
    if (avoid && avoid === normalize(row.avoid ?? undefined)) return !prefer || prefer === normalize(row.prefer ?? undefined)
    return title === normalize(row.title)
  })
  return duplicate ? rowToLearning(duplicate) : undefined
}

function updateLearningConfidence(db: CodeIntelligenceDb, id: string, confidence: number): CodebaseLearning | undefined {
  db.update(learnings).set({ confidence, updatedAt: new Date().toISOString() }).where(eq(learnings.id, id)).run()
  return getLearning(db, id)
}

function toDrizzleValues(learning: CodebaseLearning): typeof learnings.$inferInsert {
  return {
    id: learning.id,
    repoKey: learning.repoKey,
    packageKey: learning.packageKey ?? null,
    title: learning.title,
    summary: learning.summary,
    ruleType: learning.ruleType,
    appliesWhen: learning.appliesWhen,
    avoid: learning.avoid ?? null,
    prefer: learning.prefer ?? null,
    pathGlobsJson: learning.pathGlobs ? JSON.stringify(learning.pathGlobs) : null,
    languagesJson: learning.languages ? JSON.stringify(learning.languages) : null,
    examplesJson: learning.examples ? JSON.stringify(learning.examples) : null,
    sourceKind: learning.source.kind,
    sourceRef: learning.source.ref ?? null,
    sourceTimestamp: learning.source.timestamp,
    confidence: learning.confidence,
    priority: learning.priority,
    status: learning.status,
    embeddingText: learning.embeddingText,
    createdAt: learning.createdAt ?? new Date().toISOString(),
    updatedAt: learning.updatedAt ?? new Date().toISOString(),
  }
}

export function rowToLearning(row: LearningRow): CodebaseLearning {
  return {
    id: row.id,
    repoKey: row.repo_key,
    packageKey: row.package_key ?? undefined,
    title: row.title,
    summary: row.summary,
    ruleType: row.rule_type as CodebaseLearning['ruleType'],
    appliesWhen: row.applies_when,
    avoid: row.avoid ?? undefined,
    prefer: row.prefer ?? undefined,
    pathGlobs: parseJsonArray(row.path_globs_json),
    languages: parseJsonArray(row.languages_json),
    examples: row.examples_json ? JSON.parse(row.examples_json) : undefined,
    source: { kind: row.source_kind as CodebaseLearning['source']['kind'], ref: row.source_ref ?? undefined, timestamp: row.source_timestamp },
    confidence: row.confidence,
    priority: row.priority,
    status: row.status,
    embeddingText: row.embedding_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at ?? undefined,
    supersededBy: row.superseded_by ?? undefined,
  }
}

export function learningToRow(row: typeof learnings.$inferSelect): LearningRow {
  return {
    id: row.id,
    repo_key: row.repoKey,
    package_key: row.packageKey,
    title: row.title,
    summary: row.summary,
    rule_type: row.ruleType,
    applies_when: row.appliesWhen,
    avoid: row.avoid,
    prefer: row.prefer,
    path_globs_json: row.pathGlobsJson,
    languages_json: row.languagesJson,
    examples_json: row.examplesJson,
    source_kind: row.sourceKind,
    source_ref: row.sourceRef,
    source_timestamp: row.sourceTimestamp,
    confidence: row.confidence,
    priority: row.priority,
    status: row.status as LearningStatus,
    embedding_text: row.embeddingText,
    embedding_model: row.embeddingModel,
    embedding_dimensions: row.embeddingDimensions,
    embedding_version: row.embeddingVersion,
    embedding_text_hash: row.embeddingTextHash,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    last_used_at: row.lastUsedAt,
    superseded_by: row.supersededBy,
  }
}

function parseJsonArray(value: string | null): string[] | undefined {
  if (!value) return undefined
  const parsed = JSON.parse(value)
  return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : undefined
}

function normalize(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9_./-]+/g, ' ').trim()
}

function sanitizeFtsQuery(query: string): string {
  const terms = query
    .split(/\s+/)
    .map((term) => term.trim().replace(/[^\p{L}\p{N}_./:-]/gu, ''))
    .filter((term) => term.length >= 2)
    .slice(0, 12)
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ')
}
