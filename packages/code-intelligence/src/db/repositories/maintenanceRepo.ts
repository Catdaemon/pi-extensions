import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { CodeIntelligenceDb } from '../connection.ts'
import { chunkEmbeddings, chunks, codeEntities, embeddingStatus, files, learnings, machineRules } from '../schema.ts'
import type { CodebaseLearning } from '../../learnings/types.ts'
import { appendLearningEvent } from './eventsRepo.ts'
import type { LearningRow } from './learningsRepo.ts'
import { getLearning, learningToRow, rowToLearning } from './learningsRepo.ts'
import { disableMachineRulesForLearning } from './rulesRepo.ts'

export function resetCodeIndex(db: CodeIntelligenceDb, repoKey: string): {
  deletedFiles: number
  deletedChunks: number
  deletedEmbeddings: number
  deletedEntities: number
  deletedCodeRelationships: number
  deletedFileRelationships: number
} {
  const chunkIds = db.select({ id: chunks.id }).from(chunks).where(eq(chunks.repoKey, repoKey)).all()
  const fileIds = db.select({ id: files.id }).from(files).where(eq(files.repoKey, repoKey)).all()
  const entityIds = db.select({ id: codeEntities.id }).from(codeEntities).where(eq(codeEntities.repoKey, repoKey)).all()
  const fileCount = fileIds.length
  let deletedEmbeddings = 0
  let deletedEntities = 0
  let deletedCodeRelationships = 0
  let deletedFileRelationships = 0

  db.transaction((tx) => {
    for (const row of chunkIds) {
      tx.run(sql`DELETE FROM chunk_fts WHERE rowid = ${row.id}`)
      deletedEmbeddings += tx.delete(chunkEmbeddings).where(eq(chunkEmbeddings.chunkId, row.id)).run().changes
    }
    deletedCodeRelationships = tx.run(sql`DELETE FROM code_relationships
      WHERE repo_key = ${repoKey}
         OR source_entity_id IN (SELECT id FROM code_entities WHERE repo_key = ${repoKey})
         OR target_entity_id IN (SELECT id FROM code_entities WHERE repo_key = ${repoKey})
         OR source_path IN (SELECT path FROM files WHERE repo_key = ${repoKey})
         OR target_path IN (SELECT path FROM files WHERE repo_key = ${repoKey})`).changes
    deletedFileRelationships = tx.run(sql`DELETE FROM file_relationships
      WHERE repo_key = ${repoKey}
         OR source_path IN (SELECT path FROM files WHERE repo_key = ${repoKey})
         OR target_path IN (SELECT path FROM files WHERE repo_key = ${repoKey})`).changes
    deletedEntities = entityIds.length > 0
      ? tx.delete(codeEntities).where(inArray(codeEntities.id, entityIds.map((row) => row.id))).run().changes
      : 0
    if (chunkIds.length > 0) tx.delete(chunks).where(inArray(chunks.id, chunkIds.map((row) => row.id))).run()
    if (fileIds.length > 0) tx.delete(files).where(inArray(files.id, fileIds.map((row) => row.id))).run()
    tx.run(sql`UPDATE indexing_state
       SET full_index_completed_at = NULL,
           last_incremental_index_at = NULL,
           updated_at = ${new Date().toISOString()}
       WHERE repo_key = ${repoKey}`)
  })

  return { deletedFiles: fileCount, deletedChunks: chunkIds.length, deletedEmbeddings, deletedEntities, deletedCodeRelationships, deletedFileRelationships }
}

export function resetEmbeddings(db: CodeIntelligenceDb, repoKey: string): {
  deletedChunkEmbeddings: number
  deletedLearningEmbeddings: number
} {
  let deletedChunkEmbeddings = 0
  let deletedLearningEmbeddings = 0
  db.transaction((tx) => {
    deletedChunkEmbeddings = tx.run(sql`DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE repo_key = ${repoKey})`).changes
    deletedLearningEmbeddings = tx.run(sql`DELETE FROM learning_embeddings WHERE learning_id IN (SELECT id FROM learnings WHERE repo_key = ${repoKey})`).changes
    tx.update(embeddingStatus)
      .set({ status: 'not_started', activeModel: null, activeDimensions: null, lastError: null, updatedAt: new Date().toISOString() })
      .where(eq(embeddingStatus.id, 1))
      .run()
  })
  return { deletedChunkEmbeddings, deletedLearningEmbeddings }
}

export function forgetLearning(db: CodeIntelligenceDb, learningId: string): boolean {
  const now = new Date().toISOString()
  let changed = false
  db.transaction((tx) => {
    changed = tx.update(learnings).set({ status: 'rejected', updatedAt: now }).where(eq(learnings.id, learningId)).run().changes > 0
    disableMachineRulesForLearning(tx as unknown as CodeIntelligenceDb, learningId)
  })
  return changed
}

export function forgetAllLearnings(db: CodeIntelligenceDb, repoKey: string): number {
  const rows = db.select({ id: learnings.id }).from(learnings).where(and(eq(learnings.repoKey, repoKey), inArray(learnings.status, ['active', 'draft']))).all()
  const now = new Date().toISOString()
  db.transaction((tx) => {
    for (const row of rows) {
      tx.update(learnings).set({ status: 'rejected', updatedAt: now }).where(eq(learnings.id, row.id)).run()
      tx.update(machineRules).set({ status: 'disabled', updatedAt: now }).where(and(eq(machineRules.learningId, row.id), eq(machineRules.status, 'active'))).run()
    }
  })
  return rows.length
}

export function supersedeLearning(
  db: CodeIntelligenceDb,
  input: { repoKey: string; supersededLearningId: string; replacementLearningId: string; reason?: string }
): boolean {
  if (input.supersededLearningId === input.replacementLearningId) return false
  const superseded = getLearning(db, input.supersededLearningId)
  const replacement = getLearning(db, input.replacementLearningId)
  if (!superseded || !replacement) return false
  if (superseded.repoKey !== input.repoKey || replacement.repoKey !== input.repoKey) return false

  const now = new Date().toISOString()
  db.transaction((tx) => {
    tx.update(learnings).set({ status: 'superseded', supersededBy: input.replacementLearningId, updatedAt: now }).where(eq(learnings.id, input.supersededLearningId)).run()
    disableMachineRulesForLearning(tx as unknown as CodeIntelligenceDb, input.supersededLearningId)
    appendLearningEvent(tx as unknown as CodeIntelligenceDb, {
      repoKey: input.repoKey,
      learningId: input.supersededLearningId,
      eventKind: 'superseded',
      payload: { replacementLearningId: input.replacementLearningId, reason: input.reason ?? 'manual' },
    })
  })
  return true
}

export function findStaleLearnings(
  db: CodeIntelligenceDb,
  input: { repoKey: string; inactiveDays?: number; now?: Date; includeDrafts?: boolean }
): CodebaseLearning[] {
  const inactiveDays = input.inactiveDays ?? 90
  const cutoff = new Date((input.now ?? new Date()).getTime() - inactiveDays * 24 * 60 * 60 * 1000).toISOString()
  const statuses = input.includeDrafts ? ['active', 'draft'] : ['active']
  return db
    .select()
    .from(learnings)
    .where(and(eq(learnings.repoKey, input.repoKey), inArray(learnings.status, statuses), sql`${learnings.confidence} < 0.9`, sql`COALESCE(${learnings.lastUsedAt}, ${learnings.updatedAt}, ${learnings.createdAt}) < ${cutoff}`))
    .orderBy(asc(sql`COALESCE(${learnings.lastUsedAt}, ${learnings.updatedAt}, ${learnings.createdAt})`), asc(learnings.confidence))
    .all()
    .map((row) => rowToLearning(learningToRow(row) as LearningRow))
}

export function consolidateSimilarLearnings(db: CodeIntelligenceDb, repoKey: string): {
  groups: Array<{ keeper: CodebaseLearning; superseded: CodebaseLearning[]; key: string }>
  supersededCount: number
} {
  const rows = db.select().from(learnings).where(and(eq(learnings.repoKey, repoKey), inArray(learnings.status, ['active', 'draft']))).all()
  const groups = new Map<string, CodebaseLearning[]>()
  for (const learning of rows.map((row) => rowToLearning(learningToRow(row)))) {
    const key = consolidationKey(learning)
    if (!key) continue
    const group = groups.get(key) ?? []
    group.push(learning)
    groups.set(key, group)
  }

  const consolidated: Array<{ keeper: CodebaseLearning; superseded: CodebaseLearning[]; key: string }> = []
  db.transaction((tx) => {
    for (const [key, group] of groups) {
      if (group.length < 2) continue
      const sorted = [...group].sort(compareConsolidationKeeper)
      const keeper = sorted[0]!
      const superseded = sorted.slice(1)
      const confidenceBoost = Math.min(0.05, superseded.length * 0.02)
      const now = new Date().toISOString()
      tx.update(learnings).set({ confidence: sql`MIN(1, ${learnings.confidence} + ${confidenceBoost})`, priority: sql`MIN(100, ${learnings.priority} + ${superseded.length})`, updatedAt: now }).where(eq(learnings.id, keeper.id)).run()
      for (const learning of superseded) {
        tx.update(learnings).set({ status: 'superseded', supersededBy: keeper.id, updatedAt: now }).where(eq(learnings.id, learning.id)).run()
        disableMachineRulesForLearning(tx as unknown as CodeIntelligenceDb, learning.id)
        appendLearningEvent(tx as unknown as CodeIntelligenceDb, {
          repoKey,
          learningId: learning.id,
          eventKind: 'consolidated',
          payload: { replacementLearningId: keeper.id, key },
        })
      }
      consolidated.push({ keeper: getLearning(tx as unknown as CodeIntelligenceDb, keeper.id) ?? keeper, superseded, key })
    }
  })

  return { groups: consolidated, supersededCount: consolidated.reduce((sum, group) => sum + group.superseded.length, 0) }
}

function compareConsolidationKeeper(a: CodebaseLearning, b: CodebaseLearning): number {
  const statusScore = (learning: CodebaseLearning) => (learning.status === 'active' ? 1 : 0)
  return (
    statusScore(b) - statusScore(a) ||
    b.confidence - a.confidence ||
    b.priority - a.priority ||
    Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? '') ||
    a.id.localeCompare(b.id)
  )
}

function consolidationKey(learning: CodebaseLearning): string | undefined {
  const avoid = canonicalTerm(learning.avoid)
  const prefer = canonicalTerm(learning.prefer)
  if (avoid || prefer) return `${learning.ruleType}|avoid:${avoid}|prefer:${prefer}`
  const title = canonicalTerm(learning.title)
  return title ? `${learning.ruleType}|title:${title}` : undefined
}

function canonicalTerm(value: string | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/\b(npm:|package:)\s*/g, '')
    .replace(/\.js\b/g, '')
    .replace(/[^a-z0-9_./*-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
