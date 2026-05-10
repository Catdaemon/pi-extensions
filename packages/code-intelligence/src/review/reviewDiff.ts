import type { CodeIntelligenceDb } from '../db/connection.ts'
import { listMachineRules } from '../db/repositories/rulesRepo.ts'
import { parseUnifiedDiff, type ParsedDiff } from './diffParser.ts'
import { applyMachineRules, type DiffReviewWarning } from './machineChecks.ts'

export type DiffReviewRequest = {
  repoKey: string
  diff: string
  task?: string
  changedFiles?: string[]
}

export type DiffReviewResult = {
  parsed: ParsedDiff
  warnings: DiffReviewWarning[]
  summary: string
}

export function reviewDiff(db: CodeIntelligenceDb, request: DiffReviewRequest): DiffReviewResult {
  const parsed = parseUnifiedDiff(request.diff)
  const rules = listMachineRules(db, request.repoKey, 'active')
  const warnings = applyMachineRules(parsed, rules)
  return {
    parsed,
    warnings,
    summary: summarizeWarnings(warnings),
  }
}

export function formatDiffReviewWarnings(result: DiffReviewResult): string {
  if (result.warnings.length === 0) return 'Code intelligence diff review found no machine-rule warnings.'
  return [
    'Code intelligence diff review warnings:',
    ...result.warnings.map((warning) => {
      const path = warning.path ? `${warning.path}: ` : ''
      return `- [${warning.severity}] ${path}${warning.message} (${warning.ruleKind}: ${warning.pattern}${warning.evidence ? `; ${warning.evidence}` : ''})`
    }),
  ].join('\n')
}

function summarizeWarnings(warnings: DiffReviewWarning[]): string {
  if (warnings.length === 0) return 'no warnings'
  const errors = warnings.filter((warning) => warning.severity === 'error').length
  const nonErrors = warnings.length - errors
  return `${errors} error(s), ${nonErrors} warning/info item(s)`
}
