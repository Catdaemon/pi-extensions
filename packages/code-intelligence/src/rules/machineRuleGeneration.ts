import type { CodebaseLearning } from '../learnings/types.ts'
import type { MachineRule } from './types.ts'

export type MachineRuleDraft = Omit<MachineRule, 'id' | 'createdAt' | 'updatedAt'>

export function generateMachineRuleDrafts(learning: CodebaseLearning): MachineRuleDraft[] {
  if (learning.status !== 'active' || learning.confidence < 0.8) return []

  const rules: MachineRuleDraft[] = []
  const forbiddenImport = forbiddenImportPattern(learning)
  if (forbiddenImport) {
    rules.push({
      learningId: learning.id,
      repoKey: learning.repoKey,
      ruleKind: 'forbidden_import',
      pattern: forbiddenImport,
      message: learning.prefer
        ? `This repo avoids ${learning.avoid}; use ${learning.prefer} instead.`
        : `This repo avoids ${learning.avoid}.`,
      pathGlobs: learning.pathGlobs,
      languages: learning.languages,
      severity: 'error',
      status: 'active',
    })
  }

  const forbiddenPaths = forbiddenPathPatterns(learning)
  for (const pattern of forbiddenPaths) {
    rules.push({
      learningId: learning.id,
      repoKey: learning.repoKey,
      ruleKind: 'forbidden_path_edit',
      pattern,
      message: learning.summary || `Do not edit ${pattern}.`,
      pathGlobs: [pattern],
      languages: learning.languages,
      severity: 'error',
      status: 'active',
    })
  }

  const requiredTestPattern = requiredTestPatternForLearning(learning)
  if (requiredTestPattern) {
    rules.push({
      learningId: learning.id,
      repoKey: learning.repoKey,
      ruleKind: 'required_test_path',
      pattern: requiredTestPattern,
      message: learning.summary || `Changes should include tests under ${requiredTestPattern}.`,
      pathGlobs: [requiredTestPattern],
      languages: learning.languages,
      severity: 'warning',
      status: 'active',
    })
  }

  return rules
}

function forbiddenImportPattern(learning: CodebaseLearning): string | undefined {
  if (!learning.avoid) return undefined
  if (learning.ruleType !== 'avoid_pattern' && learning.ruleType !== 'dependency_policy') return undefined
  const avoid = learning.avoid.trim()
  if (/\s/.test(avoid) && !/^[@\w.-]+\/[\w./-]+$/.test(avoid)) return undefined
  return normalizePackageName(avoid)
}

function forbiddenPathPatterns(learning: CodebaseLearning): string[] {
  if (learning.ruleType !== 'generated_code') return []
  if (learning.pathGlobs?.length) return learning.pathGlobs.map(normalizePathPattern)
  const avoid = learning.avoid?.replace(/^editing\s+/i, '').trim()
  return avoid ? [normalizePathPattern(avoid)] : []
}

function requiredTestPatternForLearning(learning: CodebaseLearning): string | undefined {
  if (learning.ruleType !== 'testing_convention') return undefined
  const path = learning.pathGlobs?.[0] ?? extractPath(learning.prefer) ?? extractPath(learning.summary)
  return path ? normalizeDirectoryPattern(path) : undefined
}

function normalizePackageName(value: string): string {
  const cleaned = value.replace(/^['"`]|['"`]$/g, '').replace(/\s+package$/i, '').trim()
  if (/^[\w-]+\.js$/i.test(cleaned)) return cleaned.replace(/\.js$/i, '')
  return cleaned
}

function normalizePathPattern(value: string): string {
  const cleaned = value.replace(/^['"`]|['"`]$/g, '').trim()
  if (cleaned.includes('*')) return cleaned
  if (cleaned.endsWith('/')) return `${cleaned}**`
  return cleaned
}

function normalizeDirectoryPattern(value: string): string {
  const cleaned = normalizePathPattern(value)
  if (cleaned.includes('*')) return cleaned
  if (/\.[A-Za-z0-9]+$/.test(cleaned)) return cleaned
  return `${cleaned.replace(/\/$/, '')}/**`
}

function extractPath(value: string | undefined): string | undefined {
  if (!value) return undefined
  const match = /((?:[\w.-]+\/)+[\w.@*/-]+|[\w.-]+\/\*\*)/.exec(value)
  return match?.[1]
}
