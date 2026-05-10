import type { CodebaseLearning, LearningCandidate } from './types.ts'

export function buildLearningEmbeddingText(input: Pick<CodebaseLearning | LearningCandidate, 'title' | 'summary' | 'ruleType' | 'appliesWhen' | 'avoid' | 'prefer' | 'pathGlobs' | 'languages'>): string {
  const lines = [`Rule: ${input.title}`, `Type: ${input.ruleType}`, `Summary: ${input.summary}`, `Applies when: ${input.appliesWhen}`]
  if (input.avoid) lines.push(`Avoid: ${input.avoid}`)
  if (input.prefer) lines.push(`Prefer: ${input.prefer}`)
  if (input.pathGlobs?.length) lines.push(`Paths: ${input.pathGlobs.join(', ')}`)
  if (input.languages?.length) lines.push(`Languages: ${input.languages.join(', ')}`)
  return lines.join('\n')
}
