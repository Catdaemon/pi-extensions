import type { CodeIntelligenceDb } from '../db/connection.ts'
import { getChunksByIds } from '../db/repositories/chunksRepo.ts'
import { listChunkEmbeddingsForRepo } from '../db/repositories/embeddingsRepo.ts'
import { replaceSimilarRelationshipsForRepo, type CodeRelationshipInput } from '../db/repositories/relationshipsRepo.ts'
import { cosineSimilarity } from '../embeddings/vector.ts'

const MAX_SOURCE_CHUNKS = 500
const MAX_SIMILAR_PER_CHUNK = 5
const MAX_SIMILAR_PER_ENTITY = 3
const MIN_SIMILARITY = 0.72
const MAX_SIMILAR_RELATIONSHIPS = 2000

export function refreshSimilarRelationshipsForRepo(db: CodeIntelligenceDb, repoKey: string): number {
  const embeddings = listChunkEmbeddingsForRepo(db, repoKey).slice(0, MAX_SOURCE_CHUNKS)
  if (embeddings.length < 2) return replaceSimilarRelationshipsForRepo(db, repoKey, [])

  const chunksById = new Map(getChunksByIds(db, embeddings.map((item) => item.chunkId)).map((chunk) => [chunk.id, chunk]))
  const relationships: CodeRelationshipInput[] = []
  const seen = new Set<string>()

  for (const source of embeddings) {
    const sourceChunk = chunksById.get(source.chunkId)
    if (!sourceChunk) continue
    const candidates = embeddings
      .filter((target) => target.chunkId !== source.chunkId && target.path !== source.path)
      .map((target) => {
        const targetChunk = chunksById.get(target.chunkId)
        const similarity = cosineSimilarity(source.embedding, target.embedding)
        return { target, targetChunk, similarity, score: targetChunk ? scoreSimilarChunk(sourceChunk, targetChunk, similarity) : similarity }
      })
      .filter((item) => item.targetChunk && item.similarity >= MIN_SIMILARITY && isComparableChunk(sourceChunk, item.targetChunk!))
      .sort((a, b) => b.score - a.score || b.similarity - a.similarity)
      .slice(0, MAX_SIMILAR_PER_CHUNK)

    const perEntityCount = new Map<string, number>()
    for (const candidate of candidates) {
      const targetChunk = candidate.targetChunk!
      const entityKey = `${sourceChunk.symbol_name ?? sourceChunk.chunk_kind}->${targetChunk.symbol_name ?? targetChunk.chunk_kind}`
      const entityCount = perEntityCount.get(entityKey) ?? 0
      if (entityCount >= MAX_SIMILAR_PER_ENTITY) continue
      const key = `${source.chunkId}->${candidate.target.chunkId}`
      if (seen.has(key)) continue
      seen.add(key)
      perEntityCount.set(entityKey, entityCount + 1)
      relationships.push({
        repoKey,
        sourcePath: sourceChunk.path,
        targetPath: targetChunk.path,
        sourceName: sourceChunk.symbol_name ?? sourceChunk.chunk_kind,
        targetName: targetChunk.symbol_name ?? targetChunk.chunk_kind,
        kind: 'similar_to',
        confidence: Number(Math.min(0.99, candidate.score).toFixed(4)),
        metadata: {
          sourceChunkId: source.chunkId,
          targetChunkId: candidate.target.chunkId,
          sourceKind: sourceChunk.chunk_kind,
          targetKind: targetChunk.chunk_kind,
          sourceSymbolKind: sourceChunk.symbol_kind,
          targetSymbolKind: targetChunk.symbol_kind,
          sourcePackageKey: sourceChunk.package_key,
          targetPackageKey: targetChunk.package_key,
          similarity: Number(candidate.similarity.toFixed(4)),
          score: Number(candidate.score.toFixed(4)),
          boosts: describeSimilarityBoosts(sourceChunk, targetChunk),
        },
      })
      if (relationships.length >= MAX_SIMILAR_RELATIONSHIPS) return replaceSimilarRelationshipsForRepo(db, repoKey, relationships)
    }
  }

  return replaceSimilarRelationshipsForRepo(db, repoKey, relationships)
}

function scoreSimilarChunk(source: ComparableChunk, target: ComparableChunk, similarity: number): number {
  let score = similarity
  if (source.symbol_kind && source.symbol_kind === target.symbol_kind) score += 0.08
  if (source.chunk_kind === target.chunk_kind) score += 0.05
  if (source.package_key && source.package_key === target.package_key) score += 0.04
  if (sameFeatureDirectory(source.path, target.path)) score += 0.03
  if (source.symbol_name && target.symbol_name && normalizeSymbolName(source.symbol_name) === normalizeSymbolName(target.symbol_name)) score += 0.02
  return score
}

type ComparableChunk = { path: string; chunk_kind: string; symbol_kind: string | null; symbol_name: string | null; package_key: string | null }

function describeSimilarityBoosts(source: ComparableChunk, target: ComparableChunk): string[] {
  return [
    source.symbol_kind && source.symbol_kind === target.symbol_kind ? 'same_symbol_kind' : '',
    source.chunk_kind === target.chunk_kind ? 'same_chunk_kind' : '',
    source.package_key && source.package_key === target.package_key ? 'same_package' : '',
    sameFeatureDirectory(source.path, target.path) ? 'same_feature_directory' : '',
    source.symbol_name && target.symbol_name && normalizeSymbolName(source.symbol_name) === normalizeSymbolName(target.symbol_name) ? 'same_normalized_symbol' : '',
  ].filter(Boolean)
}

function isComparableChunk(source: ComparableChunk, target: ComparableChunk): boolean {
  if (source.chunk_kind === target.chunk_kind) return true
  if (source.symbol_kind && source.symbol_kind === target.symbol_kind) return true
  if (source.package_key && source.package_key === target.package_key) return true
  if (sameFeatureDirectory(source.path, target.path)) return true
  return false
}

function sameFeatureDirectory(sourcePath: string, targetPath: string): boolean {
  const sourceParts = sourcePath.split('/')
  const targetParts = targetPath.split('/')
  if (sourceParts.length < 2 || targetParts.length < 2) return false
  return sourceParts.slice(0, -1).join('/') === targetParts.slice(0, -1).join('/')
}

function normalizeSymbolName(name: string): string {
  return name.replace(/^(format|load|get|set|create|update|delete|use)/i, '').replace(/(Screen|Component|View|Hook)$/i, '').toLowerCase()
}
