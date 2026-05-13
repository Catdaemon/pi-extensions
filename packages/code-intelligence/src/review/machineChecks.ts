import { matchesAnyGlob } from '../indexing/glob.ts'
import { isTestPath, isTestRequirementPattern } from '../lib/pathClassifiers.ts'
import type { MachineRule } from '../rules/types.ts'
import type { ParsedDiff } from './diffParser.ts'

export type DiffReviewWarning = {
  ruleId: string
  ruleKind: MachineRule['ruleKind']
  severity: MachineRule['severity']
  message: string
  path?: string
  pattern: string
  evidence?: string
}

export function applyMachineRules(diff: ParsedDiff, rules: MachineRule[]): DiffReviewWarning[] {
  const warnings: DiffReviewWarning[] = [...checkDuplicateAddedText(diff)]
  for (const rule of rules.filter((item) => item.status === 'active')) {
    if (rule.ruleKind === 'forbidden_import') warnings.push(...checkForbiddenImport(diff, rule))
    else if (rule.ruleKind === 'forbidden_dependency') warnings.push(...checkForbiddenDependency(diff, rule))
    else if (rule.ruleKind === 'forbidden_path_edit') warnings.push(...checkForbiddenPathEdit(diff, rule))
    else if (rule.ruleKind === 'required_test_path') warnings.push(...checkRequiredTestPath(diff, rule))
  }
  return dedupeWarnings(warnings)
}

function checkDuplicateAddedText(diff: ParsedDiff): DiffReviewWarning[] {
  const seen = new Map<string, Array<{ path: string; line: string }>>()
  for (const file of diff.files) {
    for (const line of file.addedLines) {
      const normalized = normalizeDuplicateCandidate(line)
      if (!normalized) continue
      const matches = seen.get(normalized) ?? []
      matches.push({ path: file.path, line: line.trim() })
      seen.set(normalized, matches)
    }
  }

  return Array.from(seen.entries())
    .filter(([, matches]) => matches.length > 1)
    .map(([pattern, matches]) => ({
      ruleId: 'intrinsic:duplicate_added_text',
      ruleKind: 'duplicate_added_text',
      severity: 'warning',
      message: 'Repeated added text may be a DRY violation; consider extracting a shared constant/helper if it represents the same concept.',
      pattern,
      evidence: matches.map((match) => `${match.path}: ${match.line}`).slice(0, 4).join(' | '),
    }))
}

function normalizeDuplicateCandidate(line: string): string | undefined {
  const trimmed = line.trim().replace(/\s+/g, ' ')
  if (trimmed.length < 80) return undefined
  if (/^[{}()[\],;]+$/.test(trimmed)) return undefined
  if (/^(import|export)\s/.test(trimmed)) return undefined
  return trimmed
}

function checkForbiddenImport(diff: ParsedDiff, rule: MachineRule): DiffReviewWarning[] {
  return diff.addedImports
    .filter((item) => importMatches(item.source, rule.pattern))
    .map((item) => warning(rule, item.path, item.line))
}

function checkForbiddenDependency(diff: ParsedDiff, rule: MachineRule): DiffReviewWarning[] {
  return diff.addedDependencies
    .filter((item) => importMatches(item.name, rule.pattern))
    .map((item) => warning(rule, item.path, `${item.kind}.${item.name}`))
}

function checkForbiddenPathEdit(diff: ParsedDiff, rule: MachineRule): DiffReviewWarning[] {
  return diff.files.filter((file) => pathMatches(file.path, rule)).map((file) => warning(rule, file.path, 'file edited'))
}

function checkRequiredTestPath(diff: ParsedDiff, rule: MachineRule): DiffReviewWarning[] {
  if (!isTestRequirementPattern(rule.pattern)) return []
  const changedFiles = diff.files.map((file) => file.path)
  const sourceGlobs = rule.pathGlobs?.filter((pattern) => !isTestRequirementPattern(pattern)) ?? []
  const hasSourceChange = changedFiles.some((path) => !isTestPath(path) && (sourceGlobs.length === 0 || matchesAnyGlob(path, sourceGlobs)))
  if (!hasSourceChange) return []
  const hasRequiredTest = changedFiles.some((path) => matchesAnyGlob(path, [rule.pattern]))
  return hasRequiredTest ? [] : [warning(rule, undefined, `no changed file matched ${rule.pattern}`)]
}

function warning(rule: MachineRule, path: string | undefined, evidence: string): DiffReviewWarning {
  return {
    ruleId: rule.id,
    ruleKind: rule.ruleKind,
    severity: rule.severity,
    message: rule.message,
    path,
    pattern: rule.pattern,
    evidence,
  }
}

function importMatches(source: string, pattern: string): boolean {
  return source === pattern || source.startsWith(`${pattern}/`) || stripJs(source) === stripJs(pattern)
}

function stripJs(value: string): string {
  return value.replace(/\.js$/i, '')
}

function pathMatches(path: string, rule: MachineRule): boolean {
  const patterns = rule.pathGlobs?.length ? rule.pathGlobs : [rule.pattern]
  return matchesAnyGlob(path, patterns)
}

function dedupeWarnings(warnings: DiffReviewWarning[]): DiffReviewWarning[] {
  const seen = new Set<string>()
  return warnings.filter((warning) => {
    const key = `${warning.ruleId}:${warning.path ?? ''}:${warning.evidence ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
