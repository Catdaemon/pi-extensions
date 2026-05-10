export type LearningRuleType =
  | 'avoid_pattern'
  | 'prefer_pattern'
  | 'testing_convention'
  | 'architecture'
  | 'dependency_policy'
  | 'generated_code'
  | 'style'
  | 'domain_rule'
  | 'workflow'

export type LearningStatus = 'draft' | 'active' | 'superseded' | 'rejected'

export type LearningSourceKind = 'user_correction' | 'review_comment' | 'accepted_patch' | 'manual_note'

export type CodebaseLearning = {
  id: string
  repoKey: string
  packageKey?: string
  title: string
  summary: string
  ruleType: LearningRuleType
  appliesWhen: string
  avoid?: string
  prefer?: string
  pathGlobs?: string[]
  languages?: string[]
  examples?: { bad?: string; good?: string }
  source: {
    kind: LearningSourceKind
    ref?: string
    timestamp: string
  }
  confidence: number
  priority: number
  status: LearningStatus
  embeddingText: string
  createdAt?: string
  updatedAt?: string
  lastUsedAt?: string
  supersededBy?: string
}

export type LearningCandidate = Omit<CodebaseLearning, 'id' | 'repoKey' | 'source' | 'embeddingText'> & {
  source?: Partial<CodebaseLearning['source']>
}

export type RetrievedLearning = CodebaseLearning & {
  score: number
  reasons: Array<'fts_match' | 'semantic_match' | 'learning_scope_match' | 'hard_rule_match'>
}
