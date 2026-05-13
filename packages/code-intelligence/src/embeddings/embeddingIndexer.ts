import type { CodeIntelligenceConfig } from '../config.ts'
import type { CodeIntelligenceDb } from '../db/connection.ts'
import { listChunksNeedingEmbedding, type ChunkInput } from '../db/repositories/chunksRepo.ts'
import { getChunkEmbedding, markEmbeddingsStaleForModelChange, upsertChunkEmbedding } from '../db/repositories/embeddingsRepo.ts'
import { listFileRelationshipsForPath } from '../db/repositories/fileRelationshipsRepo.ts'
import { listCodeRelationshipsForPath } from '../db/repositories/relationshipsRepo.ts'
import { updateEmbeddingStatus } from '../db/repositories/embeddingStatusRepo.ts'
import { sha256Text } from '../indexing/hash.ts'
import { resolveModelCacheDir } from '../repo/storage.ts'
import { buildChunkEmbeddingText, EMBEDDING_VERSION, type EmbeddingService } from './EmbeddingService.ts'

export const MAX_EMBEDDING_TEXT_CHARS = 6_000
const MAX_GRAPH_CONTEXT_LINES = 12
const MAX_GRAPH_CONTEXT_LINE_CHARS = 220

export async function embedMissingChunksForRepo(
  db: CodeIntelligenceDb,
  embeddingService: EmbeddingService,
  repoKey: string,
  embeddingConfig: CodeIntelligenceConfig['embedding'],
  limit = 1000
): Promise<number> {
  updateEmbeddingStatus(db, {
    status: embeddingService.status,
    activeModel: embeddingService.modelId,
    activeDimensions: embeddingService.dimensions,
    activeDevice: embeddingService.activeDevice,
    downloadStatus: embeddingService.downloadStatus,
    downloadFile: embeddingService.downloadFile,
    downloadLoadedBytes: embeddingService.downloadLoadedBytes,
    downloadTotalBytes: embeddingService.downloadTotalBytes,
    downloadProgress: embeddingService.downloadProgress,
    cacheDir: resolveModelCacheDir(),
    lastError: embeddingService.lastError,
  })
  if (embeddingService.status === 'fts_only' || embeddingService.status === 'failed') return 0
  try {
    await embeddingService.ensureReady()
  } catch {
    updateEmbeddingStatus(db, {
      status: embeddingService.status,
      activeModel: embeddingService.modelId,
      activeDimensions: embeddingService.dimensions,
      activeDevice: embeddingService.activeDevice,
    downloadStatus: embeddingService.downloadStatus,
    downloadFile: embeddingService.downloadFile,
    downloadLoadedBytes: embeddingService.downloadLoadedBytes,
    downloadTotalBytes: embeddingService.downloadTotalBytes,
    downloadProgress: embeddingService.downloadProgress,
      cacheDir: resolveModelCacheDir(),
      lastError: embeddingService.lastError,
    })
    return 0
  }
  markEmbeddingsStaleForModelChange(db, embeddingService.modelId, embeddingService.dimensions, EMBEDDING_VERSION)
  const chunks = listChunksNeedingEmbedding(db, repoKey, limit)
  return embedChunksIncremental(db, embeddingService, chunks, embeddingConfig)
}

export async function embedChunksIncremental(
  db: CodeIntelligenceDb,
  embeddingService: EmbeddingService,
  chunks: Array<ChunkInput & { insertedChunkId: number }>,
  embeddingConfig: CodeIntelligenceConfig['embedding']
): Promise<number> {
  updateEmbeddingStatus(db, {
    status: embeddingService.status,
    activeModel: embeddingService.modelId,
    activeDimensions: embeddingService.dimensions,
    activeDevice: embeddingService.activeDevice,
    downloadStatus: embeddingService.downloadStatus,
    downloadFile: embeddingService.downloadFile,
    downloadLoadedBytes: embeddingService.downloadLoadedBytes,
    downloadTotalBytes: embeddingService.downloadTotalBytes,
    downloadProgress: embeddingService.downloadProgress,
    cacheDir: resolveModelCacheDir(),
    lastError: embeddingService.lastError,
  })

  if (embeddingService.status === 'fts_only' || embeddingService.status === 'failed') return 0

  try {
    await embeddingService.ensureReady()
  } catch {
    updateEmbeddingStatus(db, {
      status: embeddingService.status,
      activeModel: embeddingService.modelId,
      activeDimensions: embeddingService.dimensions,
      activeDevice: embeddingService.activeDevice,
    downloadStatus: embeddingService.downloadStatus,
    downloadFile: embeddingService.downloadFile,
    downloadLoadedBytes: embeddingService.downloadLoadedBytes,
    downloadTotalBytes: embeddingService.downloadTotalBytes,
    downloadProgress: embeddingService.downloadProgress,
      cacheDir: resolveModelCacheDir(),
      lastError: embeddingService.lastError,
    })
    return 0
  }

  markEmbeddingsStaleForModelChange(db, embeddingService.modelId, embeddingService.dimensions, EMBEDDING_VERSION)

  const pending = chunks.flatMap((chunk) => {
    const embeddingText = buildBoundedChunkEmbeddingText(chunk, buildChunkGraphContext(db, chunk))
    const embeddingTextHash = sha256Text(embeddingText)
    const existing = getChunkEmbedding(db, chunk.insertedChunkId)
    if (
      existing &&
      existing.model === embeddingService.modelId &&
      existing.dimensions === embeddingService.dimensions &&
      existing.embedding_version === EMBEDDING_VERSION &&
      existing.embedding_text_hash === embeddingTextHash &&
      existing.stale === 0
    ) {
      return []
    }
    return [{ chunk, embeddingText, embeddingTextHash }]
  })

  let embedded = 0
  const embeddingStartedAt = Date.now()
  const size = resolveEmbeddingBatchSize(embeddingConfig, embeddingService.activeDevice)
  for (let index = 0; index < pending.length; index += size) {
    const batch = pending.slice(index, index + size)
    let vectors: number[][]
    try {
      vectors = await embeddingService.embedTexts(batch.map((item) => item.embeddingText))
    } catch (error) {
      updateEmbeddingStatus(db, {
        status: 'fts_only',
        activeModel: embeddingService.modelId,
        activeDimensions: embeddingService.dimensions,
        activeDevice: embeddingService.activeDevice,
        downloadStatus: embeddingService.downloadStatus,
        downloadFile: embeddingService.downloadFile,
        downloadLoadedBytes: embeddingService.downloadLoadedBytes,
        downloadTotalBytes: embeddingService.downloadTotalBytes,
        downloadProgress: embeddingService.downloadProgress,
        ...embeddingThroughput(embedded, pending.length, embeddingStartedAt),
        cacheDir: resolveModelCacheDir(),
        lastError: (error as Error).message,
      })
      return embedded
    }
    for (let offset = 0; offset < batch.length; offset += 1) {
      const item = batch[offset]
      const vector = vectors[offset]
      if (!item || !vector) continue
      upsertChunkEmbedding(db, {
        chunkId: item.chunk.insertedChunkId,
        model: embeddingService.modelId,
        dimensions: vector.length || embeddingService.dimensions,
        embeddingVersion: EMBEDDING_VERSION,
        embeddingTextHash: item.embeddingTextHash,
        embedding: vector,
      })
      embedded += 1
    }
    updateEmbeddingStatus(db, {
      status: embeddingService.status,
      activeModel: embeddingService.modelId,
      activeDimensions: embeddingService.dimensions,
      activeDevice: embeddingService.activeDevice,
      downloadStatus: embeddingService.downloadStatus,
      downloadFile: embeddingService.downloadFile,
      downloadLoadedBytes: embeddingService.downloadLoadedBytes,
      downloadTotalBytes: embeddingService.downloadTotalBytes,
      downloadProgress: embeddingService.downloadProgress,
      ...embeddingThroughput(embedded, pending.length, embeddingStartedAt),
      cacheDir: resolveModelCacheDir(),
      lastError: embeddingService.lastError,
    })
    await yieldToEventLoop()
  }

  updateEmbeddingStatus(db, {
    status: embeddingService.status,
    activeModel: embeddingService.modelId,
    activeDimensions: embeddingService.dimensions,
    activeDevice: embeddingService.activeDevice,
    downloadStatus: embeddingService.downloadStatus,
    downloadFile: embeddingService.downloadFile,
    downloadLoadedBytes: embeddingService.downloadLoadedBytes,
    downloadTotalBytes: embeddingService.downloadTotalBytes,
    downloadProgress: embeddingService.downloadProgress,
    ...embeddingThroughput(embedded, pending.length, embeddingStartedAt),
    cacheDir: resolveModelCacheDir(),
    lastError: embeddingService.lastError,
  })

  return embedded
}

export function buildBoundedChunkEmbeddingText(chunk: ChunkInput, graphContext: string[] = []): string {
  const fullText = buildChunkEmbeddingText({
    path: chunk.path,
    language: chunk.language,
    symbolName: chunk.symbolName,
    symbolKind: chunk.symbolKind,
    chunkKind: chunk.chunkKind,
    content: chunk.content,
    graphContext,
  })
  if (fullText.length <= MAX_EMBEDDING_TEXT_CHARS) return fullText
  return `${fullText.slice(0, MAX_EMBEDDING_TEXT_CHARS - 96)}\n\n[Embedding input truncated to ${MAX_EMBEDDING_TEXT_CHARS} characters]`
}

export function embeddingThroughput(embedded: number, total: number, startedAt: number, now = Date.now()): { embeddingRatePerSecond?: number; embeddingEtaSeconds?: number } {
  const elapsedSeconds = (now - startedAt) / 1000
  if (embedded <= 0 || elapsedSeconds <= 0) return {}
  const rate = embedded / elapsedSeconds
  const remaining = Math.max(0, total - embedded)
  return {
    embeddingRatePerSecond: rate,
    embeddingEtaSeconds: rate > 0 && remaining > 0 ? remaining / rate : 0,
  }
}

export function resolveEmbeddingBatchSize(embeddingConfig: CodeIntelligenceConfig['embedding'], activeDevice?: string): number {
  const device = normalizeEmbeddingDevice(activeDevice)
  const configured = device ? embeddingConfig.batchSizeByDevice?.[device] : undefined
  return Math.max(1, Math.trunc(configured ?? embeddingConfig.batchSize))
}

function normalizeEmbeddingDevice(device: string | undefined): keyof CodeIntelligenceConfig['embedding']['batchSizeByDevice'] | undefined {
  if (!device) return undefined
  const normalized = device.toLowerCase()
  if (normalized === 'cpu' || normalized === 'gpu' || normalized === 'webgpu' || normalized === 'coreml' || normalized === 'cuda' || normalized === 'dml' || normalized === 'auto') return normalized
  return undefined
}

export function buildChunkGraphContext(db: CodeIntelligenceDb, chunk: ChunkInput): string[] {
  const lines: string[] = []
  const seen = new Set<string>()
  const add = (line: string) => {
    const trimmed = line.length > MAX_GRAPH_CONTEXT_LINE_CHARS ? `${line.slice(0, MAX_GRAPH_CONTEXT_LINE_CHARS - 1)}…` : line
    if (seen.has(trimmed) || lines.length >= MAX_GRAPH_CONTEXT_LINES) return
    seen.add(trimmed)
    lines.push(trimmed)
  }

  const fileRelationships = listFileRelationshipsForPath(db, chunk.repoKey, chunk.path)
  for (const rel of fileRelationships) {
    add(`File ${rel.kind}: ${rel.targetPath}`)
  }

  const codeRelationships = listCodeRelationshipsForPath(db, chunk.repoKey, chunk.path)
  for (const rel of codeRelationships) {
    if (chunk.symbolName && rel.sourceName && rel.sourceName !== chunk.symbolName) continue
    const target = [rel.targetName, rel.targetPath].filter(Boolean).join(' in ')
    add(`Code ${rel.kind}: ${rel.sourceName ?? chunk.symbolName ?? 'chunk'} -> ${target || rel.targetPath || rel.targetName || 'unknown target'}`)
  }

  return lines
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
