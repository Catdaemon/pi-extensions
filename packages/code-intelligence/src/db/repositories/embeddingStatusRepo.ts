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
    activeDevice?: string
    downloadStatus?: string
    downloadFile?: string
    downloadLoadedBytes?: number
    downloadTotalBytes?: number
    downloadProgress?: number
    embeddingRatePerSecond?: number
    embeddingEtaSeconds?: number
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
    activeDevice: input.activeDevice ?? null,
    downloadStatus: input.downloadStatus ?? null,
    downloadFile: input.downloadFile ?? null,
    downloadLoadedBytes: input.downloadLoadedBytes ?? null,
    downloadTotalBytes: input.downloadTotalBytes ?? null,
    downloadProgress: input.downloadProgress === undefined ? null : Math.round(input.downloadProgress),
    embeddingRatePerSecond: input.embeddingRatePerSecond === undefined ? null : Math.round(input.embeddingRatePerSecond * 100) / 100,
    embeddingEtaSeconds: input.embeddingEtaSeconds === undefined ? null : Math.round(input.embeddingEtaSeconds),
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
        activeDevice: values.activeDevice,
        downloadStatus: values.downloadStatus,
        downloadFile: values.downloadFile,
        downloadLoadedBytes: values.downloadLoadedBytes,
        downloadTotalBytes: values.downloadTotalBytes,
        downloadProgress: values.downloadProgress,
        embeddingRatePerSecond: values.embeddingRatePerSecond,
        embeddingEtaSeconds: values.embeddingEtaSeconds,
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
        active_device: row.activeDevice,
        download_status: row.downloadStatus,
        download_file: row.downloadFile,
        download_loaded_bytes: row.downloadLoadedBytes,
        download_total_bytes: row.downloadTotalBytes,
        download_progress: row.downloadProgress,
        embedding_rate_per_second: row.embeddingRatePerSecond,
        embedding_eta_seconds: row.embeddingEtaSeconds,
        status: row.status as EmbeddingStatusValue,
        cache_dir: row.cacheDir,
        last_error: row.lastError,
        last_checked_at: row.lastCheckedAt,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      }
    : undefined
}
