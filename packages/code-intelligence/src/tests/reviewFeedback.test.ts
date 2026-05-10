import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildLearningCandidateFromReviewFeedback, normalizeReviewFeedbackAction } from '../pi/reviewFeedback.ts'

describe('review finding feedback', () => {
  it('normalizes feedback actions', () => {
    assert.equal(normalizeReviewFeedbackAction('accepted'), 'accepted')
    assert.equal(normalizeReviewFeedbackAction('false_positive'), 'false_positive')
    assert.equal(normalizeReviewFeedbackAction('wat'), 'needs_changes')
  })

  it('turns accepted corrections into scoped active learning candidates', () => {
    const candidate = buildLearningCandidateFromReviewFeedback({
      findingId: 'F-1',
      correction: 'Always add tests under src/api/__tests__',
      pathGlobs: ['src/api/**'],
    }, 'accepted', 'event-1')

    assert.equal(candidate.status, 'active')
    assert.equal(candidate.source?.kind, 'review_comment')
    assert.equal(candidate.source?.ref, 'review_feedback:event-1:F-1')
    assert.deepEqual(candidate.pathGlobs, ['src/api/**'])
    assert.equal(candidate.ruleType, 'testing_convention')
    assert(candidate.priority >= 65)
  })

  it('stores needs-changes feedback as draft learning candidates', () => {
    const candidate = buildLearningCandidateFromReviewFeedback({
      findingId: 'F-2',
      title: 'False missing test signal',
      correction: 'Review should inspect generated test helpers before reporting missing tests.',
    }, 'needs_changes', 'event-2')

    assert.equal(candidate.status, 'draft')
    assert.equal(candidate.source?.ref, 'review_feedback:event-2:F-2')
    assert(candidate.confidence <= 0.75)
  })
})
