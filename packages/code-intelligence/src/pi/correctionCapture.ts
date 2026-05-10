import { appendLearningEvent } from '../db/repositories/eventsRepo.ts'
import { createLearning } from '../db/repositories/learningsRepo.ts'
import { embedLearningIfReady } from '../embeddings/learningEmbeddingIndexer.ts'
import { retrieveLearningsHybrid } from '../retrieval/retrieveLearnings.ts'
import type { EmbeddingService } from '../embeddings/EmbeddingService.ts'
import type { CodeIntelligenceRuntime } from '../lifecycle/activate.ts'
import { activationStatusForConfidence, correctionConfidence, maybeCorrectionSignal } from '../learnings/detectCorrection.ts'
import { extractManualLearning } from '../learnings/extractLearning.ts'
import { scopeLearningCandidate } from '../learnings/scopeLearning.ts'
import type { CodebaseLearning, LearningCandidate } from '../learnings/types.ts'

export type CorrectionCaptureResult =
  | { kind: 'ignored'; reason: string }
  | { kind: 'stored'; learning: CodebaseLearning; status: 'active' | 'draft' }

export async function captureCorrectionLearning(
  runtime: CodeIntelligenceRuntime,
  text: string,
  options: { rewrite?: (text: string, fallback?: LearningCandidate) => Promise<LearningCandidate | undefined> } = {}
): Promise<CorrectionCaptureResult> {
  if (!maybeCorrectionSignal(text)) return { kind: 'ignored', reason: 'no correction signal' }

  const fallback = extractManualLearning(text)
  const extracted = (await safeRewrite(options.rewrite, text, fallback)) ?? fallback
  if (!extracted) {
    appendLearningEvent(runtime.db, {
      repoKey: runtime.identity.repoKey,
      eventKind: 'correction_ignored',
      payload: { text, reason: 'no extraction' },
    })
    return { kind: 'ignored', reason: 'no extraction' }
  }

  const confidence = Math.min(extracted.confidence, correctionConfidence(text))
  if (isGenericFallbackExtraction(extracted, text)) {
    appendLearningEvent(runtime.db, {
      repoKey: runtime.identity.repoKey,
      eventKind: 'correction_ignored',
      payload: { text, reason: 'generic extraction', confidence },
    })
    return { kind: 'ignored', reason: 'generic extraction' }
  }
  const activation = activationStatusForConfidence(confidence)
  if (activation === 'ignored') {
    appendLearningEvent(runtime.db, {
      repoKey: runtime.identity.repoKey,
      eventKind: 'correction_ignored',
      payload: { text, reason: 'low confidence', confidence },
    })
    return { kind: 'ignored', reason: 'low confidence' }
  }

  const scoped = scopeLearningCandidate(
    {
      ...extracted,
      confidence,
      status: activation,
      source: { kind: 'user_correction', timestamp: new Date().toISOString() },
    },
    { text, config: runtime.config }
  )
  const embeddingService = runtime.services.get<EmbeddingService>('embeddingService')
  const { learning, reused } = await createOrReuseLearning(runtime, scoped, embeddingService)
  if (reused) {
    appendLearningEvent(runtime.db, {
      repoKey: runtime.identity.repoKey,
      learningId: learning.id,
      eventKind: 'correction_captured',
      payload: { text, confidence, status: learning.status, title: learning.title, semanticDuplicate: true },
    })
    return { kind: 'stored', learning, status: learning.status === 'active' ? 'active' : 'draft' }
  }
  appendLearningEvent(runtime.db, {
    repoKey: runtime.identity.repoKey,
    learningId: learning.id,
    eventKind: 'correction_captured',
    payload: { text, confidence, status: scoped.status, title: learning.title },
  })

  return { kind: 'stored', learning, status: scoped.status === 'active' ? 'active' : 'draft' }
}

export async function createOrReuseLearning(
  runtime: CodeIntelligenceRuntime,
  candidate: LearningCandidate,
  embeddingService = runtime.services.get<EmbeddingService>('embeddingService')
): Promise<{ learning: CodebaseLearning; reused: boolean }> {
  const duplicate = await findSemanticDuplicate(runtime, embeddingService, candidate)
  if (duplicate) return { learning: duplicate, reused: true }
  const learning = createLearning(runtime.db, runtime.identity.repoKey, candidate)
  await embedLearningIfReady(runtime.db, embeddingService, learning)
  return { learning, reused: false }
}

async function safeRewrite(
  rewrite: ((text: string, fallback?: LearningCandidate) => Promise<LearningCandidate | undefined>) | undefined,
  text: string,
  fallback: LearningCandidate | undefined
): Promise<LearningCandidate | undefined> {
  if (!rewrite) return undefined
  try {
    return await rewrite(text, fallback)
  } catch {
    return undefined
  }
}

async function findSemanticDuplicate(
  runtime: CodeIntelligenceRuntime,
  embeddingService: EmbeddingService | undefined,
  candidate: LearningCandidate
): Promise<CodebaseLearning | undefined> {
  const query = [candidate.title, candidate.summary, candidate.avoid, candidate.prefer, candidate.appliesWhen].filter(Boolean).join('\n')
  const similar = await retrieveLearningsHybrid(runtime.db, embeddingService, {
    repoKey: runtime.identity.repoKey,
    packageKey: candidate.packageKey,
    query,
    maxLearnings: 3,
  })
  return similar.find((learning) => {
    if (learning.score < 0.72) return false
    if (learning.ruleType !== candidate.ruleType) return false
    if (!termsOverlap(learning, candidate)) return false
    if (candidate.pathGlobs?.length && learning.pathGlobs?.length && !candidate.pathGlobs.some((glob) => learning.pathGlobs?.includes(glob))) return false
    return true
  })
}

function termsOverlap(learning: CodebaseLearning, candidate: LearningCandidate): boolean {
  const learningTerms = [learning.title, learning.summary, learning.avoid, learning.prefer].filter(Boolean).join(' ').toLowerCase()
  const candidateTerms = [candidate.title, candidate.summary, candidate.avoid, candidate.prefer].filter(Boolean).join(' ').toLowerCase()
  const keyTerms = [...(candidate.avoid?.split(/\W+/) ?? []), ...(candidate.prefer?.split(/\W+/) ?? [])]
    .map((term) => term.toLowerCase())
    .filter((term) => term.length >= 3)
  if (keyTerms.some((term) => learningTerms.includes(term))) return true
  if (learning.avoid && candidateTerms.includes(learning.avoid.toLowerCase())) return true
  if (learning.prefer && candidateTerms.includes(learning.prefer.toLowerCase())) return true
  return false
}

function isGenericFallbackExtraction(extracted: { title: string; summary: string; avoid?: string; prefer?: string; pathGlobs?: string[] }, text: string): boolean {
  const normalizedSummary = extracted.summary.trim().replace(/\s+/g, ' ')
  const normalizedText = text.trim().replace(/\s+/g, ' ')
  if (normalizedSummary !== normalizedText) return false
  if (extracted.avoid || extracted.prefer || (extracted.pathGlobs && extracted.pathGlobs.length > 0)) return false
  return true
}
