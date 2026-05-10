import type { CodeIntelligenceDb } from '../db/connection.ts'
import { listChunksNeedingEmbedding, type ChunkInput } from '../db/repositories/chunksRepo.ts'
import { getChunkEmbedding, markEmbeddingsStaleForModelChange, upsertChunkEmbedding } from '../db/repositories/embeddingsRepo.ts'
import { updateEmbeddingStatus } from '../db/repositories/embeddingStatusRepo.ts'
import { sha256Text } from '../indexing/hash.ts'
import { resolveModelCacheDir } from '../repo/storage.ts'
import { buildChunkEmbeddingText, EMBEDDING_VERSION, type EmbeddingService } from './EmbeddingService.ts'

export const MAX_EMBEDDING_TEXT_CHARS = 16_000

export async function embedMissingChunksForRepo(
  db: CodeIntelligenceDb,
  embeddingService: EmbeddingService,
  repoKey: string,
  batchSize: number,
  limit = 1000
): Promise<number> {
  updateEmbeddingStatus(db, {
    status: embeddingService.status,
    activeModel: embeddingService.modelId,
    activeDimensions: embeddingService.dimensions,
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
      cacheDir: resolveModelCacheDir(),
      lastError: embeddingService.lastError,
    })
    return 0
  }
  markEmbeddingsStaleForModelChange(db, embeddingService.modelId, embeddingService.dimensions, EMBEDDING_VERSION)
  const chunks = listChunksNeedingEmbedding(db, repoKey, limit)
  return embedChunksIncremental(db, embeddingService, chunks, batchSize)
}

export async function embedChunksIncremental(
  db: CodeIntelligenceDb,
  embeddingService: EmbeddingService,
  chunks: Array<ChunkInput & { insertedChunkId: number }>,
  batchSize: number
): Promise<number> {
  updateEmbeddingStatus(db, {
    status: embeddingService.status,
    activeModel: embeddingService.modelId,
    activeDimensions: embeddingService.dimensions,
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
      cacheDir: resolveModelCacheDir(),
      lastError: embeddingService.lastError,
    })
    return 0
  }

  markEmbeddingsStaleForModelChange(db, embeddingService.modelId, embeddingService.dimensions, EMBEDDING_VERSION)

  const pending = chunks.flatMap((chunk) => {
    const embeddingText = buildBoundedChunkEmbeddingText(chunk)
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
  const size = Math.max(1, batchSize)
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
    await yieldToEventLoop()
  }

  updateEmbeddingStatus(db, {
    status: embeddingService.status,
    activeModel: embeddingService.modelId,
    activeDimensions: embeddingService.dimensions,
    cacheDir: resolveModelCacheDir(),
    lastError: embeddingService.lastError,
  })

  return embedded
}

export function buildBoundedChunkEmbeddingText(chunk: ChunkInput): string {
  const fullText = buildChunkEmbeddingText({
    path: chunk.path,
    language: chunk.language,
    symbolName: chunk.symbolName,
    symbolKind: chunk.symbolKind,
    chunkKind: chunk.chunkKind,
    content: chunk.content,
  })
  if (fullText.length <= MAX_EMBEDDING_TEXT_CHARS) return fullText
  return `${fullText.slice(0, MAX_EMBEDDING_TEXT_CHARS - 96)}\n\n[Embedding input truncated to ${MAX_EMBEDDING_TEXT_CHARS} characters]`
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
