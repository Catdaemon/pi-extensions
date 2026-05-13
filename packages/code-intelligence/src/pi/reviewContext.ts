import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { CHEAP_REVIEW_PASSES, DEFAULT_MODEL_REVIEW_PASSES, REVIEW_PASSES, loadConfig, type CodeIntelligenceConfig, type ReviewConfigRule, type ReviewModelRoutingConfig, type ReviewPass } from '../config.ts'
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
import { formatDiffReviewWarnings, reviewDiffWithCodebaseDryChecks } from '../review/reviewDiff.ts'
import { formatGraphContextSummary, retrieveReviewContext, type GraphFileSummary } from '../retrieval/graphContext.ts'
import { retrieveCodeHybrid, type RetrievedCodeChunk } from '../retrieval/retrieveCode.ts'
import { retrieveLearningsHybrid } from '../retrieval/retrieveLearnings.ts'
import { CodeIntelligenceLogger } from '../logger.ts'
import { extractMentionedFilePaths, findSourceTestCounterparts } from './planningIntegration.ts'

export type ReviewSelectedScope = {
  mode: 'git_changes' | 'branch_diff' | 'whole_directory'
  repoRoot?: string
  branch?: string
  baseRef?: string
  warning?: string
  summary: string
  details: string
}

export type ReviewConfigContext = {
  filesLoaded: string[]
  errors: string[]
  matchingRules: ReviewConfigRule[]
  modelRouting: ReviewModelRoutingConfig
}

export type CurrentModelRef = {
  provider?: string
  id?: string
}

export type ResolvedReviewModelRouting = {
  currentModel?: string
  strategy: ReviewModelRoutingConfig['strategy']
  allowCrossProvider: boolean
  models: Partial<Record<ReviewPass | 'default', string>>
  notes: string[]
}

export type ReviewChangedRange = {
  startLine: number
  endLine: number
  addedLines: number
}

export type ReviewPacket = {
  file: string
  changedRanges: ReviewChangedRange[]
  changedDeclarations: Array<{ name: string; kind: string; startLine: number }>
  graphSummary?: GraphFileSummary
  relatedFiles: string[]
  testCounterparts: string[]
  testStatus: 'found' | 'missing_candidate' | 'unknown'
  queryFocus: string[]
  relevantSnippets: Array<{ path: string; startLine: number; endLine: number; symbolName?: string; reasons: string[] }>
}

export type ReviewCodeIntelligenceResult = {
  enabled: boolean
  repoKey?: string
  contextPack?: ContextPack
  graphContext?: GraphFileSummary[]
  reviewPackets?: ReviewPacket[]
  reviewConfig?: ReviewConfigContext
  reviewWarnings?: string
  indexedAnalysis?: string
  changedFiles: string[]
  warning?: string
}

export function normalizeReviewFocus(args: string): string {
  return args.trim().replace(/\s+/g, ' ')
}

export async function retrieveReviewCodeIntelligence(input: {
  pi: ExtensionAPI
  ctx: ExtensionCommandContext
  scope: ReviewSelectedScope
  args: string
  onProgress?: (message: string) => void
}): Promise<ReviewCodeIntelligenceResult> {
  const focus = normalizeReviewFocus(input.args)
  let changedFiles: string[] = []
  let changedRangesByFile = new Map<string, ReviewChangedRange[]>()

  try {
    input.onProgress?.('identifying repo')
    const identity = await identifyRepo(input.scope.repoRoot ?? input.ctx.cwd)
    input.onProgress?.('reading git diff')
    changedFiles = await resolveReviewChangedFiles(input.pi, input.scope)
    changedRangesByFile = await resolveReviewChangedRanges(input.pi, input.scope)

    if (!(await isCodeIntelligenceEnabled(identity.repoKey))) {
      return { enabled: false, repoKey: identity.repoKey, changedFiles, warning: 'Code intelligence is disabled for this repo.' }
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
      const query = buildReviewQuery({ scope: input.scope, focus, changedFiles })
      const embeddingService = new TransformersEmbeddingService(config, new CodeIntelligenceLogger())
      const maxCodeChunks = Math.max(config.maxCodeChunks, Math.max(24, currentFiles.length * 3))
      input.onProgress?.('retrieving code context')
      const codeContext = mergeRetrievedCodeChunks(
        await Promise.all(
          buildReviewQueries({ baseQuery: query, focus, changedFiles }).map((retrievalQuery) =>
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
        maxCodeChunks
      )
      input.onProgress?.('running diff preflight checks')
      const diffText = await resolveReviewDiff(input.pi, input.scope)
      const diffReview = diffText.trim()
        ? await reviewDiffWithCodebaseDryChecks(db, { repoKey: identity.repoKey, diff: diffText, embeddingService })
        : undefined
      const reviewWarnings = diffReview && diffReview.warnings.length > 0 ? formatDiffReviewWarnings(diffReview) : undefined

      input.onProgress?.('retrieving learnings and rules')
      const learnings = await retrieveLearningsHybrid(db, embeddingService, {
        repoKey: identity.repoKey,
        query,
        packageKey,
        maxLearnings: config.maxLearnings,
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
      const reviewConfig = buildReviewConfigContext(config, currentFiles)
      const indexedAnalysis = formatIndexedChangeAnalysis({ changedFiles: currentFiles, reviewPackets, graphContext, reviewWarnings })

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
      return { enabled: true, repoKey: identity.repoKey, contextPack, graphContext, reviewPackets, reviewConfig, reviewWarnings, indexedAnalysis, changedFiles }
    } finally {
      closeCodeIntelligenceDb(db)
    }
  } catch (error) {
    return {
      enabled: false,
      changedFiles,
      warning: `Code intelligence context retrieval failed: ${(error as Error).message}`,
    }
  }
}

export function renderReviewCodeIntelligenceContext(result: ReviewCodeIntelligenceResult): string {
  if (!result.enabled || !result.contextPack) {
    const reason = result.warning ?? 'Code intelligence is not enabled for this repo.'
    return `# Code Intelligence Context\n\n${reason} Review should rely on the selected scope and normal project context only.`
  }

  return [
    '# Code Intelligence Context',
    `Scope: review`,
    `Changed files: ${result.changedFiles.length > 0 ? result.changedFiles.join(', ') : '(none detected)'}`,
    `Freshness: index=${result.contextPack.freshness.indexState}, embeddings=${result.contextPack.freshness.embeddingState}`,
    '',
    result.contextPack.promptText,
    result.reviewWarnings ? ['## Diff Preflight Warnings', result.reviewWarnings].join('\n\n') : '',
    result.indexedAnalysis ?? '',
    result.graphContext && result.graphContext.length > 0 ? formatGraphContextSummary(result.graphContext) : '',
    result.reviewPackets && result.reviewPackets.length > 0 ? formatReviewPackets(result.reviewPackets) : '',
    result.reviewConfig ? formatReviewConfigContext(result.reviewConfig) : '',
  ].join('\n')
}

export function buildReviewConfigContext(config: CodeIntelligenceConfig, files: string[]): ReviewConfigContext {
  const uniqueFiles = [...new Set(files)]
  const matchingRules = config.review.rules.filter((rule) => {
    if (!rule.scope || rule.scope.length === 0) return true
    return uniqueFiles.some((file) => rule.scope!.some((pattern) => minimatch(file, pattern, { dot: true })))
  })
  return {
    filesLoaded: config.review.status.filesLoaded,
    errors: config.review.status.errors,
    matchingRules,
    modelRouting: config.review.modelRouting,
  }
}

export function formatReviewConfigContext(context: ReviewConfigContext): string {
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
  const modelRouting = context.modelRouting ?? { strategy: 'same-family-cheap' as const, allowCrossProvider: false, models: {} }
  if (modelRouting.strategy !== 'same-family-cheap' || modelRouting.allowCrossProvider || Object.keys(modelRouting.models).length > 0) {
    lines.push(`Review model routing: strategy=${modelRouting.strategy}, allowCrossProvider=${modelRouting.allowCrossProvider}`)
  }
  return lines.join('\n')
}

export function resolveReviewModelRouting(config: ReviewModelRoutingConfig | undefined, currentModel: CurrentModelRef | undefined): ResolvedReviewModelRouting {
  const routing = config ?? { strategy: 'same-family-cheap' as const, allowCrossProvider: false, models: {} }
  const currentModelName = formatCurrentModelRef(currentModel)
  const rawCurrentProvider = currentModel?.provider ?? currentModelName?.split('/')[0]
  const currentProvider = normalizeProvider(rawCurrentProvider)
  const notes: string[] = []
  const explicitDefault = safeExplicitModel(routing.models.default, currentProvider, routing.allowCrossProvider, notes, 'default')
  const models: ResolvedReviewModelRouting['models'] = {}

  if (routing.strategy === 'inherit') {
    notes.push('No subagent model overrides; all passes inherit the current session model.')
    return { currentModel: currentModelName, strategy: routing.strategy, allowCrossProvider: routing.allowCrossProvider, models, notes }
  }

  for (const pass of REVIEW_PASSES) {
    const explicit = safeExplicitModel(routing.models[pass], currentProvider, routing.allowCrossProvider, notes, pass)
    if (explicit) models[pass] = explicit
    else if (routing.strategy === 'explicit' && explicitDefault) models[pass] = explicitDefault
  }

  if (routing.strategy === 'same-family-cheap') {
    const cheapModel = sameFamilyCheapModel(rawCurrentProvider, currentProvider, currentModel?.id ?? currentModelName)
    for (const pass of CHEAP_REVIEW_PASSES) {
      if (!models[pass] && cheapModel) models[pass] = cheapModel
    }
    for (const pass of DEFAULT_MODEL_REVIEW_PASSES) {
      if (!models[pass] && explicitDefault) models[pass] = explicitDefault
    }
    if (!cheapModel && currentProvider) notes.push(`No known cheap same-family model for provider ${currentProvider}; unset passes inherit current model.`)
  }

  return { currentModel: currentModelName, strategy: routing.strategy, allowCrossProvider: routing.allowCrossProvider, models, notes }
}

export function formatReviewModelRoutingForPrompt(routing: ResolvedReviewModelRouting): string {
  const lines = [
    'Review model routing:',
    `- Current session model: ${routing.currentModel ?? 'unknown/default'}`,
    `- Strategy: ${routing.strategy}; allowCrossProvider=${routing.allowCrossProvider}`,
  ]
  const entries = Object.entries(routing.models).filter(([, model]) => Boolean(model))
  if (entries.length === 0) lines.push('- Model overrides: none; omit task.model so subagents inherit the current model.')
  else {
    lines.push('- Model overrides to use when creating subagent tasks:')
    for (const [pass, model] of entries) lines.push(`  - ${pass}: ${model}`)
  }
  for (const note of routing.notes) lines.push(`- Note: ${note}`)
  lines.push('- Never choose a cross-provider model unless allowCrossProvider=true or that exact pass model is explicitly configured and allowed.')
  lines.push('- For any pass not listed above, omit task.model rather than guessing.')
  return lines.join('\n')
}

function formatCurrentModelRef(model: CurrentModelRef | undefined): string | undefined {
  if (!model?.provider && !model?.id) return undefined
  return model.provider && model.id ? `${model.provider}/${model.id}` : model.id ?? model.provider
}

function normalizeProvider(provider: string | undefined): string | undefined {
  if (!provider) return undefined
  const lower = provider.toLowerCase()
  if (lower.includes('openai')) return 'openai'
  if (lower.includes('anthropic') || lower.includes('claude')) return 'anthropic'
  if (lower.includes('google') || lower.includes('gemini')) return 'google'
  if (lower.includes('openrouter')) return 'openrouter'
  if (lower.includes('xai') || lower.includes('grok')) return 'xai'
  return lower
}

function safeExplicitModel(model: string | undefined, currentProvider: string | undefined, allowCrossProvider: boolean, notes: string[], pass: string): string | undefined {
  if (!model) return undefined
  const provider = normalizeProvider(model.includes('/') ? model.split('/')[0] : currentProvider)
  if (!allowCrossProvider && currentProvider && provider && provider !== currentProvider) {
    notes.push(`Ignored ${pass} model ${model} because it is outside current provider ${currentProvider}.`)
    return undefined
  }
  return model
}

function sameFamilyCheapModel(rawProvider: string | undefined, normalizedProvider: string | undefined, currentModelId: string | undefined): string | undefined {
  const current = currentModelId?.toLowerCase() ?? ''
  const provider = rawProvider?.trim() || normalizedProvider
  if (!provider) return undefined
  // Preserve subscription/custom provider ids while swapping only the model id. For example,
  // openai-codex/gpt-5.5 should route cheap passes to openai-codex/gpt-4.1-mini.
  if (normalizedProvider === 'openai') {
    if (provider.toLowerCase() === 'openai-codex') return current.includes('gpt-5.4-mini') ? undefined : `${provider}/gpt-5.4-mini`
    return current.includes('gpt-4.1-mini') || current.includes('gpt-4o-mini') ? undefined : `${provider}/gpt-4.1-mini`
  }
  if (normalizedProvider === 'anthropic') return current.includes('haiku') ? undefined : `${provider}/claude-3-5-haiku-latest`
  if (normalizedProvider === 'google') return current.includes('flash') ? undefined : `${provider}/gemini-2.5-flash`
  if (normalizedProvider === 'xai') return current.includes('mini') ? undefined : `${provider}/grok-3-mini`
  return undefined
}

export function buildReviewPackets(
  files: string[],
  graphContext: GraphFileSummary[] = [],
  codeContext: RetrievedCodeChunk[] = [],
  changedRangesByFile: Map<string, ReviewChangedRange[]> = new Map()
): ReviewPacket[] {
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

export function formatIndexedChangeAnalysis(input: {
  changedFiles: string[]
  reviewPackets?: ReviewPacket[]
  graphContext?: GraphFileSummary[]
  reviewWarnings?: string
}): string {
  const packets = input.reviewPackets ?? []
  if (input.changedFiles.length === 0 && packets.length === 0 && !input.reviewWarnings) return ''
  const lines = ['## Indexed Change Analysis']
  lines.push('- Contract/API risk: check exported changed declarations, callers/imported-by, route/screens, schema/type changes, and downstream tests before accepting compatibility.')
  lines.push('- Review coverage: every changed file should be accounted for; files with callers, similar implementations, or missing counterparts need explicit verification or a stated non-test rationale.')
  lines.push('- Local patterns: compare changed code against similar files/snippets and prefer existing helpers, schemas, factories, middleware, and conventions over new ad-hoc code.')
  lines.push('- Test quality: counterpart tests should exercise observable behavior, failure modes, integration contracts, and regressions rather than static config/object shape.')
  lines.push('- Implementation planning: inspect impacted callers/callees/routes/tests before editing, and add validation for high-risk changed behavior.')
  const risky = packets.filter((packet) => packet.changedDeclarations.some((item) => packet.graphSummary?.declarations.find((declaration) => declaration.name === item.name)?.exported) || (packet.graphSummary?.importedBy.length ?? 0) > 0 || (packet.graphSummary?.calledBy.length ?? 0) > 0)
  if (risky.length > 0) lines.push(`- High-impact changed files: ${risky.map((packet) => packet.file).slice(0, 8).join(', ')}`)
  const missingTests = packets.filter((packet) => packet.testStatus === 'missing_candidate').map((packet) => packet.file)
  if (missingTests.length > 0) lines.push(`- Missing/unknown test counterparts: ${missingTests.slice(0, 8).join(', ')}`)
  const similar = packets.filter((packet) => (packet.graphSummary?.similar.length ?? 0) > 0).map((packet) => `${packet.file} -> ${packet.graphSummary!.similar.slice(0, 3).join(', ')}`)
  if (similar.length > 0) lines.push('- Similar local patterns to compare:', ...similar.slice(0, 6).map((item) => `  - ${item}`))
  if (input.reviewWarnings?.trim()) lines.push('- Preflight warnings must be verified or dismissed in coverage.')
  return lines.join('\n')
}

export function formatReviewPackets(packets: ReviewPacket[]): string {
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

export type ReviewFinding = {
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
    '- Suggested fix: <smallest warranted change using existing local patterns/schemas/helpers where applicable>',
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
    'Structured /code-intelligence-review report requirements:',
    '- Do not edit files in review mode.',
    '- Use the exact report shape below so findings, coverage, and readiness are machine-scannable.',
    '- Start with a findings summary grouped by severity P0/P1/P2/P3.',
    '- For every finding include: id, severity, type, confidence 0–1, file, line/range when available, title, evidence, impact, suggested fix, and related files.',
    '- Before proposing validation, parsing, auth, data-access, API, or test fixes, inspect existing local patterns such as shared schemas, validators, safeParse/parse helpers, middleware, error helpers, test factories, route/service conventions, and similar implementations.',
    '- Cite graph evidence when available, such as imports, imported-by, calls, renders, hooks, tests/counterparts, route/screen, same-feature, or similar patterns.',
    '- Include one coverage table row for every changed file, even files with no findings.',
    '- Include validation status and skipped reason for every changed file.',
    '- Include a readiness score from 0–5 with a concise rationale.',
    '- If no findings are warranted, still include the coverage table and readiness score.',
    '',
    buildReviewReportTemplate(),
  ].join('\n')
}

export async function resolveReviewChangedFiles(pi: ExtensionAPI, scope: ReviewSelectedScope): Promise<string[]> {
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

async function resolveReviewDiff(pi: ExtensionAPI, scope: ReviewSelectedScope): Promise<string> {
  if (!scope.repoRoot) return ''
  const diffArgs = scope.mode === 'branch_diff' && scope.baseRef
    ? [['diff', '--no-ext-diff', `${scope.baseRef}...HEAD`, '--']]
    : [['diff', '--no-ext-diff', '--cached', '--'], ['diff', '--no-ext-diff', '--']]
  const results = await Promise.all(diffArgs.map((args) => pi.exec('git', ['-C', scope.repoRoot!, ...args], { timeout: 10_000 })))
  return results.map((result) => result.stdout ?? '').join('\n')
}

async function resolveReviewChangedRanges(pi: ExtensionAPI, scope: ReviewSelectedScope): Promise<Map<string, ReviewChangedRange[]>> {
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

export function parseChangedRangesFromDiff(diff: string): Map<string, ReviewChangedRange[]> {
  const rangesByFile = new Map<string, ReviewChangedRange[]>()
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

function mergeChangedRangeMaps(maps: Map<string, ReviewChangedRange[]>[]): Map<string, ReviewChangedRange[]> {
  const merged = new Map<string, ReviewChangedRange[]>()
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

function formatChangedRanges(ranges: ReviewChangedRange[]): string {
  return ranges
    .slice(0, 5)
    .map((range) => (range.startLine === range.endLine ? `L${range.startLine}` : `L${range.startLine}-L${range.endLine}`))
    .join(', ')
}

function buildReviewQuery(input: { scope: ReviewSelectedScope; focus: string; changedFiles: string[] }): string {
  return [
    'Review code using local repository patterns.',
    input.scope.summary,
    input.focus,
    input.changedFiles.join('\n'),
    input.scope.details,
  ]
    .filter(Boolean)
    .join('\n')
}

export function buildReviewQueries(input: { baseQuery: string; focus: string; changedFiles: string[] }): string[] {
  const changedFilesText = input.changedFiles.join('\n')
  const categoryQueries = [
    ['Correctness review: edge cases, error handling, lifecycle cleanup, async races, idempotency problems, and resource leaks.', input.focus, changedFilesText].join('\n'),
    ['Test review: missing, weak, flaky, or inconsistent tests and source/test counterpart patterns. Flag tests-for-tests-sake that only assert configuration objects, constants, fixtures, factory output, snapshots, or mocks without exercising behavior, contracts, failure modes, or regressions.', input.focus, changedFilesText].join('\n'),
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
