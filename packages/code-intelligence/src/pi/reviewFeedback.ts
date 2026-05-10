import { extractManualLearning } from '../learnings/extractLearning.ts'

export type ReviewFeedbackAction = 'accepted' | 'rejected' | 'false_positive' | 'needs_changes'

export type ReviewFeedbackInput = {
  findingId: string
  title?: string
  evidence?: string
  correction?: string
  pathGlobs?: string[]
}

export function normalizeReviewFeedbackAction(action: string): ReviewFeedbackAction {
  return action === 'accepted' || action === 'rejected' || action === 'false_positive' || action === 'needs_changes' ? action : 'needs_changes'
}

export function buildLearningCandidateFromReviewFeedback(input: ReviewFeedbackInput, action: 'accepted' | 'needs_changes', eventId: string) {
  const correction = input.correction?.trim() || input.title?.trim() || input.evidence?.trim() || `Review finding ${input.findingId} was useful.`
  const extracted = extractManualLearning(correction)
  return {
    ...(extracted ?? {
      title: input.title?.trim() || `Review feedback for ${input.findingId}`,
      summary: correction,
      ruleType: 'workflow' as const,
      appliesWhen: 'When reviewing similar changes in this repo.',
      confidence: action === 'accepted' ? 0.75 : 0.65,
      priority: 55,
      status: 'draft' as const,
    }),
    title: extracted?.title ?? input.title?.trim() ?? `Review feedback for ${input.findingId}`,
    summary: extracted?.summary ?? correction,
    pathGlobs: input.pathGlobs && input.pathGlobs.length > 0 ? input.pathGlobs : extracted?.pathGlobs,
    source: { kind: 'review_comment' as const, ref: `review_feedback:${eventId}:${input.findingId}`, timestamp: new Date().toISOString() },
    confidence: Math.min(extracted?.confidence ?? (action === 'accepted' ? 0.75 : 0.65), action === 'accepted' ? 0.85 : 0.75),
    priority: Math.max(extracted?.priority ?? 0, action === 'accepted' ? 65 : 55),
    status: action === 'accepted' ? 'active' as const : 'draft' as const,
  }
}
