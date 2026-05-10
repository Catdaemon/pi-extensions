import type { CodeIntelligenceDb } from '../db/connection.ts'
import { getLearning, markLearningsUsed, retrieveLearningFts } from '../db/repositories/learningsRepo.ts'
import { listLearningEmbeddingsForRepo } from '../db/repositories/learningEmbeddingsRepo.ts'
import type { EmbeddingService } from '../embeddings/EmbeddingService.ts'
import { cosineSimilarity } from '../embeddings/vector.ts'
import type { RetrievedLearning } from '../learnings/types.ts'

export type RetrieveLearningRequest = {
  repoKey: string
  query: string
  packageKey?: string
  maxLearnings?: number
}

export async function retrieveLearningsHybrid(
  db: CodeIntelligenceDb,
  embeddingService: EmbeddingService | undefined,
  request: RetrieveLearningRequest
): Promise<RetrievedLearning[]> {
  const limit = request.maxLearnings ?? 8
  const fts = retrieveLearningFts(db, request)
  const vector = embeddingService ? await retrieveLearningVector(db, embeddingService, request) : []
  const byId = new Map<string, RetrievedLearning>()

  for (const learning of fts) byId.set(learning.id, { ...learning, score: learning.score * 0.45 })
  for (const learning of vector) {
    const existing = byId.get(learning.id)
    if (existing) {
      byId.set(learning.id, {
        ...existing,
        score: existing.score + learning.score * 0.55,
        reasons: [...new Set([...existing.reasons, ...learning.reasons])],
      })
    } else {
      byId.set(learning.id, { ...learning, score: learning.score * 0.55 })
    }
  }

  const results = [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit)
  markLearningsUsed(db, results.map((learning) => learning.id))
  return results
}

async function retrieveLearningVector(
  db: CodeIntelligenceDb,
  embeddingService: EmbeddingService,
  request: RetrieveLearningRequest
): Promise<RetrievedLearning[]> {
  if (embeddingService.status === 'fts_only' || embeddingService.status === 'failed') return []
  try {
    await embeddingService.ensureReady()
  } catch {
    return []
  }
  const [queryVector] = await embeddingService.embedTexts([request.query])
  if (!queryVector) return []

  return listLearningEmbeddingsForRepo(db, request.repoKey)
    .filter((item) => item.model === embeddingService.modelId && item.dimensions === embeddingService.dimensions)
    .map((item) => ({ ...item, similarity: cosineSimilarity(queryVector, item.embedding) }))
    .filter((item) => item.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity)
    .flatMap((item) => {
      const learning = getLearning(db, item.learningId)
      if (!learning) return []
      if (request.packageKey && learning.packageKey && learning.packageKey !== request.packageKey) return []
      return [{ ...learning, score: item.similarity + learning.confidence * 0.1 + learning.priority / 1000, reasons: ['semantic_match'] as RetrievedLearning['reasons'] }]
    })
    .slice(0, request.maxLearnings ?? 8)
}
