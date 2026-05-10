import type { CodeIntelligenceDb } from '../db/connection.ts'
import { getEmbeddingStats } from '../db/repositories/embeddingsRepo.ts'
import { getEmbeddingStatus } from '../db/repositories/embeddingStatusRepo.ts'
import { getFileIndexStats } from '../db/repositories/filesRepo.ts'
import { getIndexingState } from '../db/repositories/indexingStateRepo.ts'
import type { EmbeddingStatusValue } from '../embeddings/EmbeddingService.ts'
import type { RetrievedLearning } from '../learnings/types.ts'
import type { RetrievedMachineRule } from '../rules/types.ts'
import type { RetrievedCodeChunk } from './retrieveCode.ts'

export type ContextFreshness = {
  indexState: 'fresh' | 'stale' | 'partial' | 'indexing'
  lastIndexedAt?: string
  pendingFiles: number
  embeddingState: EmbeddingStatusValue
  activeEmbeddingModel?: string
  activeEmbeddingDimensions?: number
}

export type ContextPack = {
  codeContext: RetrievedCodeChunk[]
  learnings: RetrievedLearning[]
  hardRules: RetrievedMachineRule[]
  warnings: Array<{ message: string; severity: 'info' | 'warning' }>
  freshness: ContextFreshness
  promptText: string
}

export function buildContextPack(input: {
  db: CodeIntelligenceDb
  repoKey: string
  codeContext: RetrievedCodeChunk[]
  learnings?: RetrievedLearning[]
  hardRules?: RetrievedMachineRule[]
  indexRunning?: boolean
  pendingFiles?: number
  maxChunkChars?: number
  maxTotalContextChars?: number
}): ContextPack {
  const freshness = getContextFreshness(input.db, input.repoKey, input.indexRunning ?? false, input.pendingFiles ?? 0)
  const warnings: ContextPack['warnings'] = []
  if (freshness.embeddingState === 'fts_only' || freshness.embeddingState === 'failed') {
    warnings.push({ severity: 'info', message: 'Semantic embeddings are unavailable; using lexical code retrieval.' })
  }
  if (freshness.indexState !== 'fresh') {
    warnings.push({ severity: 'warning', message: `Code index is ${freshness.indexState}. Retrieved context may be incomplete.` })
  }

  return {
    codeContext: input.codeContext,
    learnings: input.learnings ?? [],
    hardRules: input.hardRules ?? [],
    warnings,
    freshness,
    promptText: buildPromptText(
      input.codeContext,
      input.learnings ?? [],
      input.hardRules ?? [],
      input.maxTotalContextChars ?? 50_000,
      input.maxChunkChars ?? 6_000
    ),
  }
}

export function getContextFreshness(
  db: CodeIntelligenceDb,
  repoKey: string,
  indexRunning = false,
  pendingFiles = 0
): ContextFreshness {
  const indexing = getIndexingState(db)
  const fileStats = getFileIndexStats(db, repoKey)
  const embeddingStatus = getEmbeddingStatus(db)
  getEmbeddingStats(db, repoKey)

  const indexState: ContextFreshness['indexState'] = indexRunning
    ? 'indexing'
    : !indexing?.full_index_completed_at
      ? 'partial'
      : pendingFiles > 0
        ? 'stale'
        : 'fresh'

  return {
    indexState,
    lastIndexedAt: fileStats.lastIndexedAt ?? undefined,
    pendingFiles,
    embeddingState: embeddingStatus?.status ?? 'not_started',
    activeEmbeddingModel: embeddingStatus?.active_model ?? undefined,
    activeEmbeddingDimensions: embeddingStatus?.active_dimensions ?? undefined,
  }
}

function buildPromptText(
  chunks: RetrievedCodeChunk[],
  learnings: RetrievedLearning[],
  hardRules: RetrievedMachineRule[],
  maxChars: number,
  maxChunkChars: number
): string {
  const lines = ['# Local Codebase Context']
  if (hardRules.length > 0) {
    lines.push('', '## Hard Rules')
    for (const rule of hardRules) {
      lines.push(`- [${rule.severity}] ${rule.message} (${rule.ruleKind}: ${rule.pattern}; why: ${rule.reasons.join(', ')})`)
    }
  }

  if (learnings.length > 0) {
    lines.push('', '## Relevant Codebase Learnings')
    for (const learning of learnings) {
      lines.push(`- ${learning.title}: ${truncateLearningText(learning.summary, 1200)} (why: ${learning.reasons.join(', ')}, confidence: ${learning.confidence.toFixed(2)})`)
      if (learning.avoid) lines.push(`  Avoid: ${learning.avoid}`)
      if (learning.prefer) lines.push(`  Prefer: ${learning.prefer}`)
    }
  }

  lines.push('', '## Relevant Code')
  for (const chunk of chunks) {
    lines.push('', `### ${chunk.path}:${chunk.startLine}-${chunk.endLine}`)
    lines.push(`Why retrieved: ${chunk.reasons.join(', ')}`)
    if (chunk.symbolName) lines.push(`Symbol: ${chunk.symbolName}`)
    lines.push('```')
    lines.push(truncateChunkContent(chunk.content, maxChunkChars))
    lines.push('```')
  }

  const text = lines.join('\n')
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 80))}\n\n[Context truncated to ${maxChars} characters]`
}

function truncateChunkContent(content: string, maxChunkChars: number): string {
  if (content.length <= maxChunkChars) return content
  return `${content.slice(0, Math.max(0, maxChunkChars - 80))}\n\n[Chunk truncated to ${maxChunkChars} characters]`
}

function truncateLearningText(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  return `${content.slice(0, Math.max(0, maxChars - 20))}...`
}
