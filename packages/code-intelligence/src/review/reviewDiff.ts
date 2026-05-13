import type { CodeIntelligenceDb } from '../db/connection.ts'
import { listMachineRules } from '../db/repositories/rulesRepo.ts'
import { parseUnifiedDiff, type ParsedDiff } from './diffParser.ts'
import type { EmbeddingService } from '../embeddings/EmbeddingService.ts'
import { retrieveCodeHybrid } from '../retrieval/retrieveCode.ts'
import { applyMachineRules, type DiffReviewWarning } from './machineChecks.ts'

export type DiffReviewRequest = {
  repoKey: string
  diff: string
  task?: string
  changedFiles?: string[]
}

export type CodebaseDryReviewRequest = DiffReviewRequest & {
  embeddingService?: EmbeddingService
  maxCandidates?: number
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

export async function reviewDiffWithCodebaseDryChecks(db: CodeIntelligenceDb, request: CodebaseDryReviewRequest): Promise<DiffReviewResult> {
  const result = reviewDiff(db, request)
  const warnings = [...result.warnings, ...(await findCodebaseDryWarnings(db, result.parsed, request))]
  return { ...result, warnings, summary: summarizeWarnings(warnings) }
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

async function findCodebaseDryWarnings(
  db: CodeIntelligenceDb,
  parsed: ParsedDiff,
  request: CodebaseDryReviewRequest
): Promise<DiffReviewWarning[]> {
  const candidates = extractAddedDryCandidates(parsed).slice(0, request.maxCandidates ?? 8)
  const warnings: DiffReviewWarning[] = []
  const changedFiles = new Set(parsed.files.map((file) => file.path))

  for (const candidate of candidates) {
    const matches = await retrieveCodeHybrid(db, request.embeddingService, {
      repoKey: request.repoKey,
      query: candidate.text,
      maxCodeChunks: 5,
    })
    const external = matches.find((match) => !changedFiles.has(match.path) && isDrySimilarityMatch(candidate.text, match.content, match.score, match.reasons))
    if (!external) continue
    warnings.push({
      ruleId: 'intrinsic:codebase_dry_similarity',
      ruleKind: 'duplicate_added_text',
      severity: 'warning',
      message: 'Added code resembles existing indexed code; check whether an existing helper, type, schema, fixture, or abstraction should be reused instead of reimplemented.',
      path: candidate.path,
      pattern: truncate(candidate.text, 160),
      evidence: `similar to ${external.path}:${external.startLine}-${external.endLine} (${external.reasons.join(', ')})`,
    })
  }

  return dedupeDryWarnings(warnings)
}

function extractAddedDryCandidates(parsed: ParsedDiff): Array<{ path: string; text: string }> {
  const candidates: Array<{ path: string; text: string }> = []
  for (const file of parsed.files) {
    const block: string[] = []
    const flush = () => {
      const text = block.join('\n').trim()
      if (isSearchableDryCandidate(text)) candidates.push({ path: file.path, text })
      block.length = 0
    }
    for (const line of file.diffLines) {
      if (line.kind === 'added') block.push(line.text)
      else flush()
    }
    flush()
  }
  return candidates
}

function isSearchableDryCandidate(text: string): boolean {
  if (text.length < 80) return false
  if (/^import\s|^export\s+\{/.test(text.trim())) return false
  return /\b(function|const|class|type|interface|schema|validator|parse|format|normalize|build|create|render|test|describe|it)\b/.test(text)
}

function isDrySimilarityMatch(query: string, content: string, score: number, reasons: string[]): boolean {
  const queryTerms = meaningfulTerms(query)
  const contentTerms = new Set(meaningfulTerms(content))
  const overlap = queryTerms.filter((term) => contentTerms.has(term)).length / Math.max(1, queryTerms.length)
  if (overlap >= 0.55) return true
  return reasons.includes('semantic_match') && score >= 0.7 && overlap >= 0.25
}

function meaningfulTerms(text: string): string[] {
  const terms = new Set((text.toLowerCase().match(/[a-z_][a-z0-9_]{3,}/g) ?? [])
    .filter((term) => !DRY_STOP_WORDS.has(term)))
  return [...terms]
}

const DRY_STOP_WORDS = new Set(['const', 'function', 'return', 'type', 'interface', 'string', 'number', 'boolean', 'undefined', 'export', 'import', 'from', 'true', 'false'])

function truncate(text: string, limit: number): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 3)}...`
}

function dedupeDryWarnings(warnings: DiffReviewWarning[]): DiffReviewWarning[] {
  const seen = new Set<string>()
  return warnings.filter((warning) => {
    const key = `${warning.path}:${warning.evidence}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function summarizeWarnings(warnings: DiffReviewWarning[]): string {
  if (warnings.length === 0) return 'no warnings'
  const errors = warnings.filter((warning) => warning.severity === 'error').length
  const nonErrors = warnings.length - errors
  return `${errors} error(s), ${nonErrors} warning/info item(s)`
}
