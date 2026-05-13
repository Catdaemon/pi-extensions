import type { CodeIntelligenceDb } from '../db/connection.ts'
import { getChunksByIds, getChunksForPaths, retrieveChunksFts, type ChunkRow } from '../db/repositories/chunksRepo.ts'
import { listChunkEmbeddingsForRepo } from '../db/repositories/embeddingsRepo.ts'
import type { EmbeddingService } from '../embeddings/EmbeddingService.ts'
import { cosineSimilarity } from '../embeddings/vector.ts'
import { isTestPath } from '../lib/pathClassifiers.ts'
import { mergeHybridResults } from './hybridRank.ts'

export type RetrievalReason =
  | 'fts_match'
  | 'same_package'
  | 'current_file'
  | 'changed_file'
  | 'visible_file'
  | 'generated_file'
  | 'semantic_match'
  | 'source_test_counterpart'

export type RetrievedCodeChunk = {
  id: number
  path: string
  packageKey?: string
  language?: string
  chunkKind: string
  symbolName?: string
  symbolKind?: string
  startLine: number
  endLine: number
  content: string
  score: number
  reasons: RetrievalReason[]
}

export type RetrieveCodeRequest = {
  repoKey: string
  query: string
  currentFiles?: string[]
  visibleFiles?: string[]
  changedFiles?: string[]
  sourceTestCounterpartFiles?: string[]
  packageKey?: string
  maxCodeChunks?: number
}

export async function retrieveCodeHybrid(
  db: CodeIntelligenceDb,
  embeddingService: EmbeddingService | undefined,
  request: RetrieveCodeRequest
): Promise<RetrievedCodeChunk[]> {
  const limit = request.maxCodeChunks ?? 12
  const fts = retrieveCodeFts(db, request)
  const vector = embeddingService ? await retrieveCodeVector(db, embeddingService, request) : []
  const workingSet = retrieveWorkingSetChunks(db, request)
  return mergeHybridResults({ fts: [...workingSet, ...fts], vector, limit })
}

export async function retrieveCodeVector(
  db: CodeIntelligenceDb,
  embeddingService: EmbeddingService,
  request: RetrieveCodeRequest
): Promise<RetrievedCodeChunk[]> {
  if (embeddingService.status === 'fts_only' || embeddingService.status === 'failed') return []
  let queryVector: number[] | undefined
  try {
    await embeddingService.ensureReady()
    ;[queryVector] = await embeddingService.embedTexts([request.query])
  } catch {
    return []
  }
  if (!queryVector) return []

  const embeddings = listChunkEmbeddingsForRepo(db, request.repoKey)
  const scored = embeddings
    .filter((item) => item.model === embeddingService.modelId && item.dimensions === embeddingService.dimensions)
    .map((item) => ({ ...item, similarity: cosineSimilarity(queryVector, item.embedding) }))
    .filter((item) => item.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, request.maxCodeChunks ?? 12)

  const rowsById = new Map(getChunksByIds(db, scored.map((item) => item.chunkId)).map((row) => [row.id, row]))
  return scored.flatMap((item) => {
    const row = rowsById.get(item.chunkId)
    return row ? [chunkRowToRetrieved(row, item.similarity, ['semantic_match'], request)] : []
  })
}

export function retrieveWorkingSetChunks(db: CodeIntelligenceDb, request: RetrieveCodeRequest): RetrievedCodeChunk[] {
  const current = getChunksForPaths(db, request.repoKey, request.currentFiles ?? [], 4).map((row) =>
    chunkRowToRetrieved(row, 1.2, ['current_file'], request)
  )
  const visible = getChunksForPaths(db, request.repoKey, request.visibleFiles ?? [], 2).map((row) =>
    chunkRowToRetrieved(row, 0.9, ['visible_file'], request)
  )
  const changed = getChunksForPaths(db, request.repoKey, request.changedFiles ?? [], 4).map((row) =>
    chunkRowToRetrieved(row, 1.1, ['changed_file'], request)
  )
  const counterparts = getChunksForPaths(db, request.repoKey, request.sourceTestCounterpartFiles ?? [], 3).map((row) =>
    chunkRowToRetrieved(row, 0.85, ['source_test_counterpart'], request)
  )
  return [...current, ...visible, ...changed, ...counterparts]
}

export function retrieveCodeFts(db: CodeIntelligenceDb, request: RetrieveCodeRequest): RetrievedCodeChunk[] {
  const rows = retrieveChunksFts(db, {
    repoKey: request.repoKey,
    query: request.query,
    limit: request.maxCodeChunks ?? 12,
  })

  return rows.map((row) => chunkRowToRetrieved(row, 1 / (1 + Math.max(0, row.rank)), ['fts_match'], request))
}

function chunkRowToRetrieved(
  row: ChunkRow,
  baseScore: number,
  baseReasons: RetrievalReason[],
  request: RetrieveCodeRequest
): RetrievedCodeChunk {
  const currentFiles = new Set(request.currentFiles ?? [])
  const visibleFiles = new Set(request.visibleFiles ?? [])
  const changedFiles = new Set(request.changedFiles ?? [])
  const reasons: RetrievalReason[] = [...baseReasons]
  if (row.package_key && row.package_key === request.packageKey) reasons.push('same_package')
  if (currentFiles.has(row.path)) reasons.push('current_file')
  if (visibleFiles.has(row.path)) reasons.push('visible_file')
  if (changedFiles.has(row.path)) reasons.push('changed_file')
  if ((request.sourceTestCounterpartFiles ?? []).includes(row.path)) reasons.push('source_test_counterpart')

  const uniqueReasons = [...new Set(reasons)]
  const workingSetBoost = uniqueReasons.length > new Set(baseReasons).size ? 0.15 * (uniqueReasons.length - new Set(baseReasons).size) : 0
  const rankingAdjustment = retrievalRankingAdjustment(row, request.query)
  return {
    id: row.id,
    path: row.path,
    packageKey: row.package_key ?? undefined,
    language: row.language ?? undefined,
    chunkKind: row.chunk_kind,
    symbolName: row.symbol_name ?? undefined,
    symbolKind: row.symbol_kind ?? undefined,
    startLine: row.start_line,
    endLine: row.end_line,
    content: row.content,
    score: baseScore + workingSetBoost + rankingAdjustment,
    reasons: uniqueReasons,
  }
}

export function retrievalRankingAdjustment(row: Pick<ChunkRow, 'path' | 'chunk_kind' | 'symbol_kind'>, query: string): number {
  if (!isImplementationQuery(query)) return 0
  const path = row.path.toLowerCase()
  let adjustment = 0
  if (isDocumentationPath(path)) adjustment -= 0.22
  if (isTestPath(path)) adjustment -= 0.1
  if (isImplementationPath(path)) adjustment += 0.12
  if (row.symbol_kind && row.symbol_kind !== 'heading') adjustment += 0.06
  if (row.chunk_kind === 'markdown') adjustment -= 0.08
  return adjustment
}

function isImplementationQuery(query: string): boolean {
  const lower = query.toLowerCase()
  if (/\b(readme|docs?|documentation|guide|usage|overview)\b/.test(lower)) return false
  return /\b(where|how|built|implemented?|implementation|code|function|class|method|call|calls|prompt|review|graph|context|changed files?|handler|command|tool|worker|index(?:ed|er|ing)?|retriev(?:e|al)|rank(?:ing)?)\b/.test(lower)
}

function isDocumentationPath(path: string): boolean {
  return path.endsWith('.md') || path.includes('/docs/') || path.includes('/readme')
}

function isImplementationPath(path: string): boolean {
  return /(^|\/)src\//.test(path) && !isTestPath(path) && !isDocumentationPath(path)
}
