import { eq } from 'drizzle-orm'
import type { CodeIntelligenceDb } from '../connection.ts'
import { indexingState } from '../schema.ts'

export type IndexProgressPhase = 'scanning' | 'chunking' | 'graph extraction' | 'embedding' | 'complete'

export type IndexProgressInput = {
  repoKey: string
  phase: IndexProgressPhase
  currentPath?: string | null
  filesScanned?: number
  entitiesExtracted?: number
  relationshipsExtracted?: number
  startedAt?: string
}

export function markFullIndexCompleted(db: CodeIntelligenceDb, repoKey: string, completedAt = new Date().toISOString()): void {
  db
    .insert(indexingState)
    .values({ id: 1, repoKey, fullIndexCompletedAt: completedAt, lastIncrementalIndexAt: completedAt, progressPhase: 'complete', progressCurrentPath: null, progressUpdatedAt: completedAt, createdAt: completedAt, updatedAt: completedAt })
    .onConflictDoUpdate({
      target: indexingState.id,
      set: { repoKey, fullIndexCompletedAt: completedAt, lastIncrementalIndexAt: completedAt, progressPhase: 'complete', progressCurrentPath: null, progressUpdatedAt: completedAt, updatedAt: completedAt },
    })
    .run()
}

export function markIncrementalIndexCompleted(db: CodeIntelligenceDb, repoKey: string, completedAt = new Date().toISOString()): void {
  db
    .insert(indexingState)
    .values({ id: 1, repoKey, lastIncrementalIndexAt: completedAt, progressPhase: 'complete', progressCurrentPath: null, progressUpdatedAt: completedAt, createdAt: completedAt, updatedAt: completedAt })
    .onConflictDoUpdate({ target: indexingState.id, set: { repoKey, lastIncrementalIndexAt: completedAt, progressPhase: 'complete', progressCurrentPath: null, progressUpdatedAt: completedAt, updatedAt: completedAt } })
    .run()
}

export function getIndexingState(db: CodeIntelligenceDb) {
  const row = db.select().from(indexingState).where(eq(indexingState.id, 1)).get()
  return row
    ? {
        id: row.id,
        repo_key: row.repoKey,
        full_index_completed_at: row.fullIndexCompletedAt,
        last_incremental_index_at: row.lastIncrementalIndexAt,
        active_embedding_model: row.activeEmbeddingModel,
        active_embedding_dimensions: row.activeEmbeddingDimensions,
        progress_phase: row.progressPhase,
        progress_current_path: row.progressCurrentPath,
        progress_recent_paths: parseRecentPaths(row.progressRecentPathsJson),
        progress_files_scanned: row.progressFilesScanned,
        progress_entities_extracted: row.progressEntitiesExtracted,
        progress_relationships_extracted: row.progressRelationshipsExtracted,
        progress_started_at: row.progressStartedAt,
        progress_updated_at: row.progressUpdatedAt,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      }
    : undefined
}

export function updateIndexProgress(db: CodeIntelligenceDb, input: IndexProgressInput): void {
  const now = new Date().toISOString()
  const existing = db.select().from(indexingState).where(eq(indexingState.id, 1)).get()
  const recentPaths = updateRecentPaths(parseRecentPaths(existing?.progressRecentPathsJson), input.currentPath)
  db
    .insert(indexingState)
    .values({
      id: 1,
      repoKey: input.repoKey,
      progressPhase: input.phase,
      progressCurrentPath: input.currentPath ?? null,
      progressRecentPathsJson: JSON.stringify(recentPaths),
      progressFilesScanned: input.filesScanned ?? existing?.progressFilesScanned ?? 0,
      progressEntitiesExtracted: input.entitiesExtracted ?? existing?.progressEntitiesExtracted ?? 0,
      progressRelationshipsExtracted: input.relationshipsExtracted ?? existing?.progressRelationshipsExtracted ?? 0,
      progressStartedAt: input.startedAt ?? existing?.progressStartedAt ?? now,
      progressUpdatedAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: indexingState.id,
      set: {
        repoKey: input.repoKey,
        progressPhase: input.phase,
        progressCurrentPath: input.currentPath ?? null,
        progressRecentPathsJson: JSON.stringify(recentPaths),
        progressFilesScanned: input.filesScanned ?? existing?.progressFilesScanned ?? 0,
        progressEntitiesExtracted: input.entitiesExtracted ?? existing?.progressEntitiesExtracted ?? 0,
        progressRelationshipsExtracted: input.relationshipsExtracted ?? existing?.progressRelationshipsExtracted ?? 0,
        progressStartedAt: input.startedAt ?? existing?.progressStartedAt ?? now,
        progressUpdatedAt: now,
        updatedAt: now,
      },
    })
    .run()
}

function parseRecentPaths(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function updateRecentPaths(existing: string[], currentPath: string | null | undefined): string[] {
  if (!currentPath) return existing.slice(0, 5)
  return [currentPath, ...existing.filter((path) => path !== currentPath)].slice(0, 5)
}
