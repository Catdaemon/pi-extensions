import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { loadConfig, type CodeIntelligenceConfig, type ReviewConfigRule } from '../config.ts'
import { minimatch } from 'minimatch'
import { closeCodeIntelligenceDb, openCodeIntelligenceDb } from '../db/connection.ts'
import { retrieveHardRules } from '../db/repositories/rulesRepo.ts'
import { findActiveFilePaths } from '../db/repositories/filesRepo.ts'
import { TransformersEmbeddingService } from '../embeddings/transformersEmbeddingService.ts'
import { identifyRepo } from '../repo/identifyRepo.ts'
import { isCodeIntelligenceEnabled } from '../repo/enabledRepos.ts'
import { packageKeyForPath } from '../repo/packageDetection.ts'
import { resolveRepoStorageDir } from '../repo/storage.ts'
import { buildContextPack, type ContextPack } from '../retrieval/contextPack.ts'
import { formatGraphContextSummary, retrieveReviewContext, type GraphFileSummary } from '../retrieval/graphContext.ts'
import { retrieveCodeHybrid, type RetrievedCodeChunk } from '../retrieval/retrieveCode.ts'
import { retrieveLearningsHybrid } from '../retrieval/retrieveLearnings.ts'
import { CodeIntelligenceLogger } from '../logger.ts'
import { extractMentionedFilePaths, findSourceTestCounterparts } from './planningIntegration.ts'

export type ImproveMode = 'default' | 'changed' | 'review' | 'tests' | 'conventions' | 'package'

export type ImproveSelectedScope = {
  mode: 'git_changes' | 'branch_diff' | 'whole_directory'
  repoRoot?: string
  branch?: string
  baseRef?: string
  warning?: string
  summary: string
  details: string
}

export type ImproveReviewConfigContext = {
  filesLoaded: string[]
  errors: string[]
  matchingRules: ReviewConfigRule[]
}

export type ImproveChangedRange = {
  startLine: number
  endLine: number
  addedLines: number
}

export type ImproveReviewPacket = {
  file: string
  changedRanges: ImproveChangedRange[]
  changedDeclarations: Array<{ name: string; kind: string; startLine: number }>
  graphSummary?: GraphFileSummary
  relatedFiles: string[]
  testCounterparts: string[]
  testStatus: 'found' | 'missing_candidate' | 'unknown'
  queryFocus: string[]
  relevantSnippets: Array<{ path: string; startLine: number; endLine: number; symbolName?: string; reasons: string[] }>
}

export type ImproveCodeIntelligenceResult = {
  enabled: boolean
  repoKey?: string
  contextPack?: ContextPack
  graphContext?: GraphFileSummary[]
  reviewPackets?: ImproveReviewPacket[]
  reviewConfig?: ImproveReviewConfigContext
  mode: ImproveMode
  changedFiles: string[]
  warning?: string
}

const IMPROVE_FLAGS: Array<{ flag: string; mode: ImproveMode }> = [
  { flag: 'changed', mode: 'changed' },
  { flag: 'review', mode: 'review' },
  { flag: 'tests', mode: 'tests' },
  { flag: 'conventions', mode: 'conventions' },
  { flag: 'package', mode: 'package' },
]

function improveFlagPattern(flag: string): RegExp {
  return new RegExp(`(?:^|\\s)--${flag}(?=\\s|$)`, 'g')
}

export function parseImproveMode(args: string): ImproveMode {
  for (const { flag, mode } of IMPROVE_FLAGS) {
    if (improveFlagPattern(flag).test(args)) return mode
  }
  return 'default'
}

export function stripImproveFlags(args: string): string {
  let stripped = args
  for (const { flag } of IMPROVE_FLAGS) {
    stripped = stripped.replace(improveFlagPattern(flag), ' ')
  }
  return stripped.trim().replace(/\s+/g, ' ')
}

export async function retrieveImproveCodeIntelligence(input: {
  pi: ExtensionAPI
  ctx: ExtensionCommandContext
  scope: ImproveSelectedScope
  args: string
  onProgress?: (message: string) => void
}): Promise<ImproveCodeIntelligenceResult> {
  const mode = parseImproveMode(input.args)
  const focus = stripImproveFlags(input.args)
  let changedFiles: string[] = []
  let changedRangesByFile = new Map<string, ImproveChangedRange[]>()

  try {
    input.onProgress?.('identifying repo')
    const identity = await identifyRepo(input.scope.repoRoot ?? input.ctx.cwd)
    input.onProgress?.('reading git diff')
    changedFiles = await resolveImproveChangedFiles(input.pi, input.ctx, input.scope)
    changedRangesByFile = await resolveImproveChangedRanges(input.pi, input.ctx, input.scope)

    if (!(await isCodeIntelligenceEnabled(identity.repoKey))) {
      return { enabled: false, repoKey: identity.repoKey, mode, changedFiles, warning: 'Code intelligence is disabled for this repo.' }
    }

    input.onProgress?.('opening index')
    const storageDir = resolveRepoStorageDir(identity.repoKey)
    const db = await openCodeIntelligenceDb(storageDir)
    try {
      const config = await loadConfig(identity.gitRoot)
      const mentionedFiles = extractMentionedFilePaths(`${input.scope.details}\n${focus}`)
      const wholeRepoFiles = changedFiles.length === 0 && input.scope.mode === 'whole_directory'
        ? selectWholeRepoReviewFiles(db, identity.repoKey, focus)
        : []
      const currentFiles = [...new Set([...changedFiles, ...mentionedFiles, ...wholeRepoFiles])]
      const counterpartFiles = findSourceTestCounterparts(currentFiles, config)
      const packageKey = currentFiles.map((path) => packageKeyForPath(path, config)).find(Boolean)
      const query = buildImproveQuery({ scope: input.scope, focus, mode, changedFiles })
      const embeddingService = new TransformersEmbeddingService(config, new CodeIntelligenceLogger())
      const baseMaxCodeChunks = mode === 'conventions' ? Math.max(4, Math.floor(config.maxCodeChunks / 2)) : config.maxCodeChunks
      const maxCodeChunks = mode === 'review' ? Math.max(baseMaxCodeChunks, Math.max(24, currentFiles.length * 3)) : baseMaxCodeChunks
      input.onProgress?.('retrieving code context')
      const codeContext = mergeRetrievedCodeChunks(
        await Promise.all(
          buildImproveQueries({ baseQuery: query, focus, changedFiles, mode }).map((retrievalQuery) =>
            retrieveCodeHybrid(db, embeddingService, {
              repoKey: identity.repoKey,
              query: retrievalQuery,
              currentFiles,
              changedFiles,
              visibleFiles: counterpartFiles,
              sourceTestCounterpartFiles: counterpartFiles,
              packageKey,
              maxCodeChunks,
            })
          )
        ),
        Math.max(maxCodeChunks, mode === 'default' ? 18 : maxCodeChunks)
      )
      input.onProgress?.('retrieving learnings and rules')
      const learnings = await retrieveLearningsHybrid(db, embeddingService, {
        repoKey: identity.repoKey,
        query,
        packageKey,
        maxLearnings: mode === 'tests' ? Math.max(config.maxLearnings, 10) : config.maxLearnings,
      })
      const hardRules = retrieveHardRules(db, identity.repoKey)
      input.onProgress?.('building graph review context')
      const reviewContext = retrieveReviewContext(
        db,
        identity.repoKey,
        { changedFiles: currentFiles, query, seedPaths: [...counterpartFiles, ...codeContext.slice(0, 8).map((chunk) => chunk.path)] },
        { maxFiles: Math.max(16, currentFiles.length + counterpartFiles.length + codeContext.length), maxItemsPerSection: 8, maxRelatedFiles: Math.max(32, currentFiles.length * 4) }
      )
      const graphContext = reviewContext.summaries

      const reviewPackets = buildReviewPackets(currentFiles, graphContext, codeContext, changedRangesByFile)
      const reviewConfig = buildImproveReviewConfigContext(config, currentFiles)

      input.onProgress?.('formatting review context')
      const contextPack = buildContextPack({
        db,
        repoKey: identity.repoKey,
        codeContext,
        learnings,
        hardRules,
        maxChunkChars: config.maxChunkChars,
        maxTotalContextChars: config.maxTotalContextChars,
      })

      input.onProgress?.('ready')
      return { enabled: true, repoKey: identity.repoKey, contextPack, graphContext, reviewPackets, reviewConfig, mode, changedFiles }
    } finally {
      closeCodeIntelligenceDb(db)
    }
  } catch (error) {
    return {
      enabled: false,
      mode,
      changedFiles,
      warning: `Code intelligence context retrieval failed: ${(error as Error).message}`,
    }
  }
}

export function renderImproveCodeIntelligenceContext(result: ImproveCodeIntelligenceResult): string {
  if (!result.enabled || !result.contextPack) {
    const reason = result.warning ?? 'Code intelligence is not enabled for this repo.'
    return `# Code Intelligence Context\n\n${reason} /improve should rely on the selected scope and normal project context only.`
  }

  return [
    '# Code Intelligence Context',
    `Mode: ${result.mode}`,
    `Changed files: ${result.changedFiles.length > 0 ? result.changedFiles.join(', ') : '(none detected)'}`,
    `Freshness: index=${result.contextPack.freshness.indexState}, embeddings=${result.contextPack.freshness.embeddingState}`,
    '',
    result.contextPack.promptText,
    result.graphContext && result.graphContext.length > 0 ? formatGraphContextSummary(result.graphContext) : '',
    result.reviewPackets && result.reviewPackets.length > 0 ? formatReviewPackets(result.reviewPackets) : '',
    result.reviewConfig ? formatImproveReviewConfigContext(result.reviewConfig) : '',
  ].join('\n')
}

export function buildImproveReviewConfigContext(config: CodeIntelligenceConfig, files: string[]): ImproveReviewConfigContext {
  const uniqueFiles = [...new Set(files)]
  const matchingRules = config.review.rules.filter((rule) => {
    if (!rule.scope || rule.scope.length === 0) return true
    return uniqueFiles.some((file) => rule.scope!.some((pattern) => minimatch(file, pattern, { dot: true })))
  })
  return {
    filesLoaded: config.review.status.filesLoaded,
    errors: config.review.status.errors,
    matchingRules,
  }
}

export function formatImproveReviewConfigContext(context: ImproveReviewConfigContext): string {
  if (context.filesLoaded.length === 0 && context.errors.length === 0 && context.matchingRules.length === 0) return ''
  const lines = ['## Repo-local Review Config']
  lines.push(`Loaded: ${context.filesLoaded.length > 0 ? context.filesLoaded.join(', ') : '(none)'}`)
  if (context.errors.length > 0) {
    lines.push('Errors:')
    for (const error of context.errors.slice(0, 5)) lines.push(`- ${error}`)
  }
  if (context.matchingRules.length > 0) {
    lines.push('Matching scoped rules:')
    for (const rule of context.matchingRules.slice(0, 12)) {
      const scope = rule.scope && rule.scope.length > 0 ? ` scope=${rule.scope.join(',')}` : ''
      lines.push(`- [${rule.severity}] ${rule.id}${scope}: ${rule.instruction}`)
    }
  }
  return lines.join('\n')
}

export function buildReviewPackets(
  files: string[],
  graphContext: GraphFileSummary[] = [],
  codeContext: RetrievedCodeChunk[] = [],
  changedRangesByFile: Map<string, ImproveChangedRange[]> = new Map()
): ImproveReviewPacket[] {
  const graphByPath = new Map(graphContext.map((summary) => [summary.path, summary]))
  return [...new Set(files)].map((file) => {
    const graphSummary = graphByPath.get(file)
    const changedRanges = changedRangesByFile.get(file) ?? []
    const changedDeclarations = graphSummary
      ? graphSummary.declarations
          .filter((declaration) => typeof declaration.startLine === 'number' && changedRanges.some((range) => declaration.startLine! >= range.startLine && declaration.startLine! <= range.endLine))
          .map((declaration) => ({ name: declaration.name, kind: declaration.kind, startLine: declaration.startLine! }))
      : []
    const relatedFiles = graphSummary ? uniqueStrings([
      ...graphSummary.imports,
      ...graphSummary.importedBy,
      ...graphSummary.tests,
      ...graphSummary.routeScreens,
      ...graphSummary.sameFeature,
      ...graphSummary.similar,
    ]) : []
    const testCounterparts = graphSummary ? uniqueStrings([...graphSummary.tests, ...graphSummary.counterparts]) : []
    const testStatus = testCounterparts.length > 0 ? 'found' : graphSummary ? 'missing_candidate' : 'unknown'
    const queryFocus = graphSummary ? [
      graphSummary.calls.length > 0 ? 'correctness via calls/constructs' : '',
      graphSummary.calledBy.length > 0 ? 'impact on callers' : '',
      graphSummary.renders.length > 0 || graphSummary.hooks.length > 0 ? 'React render/hook behavior' : '',
      testCounterparts.length > 0 ? 'test counterpart coverage' : 'missing test counterpart check',
      changedRanges.length > 0 ? `changed lines ${formatChangedRanges(changedRanges)}` : '',
      changedDeclarations.length > 0 ? `changed declarations ${changedDeclarations.map((declaration) => declaration.name).slice(0, 4).join(', ')}` : '',
      graphSummary.similar.length > 0 ? 'similar-pattern consistency' : '',
    ].filter(Boolean) : ['changed-file review', 'test counterpart determination']
    const relevantPaths = new Set([file, ...relatedFiles, ...testCounterparts])
    const relevantSnippets = codeContext
      .filter((chunk) => relevantPaths.has(chunk.path))
      .slice(0, 6)
      .map((chunk) => ({ path: chunk.path, startLine: chunk.startLine, endLine: chunk.endLine, symbolName: chunk.symbolName, reasons: chunk.reasons }))
    return { file, changedRanges, changedDeclarations, graphSummary, relatedFiles, testCounterparts, testStatus, queryFocus, relevantSnippets }
  })
}

export function formatReviewPackets(packets: ImproveReviewPacket[]): string {
  const lines = ['## Per-file Review Packets', '', '| File | Changed areas | Graph context to inspect | Test/counterpart status | Relevant snippets | Review focus |', '| --- | --- | --- | --- | --- | --- |']
  for (const packet of packets) {
    const graphParts = packet.graphSummary ? [
      packet.graphSummary.imports.length > 0 ? `imports ${packet.graphSummary.imports.length}` : '',
      packet.graphSummary.importedBy.length > 0 ? `imported-by ${packet.graphSummary.importedBy.length}` : '',
      packet.graphSummary.calls.length > 0 ? `calls ${packet.graphSummary.calls.length}` : '',
      packet.graphSummary.calledBy.length > 0 ? `called-by ${packet.graphSummary.calledBy.length}` : '',
      packet.graphSummary.renders.length > 0 ? `renders ${packet.graphSummary.renders.length}` : '',
      packet.graphSummary.hooks.length > 0 ? `hooks ${packet.graphSummary.hooks.length}` : '',
      packet.graphSummary.similar.length > 0 ? `similar ${packet.graphSummary.similar.length}` : '',
    ].filter(Boolean).join(', ') || 'declarations only' : 'no graph summary found'
    const tests = packet.testCounterparts.length > 0 ? packet.testCounterparts.slice(0, 3).join(', ') : packet.testStatus === 'missing_candidate' ? 'no counterpart found; verify if tests are needed' : 'determine if tests are missing'
    const snippets = packet.relevantSnippets.length > 0
      ? packet.relevantSnippets.slice(0, 4).map((item) => `${item.path}:${item.startLine}-${item.endLine}${item.symbolName ? ` ${item.symbolName}` : ''}`).join('<br>')
      : 'none retrieved yet'
    const changedAreas = packet.changedRanges.length > 0
      ? `${formatChangedRanges(packet.changedRanges)}${packet.changedDeclarations.length > 0 ? ` (${packet.changedDeclarations.map((item) => item.name).slice(0, 4).join(', ')})` : ''}`
      : 'no diff hunk mapped'
    lines.push(`| ${packet.file} | ${changedAreas} | ${graphParts} | ${tests} | ${snippets} | ${packet.queryFocus.join('; ')} |`)
  }
  return lines.join('\n')
}

export type ImproveFinding = {
  id: string
  file: string
  startLine?: number
  endLine?: number
  severity: 'P0' | 'P1' | 'P2' | 'P3'
  type: 'correctness' | 'test' | 'convention' | 'maintainability' | 'security' | 'performance' | 'resource' | 'docs'
  confidence: number
  title: string
  evidence: string
  impact: string
  suggestedFix?: string
  relatedFiles?: string[]
  graphEvidence?: Array<{ kind: string; path: string; symbol?: string; reason: string }>
}

export function buildReviewReportTemplate(): string {
  return [
    'Use this exact report shape:',
    '',
    '## Review Findings',
    '- P0: <count> finding(s)',
    '- P1: <count> finding(s)',
    '- P2: <count> finding(s)',
    '- P3: <count> finding(s)',
    '',
    '### Findings',
    'For each finding:',
    '#### <id> [<severity>] <title>',
    '- Type: <correctness|test|convention|maintainability|security|performance|resource|docs>',
    '- Confidence: <0.00-1.00>',
    '- Location: <file>:<line-range or unknown>',
    '- Evidence: <specific code, diff hunk, graph edge, hard rule, or local pattern checked>',
    '- Impact: <why this matters>',
    '- Suggested fix: <smallest warranted change>',
    '- Related files: <imports/imported-by/tests/counterparts/similar files inspected, or none>',
    '',
    '## Coverage',
    '| File | Changed areas | Graph/source-test context inspected | Findings | Validation status | Skipped reason |',
    '| --- | --- | --- | --- | --- | --- |',
    '| <file> | <diff lines/declarations or n/a> | <imports/imported-by/tests/counterparts/similar snippets checked> | <ids or none> | <validated/not run/not applicable> | <reason or none> |',
    '',
    '## Readiness',
    '- Score: <0-5>',
    '- Rationale: <concise rationale tied to severity, coverage, and validation>',
  ].join('\n')
}

export function buildStructuredReviewRequirements(): string {
  return [
    'Structured /improve --review report requirements:',
    '- Do not edit files in review mode.',
    '- Use the exact report shape below so findings, coverage, and readiness are machine-scannable.',
    '- Start with a findings summary grouped by severity P0/P1/P2/P3.',
    '- For every finding include: id, severity, type, confidence 0–1, file, line/range when available, title, evidence, impact, suggested fix, and related files.',
    '- Cite graph evidence when available, such as imports, imported-by, calls, renders, hooks, tests/counterparts, route/screen, same-feature, or similar patterns.',
    '- Include one coverage table row for every changed file, even files with no findings.',
    '- Include validation status and skipped reason for every changed file.',
    '- Include a readiness score from 0–5 with a concise rationale.',
    '- If no findings are warranted, still include the coverage table and readiness score.',
    '',
    buildReviewReportTemplate(),
  ].join('\n')
}

export function improveModeInstructions(mode: ImproveMode): string[] {
  if (mode === 'review') return [
    'Run in review-only mode: identify improvement opportunities, but do not edit files unless the user explicitly asks in a follow-up.',
    buildStructuredReviewRequirements(),
  ]
  if (mode === 'tests') return ['Focus especially on missing, weak, or inconsistent tests. Prefer source/test counterpart patterns from code intelligence.']
  if (mode === 'conventions') return ['Focus especially on local codebase learnings, hard rules, and consistency with retrieved local patterns.']
  if (mode === 'package') return ['Prefer package-level patterns and avoid broad repo-wide refactors outside the package scope.']
  if (mode === 'changed') return ['Focus on currently changed files and their source/test counterparts.']
  return []
}

export async function resolveImproveChangedFiles(pi: ExtensionAPI, ctx: ExtensionCommandContext, scope: ImproveSelectedScope): Promise<string[]> {
  if (!scope.repoRoot) return []
  const args = scope.mode === 'branch_diff' && scope.baseRef ? ['diff', '--name-only', `${scope.baseRef}...HEAD`, '--'] : ['diff', '--name-only', 'HEAD', '--']
  const result = await pi.exec('git', ['-C', scope.repoRoot, ...args], { timeout: 10_000 })
  const diffFiles = parseGitPathLines(result.stdout ?? '')
  if (scope.mode !== 'git_changes') return diffFiles

  const untracked = await pi.exec('git', ['-C', scope.repoRoot, 'ls-files', '--others', '--exclude-standard'], { timeout: 10_000 })
  return uniqueStrings([...diffFiles, ...parseGitPathLines(untracked.stdout ?? '')])
}

function parseGitPathLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

async function resolveImproveChangedRanges(pi: ExtensionAPI, ctx: ExtensionCommandContext, scope: ImproveSelectedScope): Promise<Map<string, ImproveChangedRange[]>> {
  if (!scope.repoRoot) return new Map()
  const diffArgs = scope.mode === 'branch_diff' && scope.baseRef
    ? [['diff', '--unified=0', `${scope.baseRef}...HEAD`, '--']]
    : [['diff', '--unified=0', '--cached', '--'], ['diff', '--unified=0', '--']]
  const maps = await Promise.all(diffArgs.map(async (args) => {
    const result = await pi.exec('git', ['-C', scope.repoRoot!, ...args], { timeout: 10_000 })
    return parseChangedRangesFromDiff(result.stdout ?? '')
  }))
  return mergeChangedRangeMaps(maps)
}

export function parseChangedRangesFromDiff(diff: string): Map<string, ImproveChangedRange[]> {
  const rangesByFile = new Map<string, ImproveChangedRange[]>()
  let currentFile: string | undefined
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      currentFile = undefined
      continue
    }
    if (line.startsWith('+++ /dev/null')) {
      currentFile = undefined
      continue
    }
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice('+++ b/'.length).trim()
      if (!rangesByFile.has(currentFile)) rangesByFile.set(currentFile, [])
      continue
    }
    if (!currentFile || !line.startsWith('@@')) continue
    const match = /\+(\d+)(?:,(\d+))?/.exec(line)
    if (!match) continue
    const startLine = Number(match[1])
    const addedLines = Math.max(0, Number(match[2] ?? '1'))
    if (addedLines === 0) continue
    rangesByFile.get(currentFile)!.push({ startLine, endLine: startLine + addedLines - 1, addedLines })
  }
  return rangesByFile
}

function mergeChangedRangeMaps(maps: Map<string, ImproveChangedRange[]>[]): Map<string, ImproveChangedRange[]> {
  const merged = new Map<string, ImproveChangedRange[]>()
  for (const map of maps) {
    for (const [file, ranges] of map) {
      merged.set(file, [...(merged.get(file) ?? []), ...ranges])
    }
  }
  return merged
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function formatChangedRanges(ranges: ImproveChangedRange[]): string {
  return ranges
    .slice(0, 5)
    .map((range) => (range.startLine === range.endLine ? `L${range.startLine}` : `L${range.startLine}-L${range.endLine}`))
    .join(', ')
}

function buildImproveQuery(input: { scope: ImproveSelectedScope; focus: string; mode: ImproveMode; changedFiles: string[] }): string {
  return [
    'Improve code using local repository patterns.',
    `Mode: ${input.mode}`,
    input.scope.summary,
    input.focus,
    input.changedFiles.join('\n'),
    input.scope.details,
  ]
    .filter(Boolean)
    .join('\n')
}

export function buildImproveQueries(input: { baseQuery: string; focus: string; changedFiles: string[]; mode: ImproveMode }): string[] {
  const changedFilesText = input.changedFiles.join('\n')
  const categoryQueries = [
    ['Correctness review: edge cases, error handling, lifecycle cleanup, async races, idempotency problems, and resource leaks.', input.focus, changedFilesText].join('\n'),
    ['Test review: missing, weak, flaky, or inconsistent tests and source/test counterpart patterns.', input.focus, changedFilesText].join('\n'),
    ['Convention review: local patterns, hard rules, architectural consistency, duplicated logic, oversized files, and maintainability issues.', input.focus, changedFilesText].join('\n'),
    ['Duplication review: repeated helpers/types/components that should use existing project or dependency abstractions.', input.focus, changedFilesText].join('\n'),
    ['Resource review: large-input behavior, process/file-handle cleanup, memory growth, retries, cancellation, and partial-failure behavior.', input.focus, changedFilesText].join('\n'),
  ]
  const perFileQueries = input.changedFiles.slice(0, 8).map((file) => [
    `Per-file review packet retrieval for ${file}.`,
    'Find the most relevant declarations, callers, tests/counterparts, local patterns, and similar code for this changed file.',
    input.focus,
  ].join('\n'))
  return [
    input.baseQuery,
    ...categoryQueries,
    ...perFileQueries,
    input.mode === 'tests' ? ['Focus on test coverage gaps and regression tests.', input.focus, changedFilesText].join('\n') : '',
    input.mode === 'conventions' ? ['Focus on codebase conventions, hard rules, local patterns, and consistency.', input.focus, changedFilesText].join('\n') : '',
  ].filter((query, index, array) => query.trim().length > 0 && array.indexOf(query) === index)
}

export function selectWholeRepoReviewFiles(db: Parameters<typeof findActiveFilePaths>[0], repoKey: string, focus: string): string[] {
  const active = findActiveFilePaths(db, repoKey)
    .filter((path) => !isLowValueWholeRepoReviewPath(path))
    .sort((a, b) => wholeRepoReviewPriority(b, focus) - wholeRepoReviewPriority(a, focus) || a.localeCompare(b))
  return active
}

function wholeRepoReviewPriority(path: string, focus: string): number {
  const lower = path.toLowerCase()
  const focusTerms = focus.toLowerCase().split(/\W+/).filter((term) => term.length >= 3)
  let score = 0
  if (/\b(src|app|packages|lib)\//.test(path)) score += 5
  if (/\b(api|route|server|auth|schema|store|hook|component|screen)\b/i.test(path)) score += 4
  if (/\.(test|spec)\.[tj]sx?$/.test(lower)) score += 2
  if (/\.(ts|tsx|js|jsx)$/.test(lower)) score += 2
  for (const term of focusTerms) if (lower.includes(term)) score += 3
  return score
}

function isLowValueWholeRepoReviewPath(path: string): boolean {
  const lower = path.toLowerCase()
  return /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/.test(lower)
    || /(^|\/)(dist|build|coverage|node_modules|\.next|\.turbo)\//.test(lower)
    || /\.(png|jpg|jpeg|gif|webp|svg|ico|lock|map)$/.test(lower)
}

function mergeRetrievedCodeChunks(chunksByQuery: Awaited<ReturnType<typeof retrieveCodeHybrid>>[], limit: number) {
  const byId = new Map<number, Awaited<ReturnType<typeof retrieveCodeHybrid>>[number]>()
  for (const chunks of chunksByQuery) {
    for (const chunk of chunks) {
      const existing = byId.get(chunk.id)
      if (!existing || chunk.score > existing.score) byId.set(chunk.id, chunk)
      else byId.set(chunk.id, { ...existing, reasons: [...new Set([...existing.reasons, ...chunk.reasons])] })
    }
  }
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit)
}
