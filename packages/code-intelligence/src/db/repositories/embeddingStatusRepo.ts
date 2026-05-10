import { eq } from 'drizzle-orm'
import type { CodeIntelligenceDb } from '../connection.ts'
import { embeddingStatus } from '../schema.ts'
import type { EmbeddingStatusValue } from '../../embeddings/EmbeddingService.ts'

export function updateEmbeddingStatus(
  db: CodeIntelligenceDb,
  input: {
    status: EmbeddingStatusValue
    activeModel?: string
    activeDimensions?: number
    cacheDir: string
    lastError?: string
  }
): void {
  const now = new Date().toISOString()
  const values = {
    id: 1,
    provider: 'transformers',
    activeModel: input.activeModel ?? null,
    activeDimensions: input.activeDimensions ?? null,
    status: input.status,
    cacheDir: input.cacheDir,
    lastError: input.lastError ?? null,
    lastCheckedAt: now,
    createdAt: now,
    updatedAt: now,
  }
  db
    .insert(embeddingStatus)
    .values(values)
    .onConflictDoUpdate({
      target: embeddingStatus.id,
      set: {
        provider: values.provider,
        activeModel: values.activeModel,
        activeDimensions: values.activeDimensions,
        status: values.status,
        cacheDir: values.cacheDir,
        lastError: values.lastError,
        lastCheckedAt: now,
        updatedAt: now,
      },
    })
    .run()
}

export function getEmbeddingStatus(db: CodeIntelligenceDb) {
  const row = db.select().from(embeddingStatus).where(eq(embeddingStatus.id, 1)).get()
  return row
    ? {
        id: row.id,
        provider: row.provider,
        active_model: row.activeModel,
        active_dimensions: row.activeDimensions,
        status: row.status as EmbeddingStatusValue,
        cache_dir: row.cacheDir,
        last_error: row.lastError,
        last_checked_at: row.lastCheckedAt,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      }
    : undefined
}
