import type { CodeIntelligenceConfig } from '../config.ts'
import { extractMentionedFilePaths } from '../pi/planningIntegration.ts'
import { packageKeyForPath } from '../repo/packageDetection.ts'
import type { LearningCandidate } from './types.ts'

export function scopeLearningCandidate(
  candidate: LearningCandidate,
  input: { text: string; config: CodeIntelligenceConfig }
): LearningCandidate {
  const mentionedPaths = extractMentionedFilePaths(input.text)
  const packageKey = mentionedPaths.map((path) => packageKeyForPath(path, input.config)).find(Boolean)
  const explicitRepoWide = /\b(in this repo|this repo|always|never|we use|we don't|we do not)\b/i.test(input.text)

  if (explicitRepoWide || mentionedPaths.length === 0) {
    return { ...candidate, packageKey: candidate.packageKey ?? packageKey }
  }

  const pathGlobs = candidate.pathGlobs?.length
    ? candidate.pathGlobs
    : mentionedPaths.map((path) => {
        const parts = path.split('/')
        if (parts.length <= 1) return path
        return `${parts.slice(0, -1).join('/')}/**`
      })

  return {
    ...candidate,
    packageKey: candidate.packageKey ?? packageKey,
    pathGlobs: [...new Set(pathGlobs)],
  }
}
