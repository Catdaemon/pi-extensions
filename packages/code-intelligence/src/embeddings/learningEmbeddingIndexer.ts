import type { CodeIntelligenceDb } from '../db/connection.ts'
import { getLearningEmbedding, upsertLearningEmbedding } from '../db/repositories/learningEmbeddingsRepo.ts'
import type { CodebaseLearning } from '../learnings/types.ts'
import { sha256Text } from '../indexing/hash.ts'
import { EMBEDDING_VERSION, type EmbeddingService } from './EmbeddingService.ts'

export async function embedLearningIfReady(
  db: CodeIntelligenceDb,
  embeddingService: EmbeddingService | undefined,
  learning: CodebaseLearning
): Promise<boolean> {
  if (!embeddingService) return false
  if (embeddingService.status === 'fts_only' || embeddingService.status === 'failed') return false
  try {
    await embeddingService.ensureReady()
  } catch {
    return false
  }

  const embeddingTextHash = sha256Text(learning.embeddingText)
  const existing = getLearningEmbedding(db, learning.id)
  if (
    existing &&
    existing.model === embeddingService.modelId &&
    existing.dimensions === embeddingService.dimensions &&
    existing.embedding_version === EMBEDDING_VERSION &&
    existing.embedding_text_hash === embeddingTextHash &&
    existing.stale === 0
  ) {
    return false
  }

  const [vector] = await embeddingService.embedTexts([learning.embeddingText])
  if (!vector) return false
  upsertLearningEmbedding(db, {
    learningId: learning.id,
    model: embeddingService.modelId,
    dimensions: vector.length || embeddingService.dimensions,
    embeddingVersion: EMBEDDING_VERSION,
    embeddingTextHash,
    embedding: vector,
  })
  return true
}
