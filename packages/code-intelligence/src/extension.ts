import { resolve } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { truncateToWidth } from '@earendil-works/pi-tui'
import { renderScopeContext, resolveSelectedScope, type SelectedScope } from './lib/changeScope.ts'
import { Type } from 'typebox'
import { activateCodeIntelligence, type CodeIntelligenceRuntime } from './lifecycle/activate.ts'
import { deactivateCodeIntelligence } from './lifecycle/deactivate.ts'
import { getChunkStats } from './db/repositories/chunksRepo.ts'
import { getEmbeddingStats } from './db/repositories/embeddingsRepo.ts'
import { getEntityStats } from './db/repositories/entitiesRepo.ts'
import { getRelationshipStats } from './db/repositories/relationshipsRepo.ts'
import { getFileRelationshipStats } from './db/repositories/fileRelationshipsRepo.ts'
import { getEmbeddingStatus } from './db/repositories/embeddingStatusRepo.ts'
import { getIndexingState } from './db/repositories/indexingStateRepo.ts'
import { appendLearningEvent } from './db/repositories/eventsRepo.ts'
import { createLearning, listLearnings, updateLearningStatus } from './db/repositories/learningsRepo.ts'
import type { CodebaseLearning, LearningRuleType, LearningStatus } from './learnings/types.ts'
import {
  consolidateSimilarLearnings,
  findStaleLearnings,
  forgetAllLearnings,
  forgetLearning,
  resetCodeIndex,
  resetEmbeddings,
  supersedeLearning,
} from './db/repositories/maintenanceRepo.ts'
import { getMachineRuleStats, listMachineRules, retrieveHardRules } from './db/repositories/rulesRepo.ts'
import { embedLearningIfReady } from './embeddings/learningEmbeddingIndexer.ts'
import { extractManualLearning } from './learnings/extractLearning.ts'
import { CodeIntelligenceLogger } from './logger.ts'
import { enableCodeIntelligenceRepo, disableCodeIntelligenceRepo, isCodeIntelligenceEnabled, listEnabledRepoRecords } from './repo/enabledRepos.ts'
import { identifyRepo, type RepoIdentity } from './repo/identifyRepo.ts'
import { captureCorrectionLearning, createOrReuseLearning } from './pi/correctionCapture.ts'
import { scopeLearningCandidate } from './learnings/scopeLearning.ts'
import { rewriteLearningCandidateWithModel } from './pi/learningRewrite.ts'
import { normalizeReviewFeedbackAction, buildLearningCandidateFromReviewFeedback } from './pi/reviewFeedback.ts'
import { findSourceTestCounterparts, retrievePlanningContextPack, formatPlanningContextMessage } from './pi/planningIntegration.ts'
import { buildPlanCommandPrompt } from './pi/planCommand.ts'
import { improveModeInstructions, renderImproveCodeIntelligenceContext, resolveImproveChangedFiles, retrieveImproveCodeIntelligence, selectWholeRepoReviewFiles, stripImproveFlags, type ImproveCodeIntelligenceResult } from './pi/improveIntegration.ts'
import { ensureCodeIntelligenceInstall, formatInstallStatus } from './lifecycle/install.ts'
import { CodeIntelligenceProgressWidget } from './pi/progressWidget.ts'
import { CodeIntelligenceDashboardComponent } from './pi/statusTui.ts'
import { packageKeyForPath } from './repo/packageDetection.ts'
import { resolveRepoStorageDir } from './repo/storage.ts'
import { buildContextPack, type ContextPack } from './retrieval/contextPack.ts'
import { formatGraphContextSummary, formatGraphEdgeDetails, retrieveGraphContextForFiles, retrieveGraphContextForQuery, retrieveGraphEdgeDetailsForFiles, retrieveImpactContextForDiff, type GraphEdgeDetails, type GraphFileSummary, type ImpactContext } from './retrieval/graphContext.ts'
import { retrieveCodeHybrid } from './retrieval/retrieveCode.ts'
import { retrieveLearningsHybrid } from './retrieval/retrieveLearnings.ts'
import { formatDiffReviewWarnings, reviewDiff } from './review/reviewDiff.ts'
import type { EmbeddingService } from './embeddings/EmbeddingService.ts'
import { STATUS_CARD_OVERLAY_WIDTH, getStatusCardTop, isStatusCardSidebarVisible, registerStatusCard, unregisterStatusCard, updateStatusCardLayout } from '@catdaemon/pi-sidebar'

const CODE_INTELLIGENCE_CARD_ID = 'code-intelligence'

const reviewFeedbackSchema = Type.Object({
  findingId: Type.String({ description: 'Stable id of the review finding being rated or corrected.' }),
  action: Type.String({ description: 'Feedback action: accepted, rejected, false_positive, or needs_changes.' }),
  title: Type.Optional(Type.String({ description: 'Short title for the finding or correction.' })),
  evidence: Type.Optional(Type.String({ description: 'Evidence from the finding, review, or changed code.' })),
  correction: Type.Optional(Type.String({ description: 'What should be learned for future reviews.' })),
  pathGlobs: Type.Optional(Type.Array(Type.String(), { description: 'Optional path globs where this feedback applies.' })),
})

const recordLearningSchema = Type.Object({
  title: Type.String({ description: 'Short title for the durable repo learning.' }),
  summary: Type.String({ description: 'Concise reusable guidance to remember for future work.' }),
  ruleType: Type.String({ description: 'Learning type: avoid_pattern, prefer_pattern, testing_convention, architecture, dependency_policy, generated_code, style, domain_rule, or workflow.' }),
  appliesWhen: Type.String({ description: 'When this learning applies.' }),
  avoid: Type.Optional(Type.String({ description: 'Pattern or behavior to avoid, if applicable.' })),
  prefer: Type.Optional(Type.String({ description: 'Preferred pattern or behavior, if applicable.' })),
  pathGlobs: Type.Optional(Type.Array(Type.String(), { description: 'Optional repo-relative path globs where this applies.' })),
  languages: Type.Optional(Type.Array(Type.String(), { description: 'Optional languages where this applies.' })),
  confidence: Type.Optional(Type.Number({ description: 'Confidence from 0 to 1. Defaults to 0.75.' })),
  priority: Type.Optional(Type.Number({ description: 'Priority from 0 to 100. Defaults to 60.' })),
  status: Type.Optional(Type.String({ description: 'Learning status: draft or active. Use draft for ambiguous guidance.' })),
})

const LEARNING_RULE_TYPES: LearningRuleType[] = [
  'avoid_pattern',
  'prefer_pattern',
  'testing_convention',
  'architecture',
  'dependency_policy',
  'generated_code',
  'style',
  'domain_rule',
  'workflow',
]

function normalizeLearningRuleType(value: string): LearningRuleType {
  const match = LEARNING_RULE_TYPES.find((ruleType) => ruleType === value)
  return match ?? 'prefer_pattern'
}

function normalizeLearningStatus(value: string | undefined, confidence: number): 'active' | 'draft' {
  if (value === 'active') return 'active'
  if (value === 'draft') return 'draft'
  return confidence >= 0.85 ? 'active' : 'draft'
}

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export function buildLearningCaptureGuidance(): string {
  return [
    'When the user gives durable repo guidance, preferences, corrections, or conventions that should apply to future work, call code_intelligence_record_learning.',
    'Do not record ordinary one-off task requirements. Record only reusable guidance; use status=draft when ambiguous.',
    'Low-token examples:',
    '- User: "Don\'t use regex validation here; use the Zod schemas in validation.schemas.ts" -> record prefer existing Zod schemas over ad-hoc regex validation for server validation.',
    '- User: "Always look up codebase conventions for UI work" -> record follow existing UI conventions when doing UI work.',
  ].join('\n')
}

const codeIntelligenceImpactSchema = Type.Object({
  paths: Type.Array(Type.String(), { description: 'File paths to inspect for impact context.' }),
  repoPath: Type.Optional(Type.String({ description: 'Optional repo/directory to inspect. Defaults to the current tool cwd.' })),
  maxFiles: Type.Optional(Type.Number({ description: 'Maximum graph files to include. Defaults to 16.' })),
  maxItemsPerSection: Type.Optional(Type.Number({ description: 'Maximum items per graph summary section. Defaults to 8.' })),
})

const codeIntelligenceSearchSchema = Type.Object({

  query: Type.String({ description: 'Natural-language or code search query for local code intelligence retrieval.' }),
  repoPath: Type.Optional(Type.String({ description: 'Optional repo/directory to search. Defaults to the current tool cwd.' })),
  currentFiles: Type.Optional(Type.Array(Type.String(), { description: 'Files currently being edited or central to the task.' })),
  visibleFiles: Type.Optional(Type.Array(Type.String(), { description: 'Files currently visible or otherwise relevant to bias retrieval.' })),
  changedFiles: Type.Optional(Type.Array(Type.String(), { description: 'Files recently changed by the agent or user.' })),
  maxCodeChunks: Type.Optional(Type.Number({ description: 'Maximum code chunks to return. Defaults to repo config.' })),
  maxLearnings: Type.Optional(Type.Number({ description: 'Maximum codebase learnings to return. Defaults to repo config.' })),
  maxChunkChars: Type.Optional(Type.Number({ description: 'Maximum characters per returned code chunk.' })),
  maxTotalContextChars: Type.Optional(Type.Number({ description: 'Maximum total characters in the formatted context.' })),
  format: Type.Optional(Type.String({ description: 'Output format: compact (default) or full.' })),
  includeRawCode: Type.Optional(Type.Boolean({ description: 'Include raw code chunks in compact output. Defaults to false for compact, true for full.' })),
  mode: Type.Optional(Type.String({ description: 'Retrieval mode: hybrid (default), semantic, or graph.' })),
})

type CodeIntelligenceSearchDetails = {
  active: boolean
  error?: string
  freshness?: unknown
  warnings?: unknown
  stats?: unknown
  retrieved?: unknown
  learnings?: unknown
  hardRules?: unknown
  graph?: unknown
  graphEdges?: unknown
}

class EmptyComponent {
  render(_width: number): string[] {
    return []
  }

  invalidate(): void {}

  dispose(): void {}
}

type ProgressUiState = {
  progressTimer?: { timer: NodeJS.Timeout; lastStatus?: string; widget?: CodeIntelligenceProgressWidget; dashboardTui?: { requestRender(): void } }
  progressOverlayHandle?: { hide(): void }
  progressOverlayTui?: { requestRender(): void; showOverlay(component: unknown, options?: unknown): { hide(): void } }
  progressOverlayTheme?: { fg?: (color: string, text: string) => string; bold?: (text: string) => string }
  progressOverlayTop?: number
  progressOverlayInitializing: boolean
  recoveryTimer?: { timer: NodeJS.Timeout; lastAttemptAt: number }
}

const PROGRESS_UI_STATE_KEY = Symbol.for('pi-code-intelligence.progress-ui-state')
const progressUiState = ((globalThis as typeof globalThis & { [PROGRESS_UI_STATE_KEY]?: ProgressUiState })[PROGRESS_UI_STATE_KEY] ??= {
  progressOverlayInitializing: false,
})
const RECOVERY_POLL_MS = 3_000
const RECOVERY_RETRY_MS = 8_000

const REVIEW_JSON_START = '<!-- pi-code-intelligence-review-json -->'
const REVIEW_JSON_END = '<!-- /pi-code-intelligence-review-json -->'
const REVIEW_FILES_PER_WORKER = 20
const REVIEW_MAX_CONCURRENT_WORKERS = 6

type ParsedReviewFinding = {
  id: string
  severity?: string
  title?: string
  file?: string
  line?: string
  confidence?: number
  type?: string
  evidence?: string
  suggestedFix?: string
}

type ParsedReviewOutput = {
  findings: ParsedReviewFinding[]
  readinessScore?: number
  coverage?: Array<Record<string, unknown>>
  rawJson: string
  markdown: string
}

export function buildCodeIntelligenceReviewPrompt(scope: SelectedScope, extraFocus: string | undefined, intelligence: ImproveCodeIntelligenceResult): string {
  const modeInstructions = improveModeInstructions(intelligence.mode)
  return `You are running a /code-intelligence-review pass.

Act as a strict senior pre-merge reviewer. The tool has two goals: catch real bugs/security/reliability issues, and aggressively eliminate AI-slop coding patterns such as duplication, useless guards, vague abstractions, hallucinated APIs, cargo-cult defensive code, inconsistent local patterns, and untested complexity. Do not edit files in this review pass; report findings only.

${renderScopeContext(scope, extraFocus)}

${renderImproveCodeIntelligenceContext(intelligence)}

Review playbook:
1. Inspect all changed/assigned code first. Do not sample files or stop after the first plausible issue. For every reviewed file, classify risk area: auth/session/permissions, external input/API/routes, database/storage, network/fetch/webhooks, payments/billing, PII/secrets/logging, concurrency/background jobs, UI state/lifecycle, config/build, tests-only, or low-risk utility.
2. For every reviewed file, assess every issue category in the output schema: correctness, security, reliability/resource, performance, maintainability/convention, docs when applicable, and test coverage. Form concrete hypotheses about possible bugs, inconsistencies, missing tests, or risky AI-slop patterns. A hypothesis should name the suspected failure mode and the contract it might violate.
3. For each plausible hypothesis, search related code and learned context before reporting it: graph edges, imports/imported-by, callers/callees, tests/counterparts, similar implementations, hard rules, and high-confidence learnings.
4. Follow call/data chains far enough to confirm or discard the hypothesis. For high-risk files, trace untrusted inputs to sensitive sinks and check validation, authorization/ownership/tenant checks, sanitization, escaping, timeout/retry/cancellation behavior, error handling, and whether secrets/PII can leak to logs or responses.
5. Before proposing any validation, parsing, auth, data-access, API, or test fix, inspect existing local patterns and name them in the finding: shared schemas, validators, safeParse/parse helpers, middleware, error helpers, test factories, route/service conventions, and similar implementations. Prefer the repo's existing abstraction even when an inline regex or ad-hoc helper would be the smallest functional patch. If the changed code bypasses an established pattern, report that convention violation with concrete evidence.
6. Check cross-file contracts using graph context: caller expectations, return shapes, thrown errors, nullable/undefined behavior, schema/API changes, component props, hook lifecycle assumptions, cache invalidation, and whether tests/counterparts were updated.
7. Check AI-slop/code-quality issues aggressively, while still requiring concrete risk. Look for: copy/pasted logic that will drift; duplicate types/schemas/validation rules; ad-hoc validation/parsing when shared schemas or local conventions exist; useless null checks or try/catch blocks that hide errors; broad catch-all handling that returns fake success; dead branches and impossible states; over-abstracted helpers that obscure simple logic; vague names like data/result/handler where domain names are needed; inconsistent patterns versus similar files; large mixed-concern files; hallucinated dependencies/APIs/options; comments that restate code; TODOs used instead of implementation; tests that only assert mocks or snapshots without behavior; and generated-looking code that bypasses repo conventions.
8. Confirm or discard every hypothesis before final output. Report only findings that survive revalidation against guards, tests, configs, related files, documented contracts, and local implementation conventions; downgrade or omit speculative findings.
9. For every credible P1/P2 bug/security/reliability finding, propose a concrete negative test or regression test that would fail before the fix. If no test is appropriate, explain why.
9. Review every changed/assigned file and relevant graph/source-test context before finishing. Include a coverage row for every reviewed file, even files with no findings, and make the coverage row reflect the categories assessed rather than merely saying no findings.
10. Report only high-signal issues, but treat confirmed AI-slop as high-signal when it increases future bug likelihood, obscures control/data flow, duplicates business rules, weakens tests, or hides failures. Avoid pure style preferences, broad rewrites, or “could be cleaner” comments without that risk tie.
12. Suggest the smallest warranted fix for each finding. The suggested fix must cite the existing local pattern or explain that no pattern was found after checking related code.
13. Include a readiness score from 0-5.
14. Finish with a machine-readable JSON block between these exact markers so Pi can open an interactive review panel:
${REVIEW_JSON_START}
{"findings":[{"id":"CI-1","severity":"P2","title":"Short title","file":"path/to/file.ts","line":"L10-L12","confidence":0.8,"type":"correctness","riskArea":"external input/API/routes","evidence":"specific code/diff/graph evidence","dataFlow":"input -> validation -> sink, or n/a","contractsChecked":["caller path or test path"],"testsToAdd":["concrete negative/regression test"],"revalidation":"why this is still valid after checking guards/tests/contracts","suggestedFix":"smallest fix"}],"coverage":[{"file":"path/to/file.ts","riskArea":"...","findings":["CI-1"],"validation":"not run","contextInspected":["imports/callers/tests/similar files"]}],"readinessScore":3}
${REVIEW_JSON_END}
Use valid JSON only inside the markers. If there are no findings, use an empty findings array.
${modeInstructions.map((instruction, index) => `${14 + index}. ${instruction}`).join('\n')}

Important constraints:
- Stay within the selected scope unless a tiny adjacent check is required to validate a finding.
- Do not invent large refactors without evidence from touched code.
- Do not suggest ad-hoc validation/parsing/auth/test helpers until you have checked existing local conventions and shared schemas/helpers.
- Do not make cosmetic recommendations; every edit suggestion must reduce real risk, remove harmful duplication, materially improve clarity, or add meaningful test coverage.
- Treat Code Intelligence hard rules and high-confidence learnings as high-priority repo constraints.`.trim()
}

function buildSubagentCodeIntelligenceReviewPrompt(scope: SelectedScope, extraFocus: string | undefined, intelligence: ImproveCodeIntelligenceResult): string {
  const clusters = buildReviewClusters(intelligence)
  const waves = chunkArray(clusters, REVIEW_MAX_CONCURRENT_WORKERS)
  const taskSpecs = clusters.map((cluster, index) => ({
    wave: Math.floor(index / REVIEW_MAX_CONCURRENT_WORKERS) + 1,
    id: `CI-${index + 1}`,
    title: `Review ${cluster.files.slice(0, 2).join(', ')}${cluster.files.length > 2 ? ` +${cluster.files.length - 2}` : ''}`,
    files: cluster.files,
    focus: cluster.focus,
  }))
  const workerTools = ['code_intelligence_impact', 'code_intelligence_search', 'read', 'bash', 'grep', 'find', 'ls']

  return `You are orchestrating /code-intelligence-review with subagents.

Goal: review the selected code for concrete correctness, security, reliability, maintainability, test-coverage, and AI-slop risks across every assigned file without stuffing the whole repo into one prompt.

${renderScopeContext(scope, extraFocus)}

Code Intelligence summary:
- Changed files: ${intelligence.changedFiles.length > 0 ? intelligence.changedFiles.join(', ') : '(none detected)'}
- Initial retrieved chunks: ${intelligence.contextPack?.codeContext.length ?? 0}
- Graph packets: ${intelligence.reviewPackets?.length ?? 0}
- Worker plan: ${clusters.length} worker task(s), ${waves.length} wave(s), max ${REVIEW_FILES_PER_WORKER} files/worker, max ${REVIEW_MAX_CONCURRENT_WORKERS} workers/wave
- Freshness: index=${intelligence.contextPack?.freshness.indexState ?? 'unknown'}, embeddings=${intelligence.contextPack?.freshness.embeddingState ?? 'unknown'}

Instructions:
1. Use the subagent_run tool in waves. Launch only the tasks from wave 1 first, wait for them to finish, then launch wave 2, and continue until all waves are reviewed. Never run more than the listed wave's tasks concurrently.
2. For every subagent task, pass persist=false, contextMode='task_only', tools=${JSON.stringify(workerTools)}, and a compact task generated from the single Worker task template below plus that worker's assigned files/focus. Do not repeat this entire orchestration prompt or include broad raw code context.
3. Subagents must not edit files. Each subagent must assess all of its assigned files, and for each assigned file consider all issue categories: correctness, security, reliability/resource, performance, maintainability/convention, docs when applicable, test coverage, and AI-slop. They should catch real bugs/security/reliability issues, and aggressively flag AI-slop when it creates concrete maintenance, test, or correctness risk.
4. Subagents should return strict JSON only with this shape:
   {"findings":[{"id":"CI-<cluster>-1","severity":"P0|P1|P2|P3","title":"...","file":"...","line":"Lx-Ly","confidence":0.0,"type":"correctness|test|convention|maintainability|security|performance|resource|docs","riskArea":"...","evidence":"...","dataFlow":"... or n/a","contractsChecked":["..."],"testsToAdd":["..."],"revalidation":"...","suggestedFix":"..."}],"coverage":[{"file":"...","riskArea":"...","findings":["..."],"validation":"not run","contextInspected":["..."]}],"readinessScore":0}
5. After subagents finish, aggregate their results: dedupe overlapping findings, severity-rank, and include one coverage row per changed file.
6. Finish with a concise markdown report and a machine-readable JSON block between these exact markers:
${REVIEW_JSON_START}
{"findings":[],"coverage":[],"readinessScore":3}
${REVIEW_JSON_END}
Use valid JSON only inside the markers.

Worker task template:
${buildSubagentReviewTaskTemplate(extraFocus)}

Subagent task specs, grouped by wave:
${JSON.stringify(taskSpecs, null, 2)}

If subagent_run is unavailable or fails, fall back to a direct review using code_intelligence_search per changed file before reporting.`.trim()
}

function buildReviewClusters(intelligence: ImproveCodeIntelligenceResult): Array<{ files: string[]; focus: string[] }> {
  const packets = intelligence.reviewPackets ?? []
  if (packets.length === 0) return chunkStrings(intelligence.changedFiles, REVIEW_FILES_PER_WORKER).map((files) => ({ files, focus: ['changed-file review'] }))
  const clusters: Array<{ files: string[]; focus: string[] }> = []
  const packetChunks = chunkArray(packets, REVIEW_FILES_PER_WORKER)
  for (const packetChunk of packetChunks) {
    clusters.push({
      files: packetChunk.map((packet) => packet.file),
      focus: [...new Set(packetChunk.flatMap((packet) => packet.queryFocus ?? []))].slice(0, 12),
    })
  }
  return clusters
}

function chunkStrings(values: string[], size: number): string[][] {
  const chunks: string[][] = []
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size))
  return chunks
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size))
  return chunks
}

export function buildSubagentReviewTaskTemplate(extraFocus?: string): string {
  return [
    'You are code-review subagent <id>. Review only your assigned files; do not edit files.',
    'Assigned files: <files from task spec>.',
    'Review focus: <focus from task spec, if any>.',
    extraFocus ? `Additional user focus: ${extraFocus}` : '',
    'Inspect every assigned file. Do not sample files, skip low-risk files, or stop after the first plausible issue. For each file, classify risk area and assess all issue categories: correctness, security, reliability/resource, performance, maintainability/convention, docs when applicable, test coverage, and AI-slop.',
    'For each assigned file and category, form concrete hypotheses about bugs, inconsistencies, missing tests, or risky AI-slop patterns before reporting anything. If a category has no credible hypothesis after inspection, note that in coverage rather than omitting the file.',
    'Retrieve context lazily to confirm or discard each hypothesis: first call code_intelligence_impact for the assigned files, then call code_intelligence_search with changedFiles/currentFiles set to the assigned files and targeted queries for graph edges, callers/callees, tests/counterparts, similar implementations, hard rules, and learnings. Read exact files/diffs only after that.',
    'For risky files, follow call/data chains far enough to verify validation, authz/ownership/tenant checks, sanitization, timeouts/retries/cancellation, cleanup, and PII/secret logging behavior.',
    'Before proposing any validation, parsing, auth, data-access, API, or test fix, inspect existing local patterns and name them in the finding: shared schemas, validators, safeParse/parse helpers, middleware, error helpers, test factories, route/service conventions, and similar implementations. Prefer the repo\'s existing abstraction even when an inline regex or ad-hoc helper would be the smallest functional patch. If the changed code bypasses an established pattern, report that convention violation with concrete evidence.',
    'Check cross-file contracts through callers/callees/imports/tests: return shapes, thrown errors, nullable behavior, schema/API changes, component props, hook lifecycle, cache invalidation, and counterpart tests.',
    'Aggressively hunt AI-slop issues with real impact: copy/pasted logic that will drift; duplicate types/schemas/validation rules; ad-hoc validation/parsing when shared schemas or local conventions exist; useless null checks or try/catch blocks that hide errors; broad catch-all handling that returns fake success; dead branches and impossible states; over-abstracted helpers that obscure simple logic; vague names like data/result/handler where domain names are needed; inconsistent patterns versus similar files; large mixed-concern files; hallucinated dependencies/APIs/options; comments that restate code; TODOs used instead of implementation; tests that only assert mocks or snapshots without behavior; and generated-looking code that bypasses repo conventions.',
    'Before reporting, explicitly confirm or discard each hypothesis by trying to disprove it against guards, tests, configs, related files, learned context, documented contracts, and local implementation conventions. Omit speculative nits, but do not omit coverage for files/categories you assessed.',
    'For each P1/P2 bug/security/reliability finding, include a concrete negative/regression test that would fail before the fix. Suggested fixes must cite the existing local pattern or explain that no pattern was found after checking related code.',
    'Return strict JSON only: {"findings":[{"id":"<id>-1","severity":"P0|P1|P2|P3","title":"...","file":"...","line":"Lx-Ly","confidence":0.0,"type":"correctness|test|convention|maintainability|security|performance|resource|docs","riskArea":"...","evidence":"...","dataFlow":"... or n/a","contractsChecked":["..."],"testsToAdd":["..."],"revalidation":"...","suggestedFix":"..."}],"coverage":[{"file":"...","riskArea":"...","findings":["..."],"validation":"not run","contextInspected":["..."]}],"readinessScore":0}',
  ].filter(Boolean).join('\n')
}

function extractMessageText(message: unknown): string {
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => {
    if (typeof part === 'string') return part
    if (part && typeof part === 'object' && 'text' in part && typeof (part as { text: unknown }).text === 'string') return (part as { text: string }).text
    return ''
  }).join('')
}

function parseCodeIntelligenceReviewOutput(text: string): ParsedReviewOutput | undefined {
  const start = text.indexOf(REVIEW_JSON_START)
  const end = text.indexOf(REVIEW_JSON_END)
  if (start === -1 || end === -1 || end <= start) return undefined
  const rawJson = text.slice(start + REVIEW_JSON_START.length, end).trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim()
  try {
    const parsed = JSON.parse(rawJson) as { findings?: ParsedReviewFinding[]; readinessScore?: number; coverage?: Array<Record<string, unknown>> }
    return {
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
      readinessScore: typeof parsed.readinessScore === 'number' ? parsed.readinessScore : undefined,
      coverage: Array.isArray(parsed.coverage) ? parsed.coverage : [],
      rawJson,
      markdown: text,
    }
  } catch {
    return undefined
  }
}

function formatCodeIntelligenceReviewPanel(output: ParsedReviewOutput): string {
  const lines = ['# Code Intelligence Review Panel', '']
  lines.push(`Findings: ${output.findings.length}`)
  if (typeof output.readinessScore === 'number') lines.push(`Readiness: ${output.readinessScore}/5`)
  lines.push('')
  if (output.findings.length === 0) lines.push('No structured findings were reported.')
  else {
    for (const finding of output.findings) {
      lines.push(`## ${finding.id} ${finding.severity ? `[${finding.severity}] ` : ''}${finding.title ?? '(untitled)'}`)
      lines.push(`- Location: ${finding.file ?? '(unknown)'}${finding.line ? `:${finding.line}` : ''}`)
      if (finding.type) lines.push(`- Type: ${finding.type}`)
      if (typeof finding.confidence === 'number') lines.push(`- Confidence: ${finding.confidence}`)
      if (finding.evidence) lines.push(`- Evidence: ${finding.evidence}`)
      if (finding.suggestedFix) lines.push(`- Suggested fix: ${finding.suggestedFix}`)
      lines.push('')
    }
  }
  lines.push('---', '', '## Full Review Output', '', output.markdown)
  return lines.join('\n')
}

function formatFindingPromptLines(finding: ParsedReviewFinding): string[] {
  return [
    `Finding: ${finding.id} ${finding.severity ? `[${finding.severity}]` : ''} ${finding.title ?? ''}`.trim(),
    finding.file ? `File: ${finding.file}${finding.line ? `:${finding.line}` : ''}` : '',
    finding.evidence ? `Evidence: ${finding.evidence}` : '',
    finding.suggestedFix ? `Suggested fix: ${finding.suggestedFix}` : '',
  ].filter(Boolean)
}

type ReviewPanelAction = 'skip' | 'fix' | 'accepted' | 'false_positive' | 'needs_changes'

export function buildReviewBatchActionPrompt(actions: Array<{ finding: ParsedReviewFinding; action: ReviewPanelAction }>): string {
  const selected = actions.filter((item) => item.action !== 'skip')
  const feedback = selected.filter((item) => item.action !== 'fix')
  const fixes = selected.filter((item) => item.action === 'fix')
  return [
    'Apply these /code-intelligence-review panel actions in one pass.',
    'For every feedback item, call code_intelligence_review_feedback with the requested action. For every fix item, first record code_intelligence_review_feedback action=accepted because selecting a fix means the finding was useful, then inspect related local patterns before editing. Use existing schemas/helpers/middleware/test factories and repo conventions; do not implement ad-hoc validation/parsing/auth/test helpers when a local pattern exists. Then make the smallest safe code change and run targeted validation.',
    '',
    feedback.length > 0 ? 'Feedback only:' : '',
    ...feedback.map(({ finding, action }) => [`- action=${action}`, ...formatFindingPromptLines(finding).map((line) => `  ${line}`)].join('\n')),
    fixes.length > 0 ? 'Fix and mark useful:' : '',
    ...fixes.map(({ finding }) => ['- action=fix_and_accepted', ...formatFindingPromptLines(finding).map((line) => `  ${line}`)].join('\n')),
  ].filter(Boolean).join('\n')
}

function formatImpactContext(impact: ImpactContext): string {
  return [
    '# Code Intelligence Impact',
    `Changed/seed files: ${impact.changedFiles.length > 0 ? impact.changedFiles.join(', ') : '(none)'}`,
    `Directly related files: ${impact.directlyRelatedFiles.length > 0 ? impact.directlyRelatedFiles.join(', ') : '(none)'}`,
    `Impacted files: ${impact.impactedFiles.length > 0 ? impact.impactedFiles.join(', ') : '(none)'}`,
    `Tests/counterparts: ${impact.testFiles.length > 0 ? impact.testFiles.join(', ') : '(none)'}`,
    '',
    formatGraphContextSummary(impact.summaries),
  ].filter(Boolean).join('\n')
}

function formatMissingTestsReport(paths: string[], impact: ImpactContext, testPatterns: string[]): string {
  const summaryByPath = new Map(impact.summaries.map((summary) => [summary.path, summary]))
  const rows = paths.map((path) => {
    const summary = summaryByPath.get(path)
    const tests = summary ? uniqueStrings([...summary.tests, ...summary.counterparts]) : []
    const isTest = isLikelyTestPath(path, testPatterns)
    const status = isTest ? 'test file' : tests.length > 0 ? 'covered/counterpart found' : 'missing candidate'
    const related = summary ? uniqueStrings([...summary.importedBy, ...summary.calledBy.map((item) => item.split('#')[0] ?? ''), ...summary.sameFeature]).slice(0, 5) : []
    return { path, status, tests, related }
  })
  const missing = rows.filter((row) => row.status === 'missing candidate')
  const lines = ['# Code Intelligence Test Coverage Gaps', '', `Files inspected: ${rows.length}`, `Missing candidates: ${missing.length}`, '']
  lines.push('| File | Status | Tests/counterparts | Related context |')
  lines.push('| --- | --- | --- | --- |')
  for (const row of rows) {
    lines.push(`| ${row.path} | ${row.status} | ${row.tests.length > 0 ? row.tests.slice(0, 4).join('<br>') : 'none found'} | ${row.related.length > 0 ? row.related.join('<br>') : 'none'} |`)
  }
  if (missing.length > 0) {
    lines.push('', '## Likely missing tests')
    for (const row of missing) lines.push(`- ${row.path}: no indexed test/counterpart relationship found. Inspect related context and add/identify tests if behavior changed.`)
  }
  return lines.join('\n')
}

function isLikelyTestPath(path: string, testPatterns: string[]): boolean {
  if (/\.(test|spec)\.[tj]sx?$/i.test(path) || /(^|\/)(test|tests|__tests__)\//i.test(path)) return true
  return testPatterns.some((pattern) => pattern.includes('*') ? false : path.includes(pattern.replace(/\/$/, '')))
}

export default function codeIntelligenceExtension(pi: ExtensionAPI) {
  const logger = new CodeIntelligenceLogger()
  let runtime: CodeIntelligenceRuntime | undefined
  let currentIdentity: RepoIdentity | undefined
  let postEditReviewTimer: NodeJS.Timeout | undefined
  let lastRetrievedContext: { source: string; at: string; contextPack: ContextPack } | undefined
  let latestReviewOutput: ParsedReviewOutput | undefined

  pi.on('message_end', async (event, ctx) => {
    if ((event.message as { role?: string }).role !== 'assistant') return
    const parsed = parseCodeIntelligenceReviewOutput(extractMessageText(event.message))
    if (!parsed) return
    latestReviewOutput = parsed
    if (ctx.hasUI) ctx.ui.notify(`Code intelligence review ready: ${parsed.findings.length} finding(s). Run /code-intelligence-review-panel to inspect.`, 'info')
  })

  pi.on('session_start', async (_event, ctx) => {
    try {
      currentIdentity = await identifyRepo(ctx.cwd)
      if (!(await isCodeIntelligenceEnabled(currentIdentity.repoKey))) {
        logger.info('disabled for repo; use /enable-code-intelligence to enable', {
          repoKey: currentIdentity.repoKey,
          gitRoot: currentIdentity.gitRoot,
        })
        if (ctx.hasUI) ctx.ui.setStatus('code-intelligence', 'intelligence: disabled')
        return
      }

      runtime = await activateCodeIntelligence(ctx.cwd, logger, currentIdentity)
      setupRecoveryMonitor(() => runtime, logger)
      await recoverInterruptedWork(runtime, logger, 'session_start', true)
      if (ctx.hasUI) {
        ctx.ui.setStatus('code-intelligence', `intelligence: ${runtime.identity.repoKey.slice(0, 8)}`)
        setupProgressWidget(ctx, () => runtime)
      }
    } catch (error) {
      logger.error('activation check failed', { error: (error as Error).message })
      if (ctx.hasUI) {
        ctx.ui.setStatus('code-intelligence', 'intelligence: unavailable')
        ctx.ui.notify(`Code intelligence failed to initialize: ${(error as Error).message}`, 'warning')
      }
    }
  })

  pi.on('session_shutdown', async (_event, ctx) => {
    teardownProgressWidget(ctx)
    teardownRecoveryMonitor()
    await deactivateCodeIntelligence(runtime, logger)
    runtime = undefined
    currentIdentity = undefined
    if (ctx.hasUI) {
      ;(ctx.ui as any).setWidget?.('code-intelligence-progress', undefined)
      ctx.ui.setStatus('code-intelligence', undefined)
    }
  })

  pi.on('input', async (event, ctx) => {
    if (!runtime || event.source === 'extension') return { action: 'continue' }
    const activeRuntime = runtime
    const text = event.text
    void captureCorrectionLearning(activeRuntime, text)
      .then((result) => {
        if (result.kind === 'stored' && result.status === 'active') {
          logger.info('captured code intelligence correction', {
            learningId: result.learning.id,
            title: result.learning.title,
            status: result.status,
          })
        }
      })
      .catch((error) => {
        logger.warn('asynchronous correction capture failed', { error: (error as Error).message })
      })
    return { action: 'continue' }
  })

  pi.on('tool_result', async (event) => {
    if (!runtime) return undefined
    if (event.toolName !== 'edit' && event.toolName !== 'write') return undefined
    if (postEditReviewTimer) clearTimeout(postEditReviewTimer)
    postEditReviewTimer = setTimeout(() => {
      void runPostEditReview(pi, runtime, logger)
    }, 300)
    return undefined
  })

  pi.on('before_agent_start', async (event) => {
    if (!runtime) return undefined
    const contextPack = await retrievePlanningContextPack(runtime, event.prompt)
    const hasContext = Boolean(contextPack && (contextPack.codeContext.length > 0 || contextPack.learnings.length > 0 || contextPack.hardRules.length > 0))
    if (contextPack && hasContext) lastRetrievedContext = { source: 'planning', at: new Date().toISOString(), contextPack }
    return {
      message: {
        customType: 'code-intelligence-context',
        content: [buildLearningCaptureGuidance(), contextPack && hasContext ? formatPlanningContextMessage(contextPack) : undefined].filter(Boolean).join('\n\n'),
        display: false,
        details: contextPack ? {
          freshness: contextPack.freshness,
          hardRules: contextPack.hardRules.map((rule) => ({
            id: rule.id,
            ruleKind: rule.ruleKind,
            pattern: rule.pattern,
            severity: rule.severity,
            reasons: rule.reasons,
          })),
          learnings: contextPack.learnings.map((learning) => ({
            id: learning.id,
            title: learning.title,
            score: learning.score,
            reasons: learning.reasons,
          })),
          retrieved: contextPack.codeContext.map((chunk) => ({
            path: chunk.path,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            score: chunk.score,
            reasons: chunk.reasons,
          })),
        } : { guidance: 'learning_capture' },
      },
    }
  })

  async function ensureRuntimeForCwd(cwd: string, ctx?: any): Promise<{ runtime?: CodeIntelligenceRuntime; warning?: string }> {
    const identity = await identifyRepo(cwd)
    if (runtime?.identity.repoKey === identity.repoKey) return { runtime }

    if (!(await isCodeIntelligenceEnabled(identity.repoKey))) {
      return {
        warning: [
          'Code intelligence is not enabled for the current repo.',
          `currentCwd: ${cwd}`,
          `currentRepoKey: ${identity.repoKey}`,
          runtime ? `activeRepoKey: ${runtime.identity.repoKey}` : undefined,
          'Use /enable-code-intelligence in this project first.',
        ].filter(Boolean).join('\n'),
      }
    }

    teardownRecoveryMonitor()
    teardownProgressWidget(ctx)
    await deactivateCodeIntelligence(runtime, logger)
    runtime = await activateCodeIntelligence(cwd, logger, identity)
    currentIdentity = identity
    setupRecoveryMonitor(() => runtime, logger)
    await recoverInterruptedWork(runtime, logger, 'tool cwd switch', true)
    if (ctx?.hasUI) {
      ctx.ui.setStatus('code-intelligence', `intelligence: ${identity.repoKey.slice(0, 8)}`)
      setupProgressWidget(ctx, () => runtime)
    }
    return { runtime }
  }

  async function runCodeIntelligenceReviewCommand(args: string, ctx: any): Promise<void> {
    const timings: Array<{ label: string; ms: number }> = []
    let lastMark = Date.now()
    const mark = (label: string) => {
      const now = Date.now()
      timings.push({ label, ms: now - lastMark })
      lastMark = now
    }

    if (ctx.hasUI) ctx.ui.setStatus('code-intelligence-review', 'review: waiting for idle')
    await ctx.waitForIdle()
    mark('waitForIdle')

    if (ctx.hasUI) ctx.ui.setStatus('code-intelligence-review', 'review: resolving scope')
    const scope = await resolveSelectedScope(pi, ctx)
    mark('resolve scope')
    if (ctx.hasUI) ctx.ui.setStatus('code-intelligence-review', 'review: loading code intelligence')
    let intelligence: ImproveCodeIntelligenceResult
    try {
      intelligence = await retrieveImproveCodeIntelligence({
        pi,
        ctx,
        scope,
        args: `--review ${args}`,
        onProgress: (message) => {
          if (ctx.hasUI) ctx.ui.setStatus('code-intelligence-review', `review: ${message}`)
        },
      })
      mark('retrieve code intelligence')
    } finally {
      if (ctx.hasUI) ctx.ui.setStatus('code-intelligence-review', undefined)
    }

    if (ctx.hasUI) {
      ctx.ui.notify(scope.summary, 'info')
      if (scope.warning) ctx.ui.notify(scope.warning, 'warning')
      if (intelligence.enabled && intelligence.contextPack) {
        const { codeContext, learnings, hardRules } = intelligence.contextPack
        ctx.ui.notify(`Code intelligence context: ${codeContext.length} code chunk(s), ${learnings.length} learning(s), ${hardRules.length} hard rule(s).`, 'info')
      } else if (intelligence.warning) ctx.ui.notify(intelligence.warning, 'warning')
    }

    const subagentsAvailable = pi.getActiveTools().includes('subagent_run')
    const prompt = subagentsAvailable
      ? buildSubagentCodeIntelligenceReviewPrompt(scope, stripImproveFlags(args) || undefined, intelligence)
      : buildCodeIntelligenceReviewPrompt(scope, stripImproveFlags(args) || undefined, intelligence)
    mark('build prompt')
    logger.info('code intelligence review command prepared', {
      timings,
      workflow: subagentsAvailable ? 'subagent_orchestrated' : 'direct',
      promptChars: prompt.length,
      codeChunks: intelligence.contextPack?.codeContext.length ?? 0,
      learnings: intelligence.contextPack?.learnings.length ?? 0,
      hardRules: intelligence.contextPack?.hardRules.length ?? 0,
      graphFiles: intelligence.graphContext?.length ?? 0,
      reviewPackets: intelligence.reviewPackets?.length ?? 0,
    })
    if (ctx.hasUI) {
      ctx.ui.notify(
        subagentsAvailable
          ? `Review orchestration ready: ${intelligence.reviewPackets?.length ?? 0} packet(s). Subagents will fan out by file/cluster.`
          : `Review prompt ready: ${Math.round(prompt.length / 1000)}k chars. Model response may take a while.`,
        'info'
      )
    }
    pi.sendUserMessage(prompt)
  }

  async function openCodeIntelligenceReviewPanel(ctx: any): Promise<void> {
    if (!latestReviewOutput) {
      if (ctx.hasUI) ctx.ui.notify('No structured code intelligence review output found in this session yet.', 'warning')
      else console.log('No structured code intelligence review output found in this session yet.')
      return
    }
    const panel = formatCodeIntelligenceReviewPanel(latestReviewOutput)
    if (!ctx.hasUI) {
      console.log(panel)
      return
    }
    await ctx.ui.editor('Code intelligence review findings', panel)
    if (latestReviewOutput.findings.length === 0) return
    const selections: Array<{ finding: ParsedReviewFinding; action: ReviewPanelAction }> = []
    for (const finding of latestReviewOutput.findings) {
      const title = `${finding.id}: ${finding.title ?? finding.file ?? '(untitled)'}`
      const choice = await ctx.ui.select(title, [
        'Skip',
        'Queue fix + mark useful',
        'Mark useful',
        'Mark false positive',
        'Needs changes',
      ])
      const action: ReviewPanelAction = choice === 'Queue fix + mark useful'
        ? 'fix'
        : choice === 'Mark useful'
          ? 'accepted'
          : choice === 'Mark false positive'
            ? 'false_positive'
            : choice === 'Needs changes'
              ? 'needs_changes'
              : 'skip'
      selections.push({ finding, action })
    }
    const selected = selections.filter((item) => item.action !== 'skip')
    if (selected.length === 0) {
      ctx.ui.notify('No review actions selected.', 'info')
      return
    }
    const proceed = await ctx.ui.confirm('Submit review actions?', `${selected.length} action(s) selected. Fix actions will also be marked useful in code intelligence feedback.`)
    if (!proceed) return
    pi.sendUserMessage(buildReviewBatchActionPrompt(selections))
    ctx.ui.notify(`Queued ${selected.length} review action(s).`, 'info')
  }

  pi.registerCommand('plan', {
    description: 'Interview, research, and produce a stress-tested implementation prompt without editing files.',
    handler: async (args, ctx) => {
      await ctx.waitForIdle()
      const task = args.trim()
      let contextPack
      let warning
      try {
        const resolvedRuntime = await ensureRuntimeForCwd(ctx.cwd, ctx)
        if (resolvedRuntime.runtime && task) {
          contextPack = await retrievePlanningContextPack(resolvedRuntime.runtime, task)
        } else {
          warning = resolvedRuntime.warning
        }
      } catch (error) {
        warning = error instanceof Error ? error.message : String(error)
      }
      const prompt = buildPlanCommandPrompt({ task, contextPack, warning })
      if (ctx.hasUI) ctx.ui.notify('Plan mode queued. The agent will research, interview, and produce an implementation prompt.', 'info')
      pi.sendUserMessage(prompt)
    },
  })

  pi.registerCommand('code-intelligence-review', {
    description: 'Run a graph-aware code intelligence review of current git changes and queue a structured review report.',
    handler: runCodeIntelligenceReviewCommand,
  })

  pi.registerCommand('code-intelligence-review-panel', {
    description: 'Open the latest structured code intelligence review output and optionally queue a selected finding action.',
    handler: async (_args, ctx) => openCodeIntelligenceReviewPanel(ctx),
  })

  pi.registerCommand('code-intelligence-tests', {
    description: 'Report likely missing tests/counterparts for current git changes using code-intelligence graph data.',
    handler: async (_args, ctx) => {
      await ctx.waitForIdle()
      const resolvedRuntime = await ensureRuntimeForCwd(ctx.cwd, ctx)
      if (!resolvedRuntime.runtime) {
        const message = resolvedRuntime.warning ?? 'Code intelligence is not active for this session. Use /enable-code-intelligence first.'
        if (ctx.hasUI) ctx.ui.notify(message, 'warning')
        else console.log(message)
        return
      }
      const scope = await resolveSelectedScope(pi, ctx)
      const changedFiles = await resolveImproveChangedFiles(pi, ctx, scope)
      const paths = changedFiles.length > 0 ? changedFiles : selectWholeRepoReviewFiles(resolvedRuntime.runtime.db, resolvedRuntime.runtime.identity.repoKey, '')
      const impact = retrieveImpactContextForDiff(resolvedRuntime.runtime.db, resolvedRuntime.runtime.identity.repoKey, paths, { maxFiles: Math.max(16, paths.length), maxItemsPerSection: 8, maxRelatedFiles: Math.max(100, paths.length * 2) })
      const report = formatMissingTestsReport(paths, impact, resolvedRuntime.runtime.config.testPaths)
      if (ctx.hasUI) await ctx.ui.editor('Code intelligence missing tests', report)
      else console.log(report)
    },
  })

  pi.registerTool<typeof recordLearningSchema>({
    name: 'code_intelligence_record_learning',
    label: 'Code Intelligence Record Learning',
    description: 'Record durable repo guidance, conventions, preferences, or corrections as a codebase learning.',
    promptSnippet: 'Record reusable codebase guidance when the user gives durable repo conventions or corrections.',
    promptGuidelines: [
      'Use code_intelligence_record_learning when the user gives durable repo guidance, preferences, corrections, or conventions that should apply to future work.',
      'Do not use code_intelligence_record_learning for ordinary one-off task requirements.',
      'Use code_intelligence_record_learning with status draft when the guidance is plausible but ambiguous, and active only when the user states it clearly.',
      'Use code_intelligence_record_learning examples sparingly; prefer concise title, summary, appliesWhen, avoid, and prefer fields.',
    ],
    parameters: recordLearningSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const targetCwd = ctx.cwd
      const resolvedRuntime = await ensureRuntimeForCwd(targetCwd, ctx)
      if (!resolvedRuntime.runtime) {
        return {
          content: [{ type: 'text', text: resolvedRuntime.warning ?? 'Code intelligence is not active for this session. Use /enable-code-intelligence first.' }],
          details: { active: false, error: 'inactive_or_wrong_repo' },
        }
      }
      const input = params as {
        title: string
        summary: string
        ruleType: string
        appliesWhen: string
        avoid?: string
        prefer?: string
        pathGlobs?: string[]
        languages?: string[]
        confidence?: number
        priority?: number
        status?: string
      }
      const confidence = clampNumber(input.confidence, 0.75, 0, 1)
      const candidate = scopeLearningCandidate({
        title: input.title.trim(),
        summary: input.summary.trim(),
        ruleType: normalizeLearningRuleType(input.ruleType),
        appliesWhen: input.appliesWhen.trim(),
        avoid: input.avoid?.trim() || undefined,
        prefer: input.prefer?.trim() || undefined,
        pathGlobs: input.pathGlobs?.filter((item) => item.trim().length > 0),
        languages: input.languages?.filter((item) => item.trim().length > 0),
        confidence,
        priority: clampNumber(input.priority, 60, 0, 100),
        status: normalizeLearningStatus(input.status, confidence),
        source: { kind: 'manual_note', timestamp: new Date().toISOString() },
      }, { text: [input.title, input.summary, input.appliesWhen, input.avoid, input.prefer, ...(input.pathGlobs ?? [])].filter(Boolean).join('\n'), config: resolvedRuntime.runtime.config })
      const embeddingService = resolvedRuntime.runtime.services.get<EmbeddingService>('embeddingService')
      const { learning, reused } = await createOrReuseLearning(resolvedRuntime.runtime, candidate, embeddingService)
      const eventId = appendLearningEvent(resolvedRuntime.runtime.db, {
        repoKey: resolvedRuntime.runtime.identity.repoKey,
        learningId: learning.id,
        eventKind: 'manual_learning',
        payload: { source: 'code_intelligence_record_learning', reused, title: learning.title, status: learning.status },
      })
      return {
        content: [{ type: 'text', text: `${reused ? 'Reused' : 'Recorded'} learning ${learning.id}: ${learning.title}` }],
        details: { active: true, eventId, reused, learning },
      }
    },
  })

  pi.registerTool<typeof reviewFeedbackSchema>({
    name: 'code_intelligence_review_feedback',
    label: 'Code Intelligence Review Feedback',
    description: 'Record feedback on a code intelligence review finding and optionally turn durable corrections into scoped codebase learnings.',
    promptSnippet: 'Record accepted/rejected/false-positive feedback on code intelligence review findings so future reviews can learn from it.',
    promptGuidelines: [
      'Use code_intelligence_review_feedback when the user confirms a review finding was useful, wrong, or needs a durable correction.',
      'Use code_intelligence_review_feedback with action accepted and correction text when the feedback should become a future codebase learning.',
      'Use code_intelligence_review_feedback with false_positive or rejected when a review finding should be remembered as unhelpful evidence.',
    ],
    parameters: reviewFeedbackSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const targetCwd = ctx.cwd
      const resolvedRuntime = await ensureRuntimeForCwd(targetCwd, ctx)
      if (!resolvedRuntime.runtime) {
        return {
          content: [{ type: 'text', text: resolvedRuntime.warning ?? 'Code intelligence is not active for this session. Use /enable-code-intelligence first.' }],
          details: { active: false, error: 'inactive_or_wrong_repo' },
        }
      }
      const activeRuntime = resolvedRuntime.runtime
      const input = params as { findingId: string; action: string; title?: string; evidence?: string; correction?: string; pathGlobs?: string[] }
      const action = normalizeReviewFeedbackAction(input.action)
      const eventId = appendLearningEvent(activeRuntime.db, {
        repoKey: activeRuntime.identity.repoKey,
        eventKind: 'review_feedback',
        payload: {
          findingId: input.findingId,
          action,
          title: input.title,
          evidence: input.evidence,
          correction: input.correction,
          pathGlobs: input.pathGlobs,
        },
      })

      const shouldLearn = action === 'accepted' || action === 'needs_changes'
      let candidate = shouldLearn && input.correction ? buildLearningCandidateFromReviewFeedback(input, action, eventId) : undefined
      if (candidate && input.correction) {
        const rewritten = await rewriteLearningCandidateWithModel(ctx, input.correction, candidate).catch(() => undefined)
        if (rewritten) {
          candidate = {
            ...rewritten,
            pathGlobs: input.pathGlobs && input.pathGlobs.length > 0 ? input.pathGlobs : rewritten.pathGlobs,
            source: candidate.source,
            status: action === 'accepted' && rewritten.confidence >= 0.85 ? 'active' : action === 'accepted' ? candidate.status : 'draft',
          }
        }
      }
      const embeddingService = activeRuntime.services.get<EmbeddingService>('embeddingService')
      const learning = candidate ? (await createOrReuseLearning(activeRuntime, candidate, embeddingService)).learning : undefined

      const text = learning
        ? `Recorded review feedback ${eventId} and created learning ${learning.id}: ${learning.title}`
        : `Recorded review feedback ${eventId}.`
      return {
        content: [{ type: 'text', text }],
        details: { active: true, eventId, action, learning },
      }
    },
  })

  pi.registerTool<typeof codeIntelligenceImpactSchema>({
    name: 'code_intelligence_impact',
    label: 'Code Intelligence Impact',
    description: 'Return graph impact context for files, including imports, imported-by files, callers/callees, tests/counterparts, routes/screens, and similar patterns.',
    promptSnippet: 'Retrieve code-intelligence impact context for specific files before editing or reviewing risky changes.',
    promptGuidelines: [
      'Use code_intelligence_impact when you need to understand what a file affects or what depends on it.',
      'Use code_intelligence_impact before editing exported APIs, shared components, routes, schemas, hooks, or files with unclear test coverage.',
      'Use code_intelligence_impact results to identify likely tests/counterparts and caller/callee files to inspect.',
    ],
    parameters: codeIntelligenceImpactSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = params as { paths: string[]; repoPath?: string; maxFiles?: number; maxItemsPerSection?: number }
      const targetCwd = input.repoPath ? resolve(ctx.cwd, input.repoPath) : ctx.cwd
      const resolvedRuntime = await ensureRuntimeForCwd(targetCwd, ctx)
      if (!resolvedRuntime.runtime) {
        return {
          content: [{ type: 'text', text: resolvedRuntime.warning ?? 'Code intelligence is not active for this session. Use /enable-code-intelligence first.' }],
          details: { active: false, error: 'inactive_or_wrong_repo' },
        }
      }
      const paths = uniqueStrings(input.paths ?? [])
      if (paths.length === 0) {
        return { content: [{ type: 'text', text: 'code_intelligence_impact requires at least one path.' }], details: { active: true, error: 'empty_paths' } }
      }
      const maxFiles = clampPositiveInteger(input.maxFiles, 16, 50)
      const maxItemsPerSection = clampPositiveInteger(input.maxItemsPerSection, 8, 25)
      const impact = retrieveImpactContextForDiff(resolvedRuntime.runtime.db, resolvedRuntime.runtime.identity.repoKey, paths, { maxFiles, maxItemsPerSection, maxRelatedFiles: maxFiles * 2 })
      return {
        content: [{ type: 'text', text: formatImpactContext(impact) }],
        details: { active: true, impact },
      }
    },
  })

  pi.registerTool<typeof codeIntelligenceSearchSchema, CodeIntelligenceSearchDetails>({
    name: 'code_intelligence_search',
    label: 'Code Intelligence Search',
    description:
      'Search the local code-intelligence index with hybrid lexical/semantic retrieval and return relevant code chunks, learnings, hard rules, and freshness warnings.',
    promptSnippet:
      'Search local code intelligence for relevant code chunks, repo learnings, and hard rules. Use it before broad grep/read exploration on non-trivial code tasks, especially when the relevant files or patterns are not already known.',
    promptGuidelines: [
      'Use code_intelligence_search early for non-trivial codebase discovery unless the relevant files and functions are already known.',
      'Use code_intelligence_search before broad exploratory grep/read passes for questions about existing patterns, architecture, related tests, or where behavior is implemented.',
      'Prefer code_intelligence_search over rg when the query is conceptual or semantic; use rg afterward for exact symbol/string confirmation.',
      'Use code_intelligence_search with currentFiles or changedFiles when working near specific files so retrieval can prioritize nearby code and source/test counterparts.',
      'Use code_intelligence_search results silently as context; do not dump raw retrieved chunks unless the user asks for evidence or file references.',
      'Use code_intelligence_search freshness warnings to decide whether to verify results with read, rg, or tests before editing.',
    ],
    parameters: codeIntelligenceSearchSchema,
    renderCall(args, theme) {
      const input = args as { query?: string; repoPath?: string; currentFiles?: string[]; changedFiles?: string[]; format?: string }
      const scopeFiles = uniqueStrings([...(input.currentFiles ?? []), ...(input.changedFiles ?? [])])
      const suffix = [
        input.query ? `query: ${input.query}` : 'empty query',
        input.repoPath ? `repo: ${input.repoPath}` : undefined,
        scopeFiles.length > 0 ? `files: ${scopeFiles.slice(0, 3).join(', ')}${scopeFiles.length > 3 ? ', …' : ''}` : undefined,
        input.format && input.format !== 'compact' ? `format: ${input.format}` : undefined,
      ].filter(Boolean).join(' • ')
      return {
        render(width: number) {
          return [truncateToWidth(theme.fg('toolTitle', theme.bold('code_intelligence_search ')) + theme.fg('muted', suffix), width)]
        },
        invalidate() {},
      }
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const rawInput = params as { repoPath?: string }
      const targetCwd = rawInput.repoPath ? resolve(ctx.cwd, rawInput.repoPath) : ctx.cwd
      const resolvedRuntime = await ensureRuntimeForCwd(targetCwd, ctx)
      if (!resolvedRuntime.runtime) {
        return {
          content: [{ type: 'text', text: resolvedRuntime.warning ?? 'Code intelligence is not active for this session. Use /enable-code-intelligence first.' }],
          details: { active: false, error: 'inactive_or_wrong_repo' },
        }
      }
      const activeRuntime = resolvedRuntime.runtime

      const input = params as {
        query: string
        repoPath?: string
        currentFiles?: string[]
        visibleFiles?: string[]
        changedFiles?: string[]
        maxCodeChunks?: number
        maxLearnings?: number
        maxChunkChars?: number
        maxTotalContextChars?: number
        format?: string
        includeRawCode?: boolean
        mode?: string
      }
      const query = input.query.trim()
      if (!query) {
        return {
          content: [{ type: 'text', text: 'code_intelligence_search requires a non-empty query.' }],
          details: { active: true, error: 'empty_query' },
        }
      }

      const currentFiles = uniqueStrings(input.currentFiles ?? [])
      const visibleFiles = uniqueStrings(input.visibleFiles ?? [])
      const changedFiles = uniqueStrings(input.changedFiles ?? [])
      const counterpartFiles = findSourceTestCounterparts([...currentFiles, ...visibleFiles, ...changedFiles], activeRuntime.config)
      const packageKey = [...currentFiles, ...visibleFiles, ...changedFiles]
        .map((path) => packageKeyForPath(path, activeRuntime.config))
        .find(Boolean)
      const embeddingService = activeRuntime.services.get<EmbeddingService>('embeddingService')
      const maxCodeChunks = clampPositiveInteger(input.maxCodeChunks, activeRuntime.config.maxCodeChunks, 30)
      const maxLearnings = clampPositiveInteger(input.maxLearnings, activeRuntime.config.maxLearnings, 20)
      const maxChunkChars = clampPositiveInteger(input.maxChunkChars, activeRuntime.config.maxChunkChars, 12_000)
      const maxTotalContextChars = clampPositiveInteger(input.maxTotalContextChars, activeRuntime.config.maxTotalContextChars, 80_000)

      const retrievalMode = normalizeSearchMode(input.mode)
      const codeContext = retrievalMode === 'graph' ? [] : await retrieveCodeHybrid(activeRuntime.db, embeddingService, {
        repoKey: activeRuntime.identity.repoKey,
        query,
        currentFiles,
        visibleFiles: [...new Set([...visibleFiles, ...counterpartFiles])],
        changedFiles,
        sourceTestCounterpartFiles: counterpartFiles,
        packageKey,
        maxCodeChunks,
      })
      const learnings = retrievalMode === 'graph' ? [] : await retrieveLearningsHybrid(activeRuntime.db, embeddingService, {
        repoKey: activeRuntime.identity.repoKey,
        query,
        packageKey,
        maxLearnings,
      })
      const contextPack = buildContextPack({
        db: activeRuntime.db,
        repoKey: activeRuntime.identity.repoKey,
        codeContext,
        learnings,
        hardRules: retrieveHardRules(activeRuntime.db, activeRuntime.identity.repoKey),
        indexRunning: activeRuntime.indexScheduler.getStatus().running,
        pendingFiles: activeRuntime.fileWatcher.getStatus().pendingChanged + activeRuntime.fileWatcher.getStatus().pendingDeleted,
        maxChunkChars,
        maxTotalContextChars,
      })

      lastRetrievedContext = { source: 'tool', at: new Date().toISOString(), contextPack }
      const fullFormat = input.format === 'full'
      const includeRawCode = input.includeRawCode ?? fullFormat
      const stats = getRetrievalStats(contextPack)
      const graphSeedPaths = selectGraphSummaryPaths(contextPack, input)
      const graph = retrievalMode === 'graph'
        ? retrieveGraphContextForQuery(resolvedRuntime.runtime.db, resolvedRuntime.runtime.identity.repoKey, query, graphSeedPaths, { maxFiles: 10, maxItemsPerSection: 8 })
        : retrieveGraphContextForFiles(resolvedRuntime.runtime.db, resolvedRuntime.runtime.identity.repoKey, graphSeedPaths, { maxFiles: 10, maxItemsPerSection: 8 })
      const graphEdges = fullFormat || retrievalMode === 'graph'
        ? retrieveGraphEdgeDetailsForFiles(resolvedRuntime.runtime.db, resolvedRuntime.runtime.identity.repoKey, graph.length > 0 ? graph.map((summary) => summary.path) : graphSeedPaths, { maxFiles: 10, maxEdgesPerFile: 40 })
        : []
      return {
        content: [{ type: 'text', text: fullFormat ? appendGraphSummary(contextPack.promptText, graph, graphEdges) : formatCompactSearchOutput(contextPack, { includeRawCode, graph, graphEdges }) }],
        details: {
          active: true,
          freshness: contextPack.freshness,
          warnings: contextPack.warnings,
          stats: { ...stats, mode: retrievalMode },
          retrieved: contextPack.codeContext.map((chunk) => ({
            path: chunk.path,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            score: chunk.score,
            reasons: chunk.reasons,
            symbolName: chunk.symbolName,
          })),
          learnings: contextPack.learnings.map((learning) => ({
            id: learning.id,
            title: learning.title,
            score: learning.score,
            reasons: learning.reasons,
          })),
          hardRules: contextPack.hardRules.map((rule) => ({
            id: rule.id,
            ruleKind: rule.ruleKind,
            pattern: rule.pattern,
            severity: rule.severity,
            reasons: rule.reasons,
          })),
          graph,
          graphEdges,
        },
      }
    },
  })

  pi.registerCommand('code-intelligence-doctor', {
    description: 'Check and create code intelligence local data directories, SQLite databases, model cache directory, and runtime dependencies.',
    handler: async (_args, ctx) => {
      const status = await ensureCodeIntelligenceInstall(logger)
      const message = formatInstallStatus(status)
      if (ctx.hasUI) ctx.ui.notify(message, status.checks.every((check) => check.ok) ? 'info' : 'warning')
      else console.log(message)
    },
  })

  pi.registerCommand('enable-code-intelligence', {
    description: 'Enable local code intelligence for the current repo/directory, then activate it for this session.',
    handler: async (args, ctx) => {
      const target = resolveTarget(ctx.cwd, args)
      const identity = await identifyRepo(target)
      await enableCodeIntelligenceRepo(identity)

      if (currentIdentity?.repoKey === identity.repoKey || resolve(ctx.cwd) === target) {
        teardownRecoveryMonitor()
        await deactivateCodeIntelligence(runtime, logger)
        runtime = await activateCodeIntelligence(target, logger, identity)
        setupRecoveryMonitor(() => runtime, logger)
        await recoverInterruptedWork(runtime, logger, 'enable command', true)
        currentIdentity = identity
        if (ctx.hasUI) {
          ctx.ui.setStatus('code-intelligence', `intelligence: ${identity.repoKey.slice(0, 8)}`)
          setupProgressWidget(ctx, () => runtime)
        }
      }

      const status = runtime?.identity.repoKey === identity.repoKey ? runtime.indexScheduler.getStatus() : undefined
      ctx.ui.notify(
        [
          'Code intelligence enabled.',
          `repoKey: ${identity.repoKey}`,
          `gitRoot: ${identity.gitRoot}`,
          `storageDir: ${resolveRepoStorageDir(identity.repoKey)}`,
          status ? `indexing: ${status.running ? 'running' : 'queued'} (${status.queuedJobs} queued job(s))` : 'indexing: will start when this repo session activates',
          'Progress: see the code-intelligence status/widget, or run /code-intelligence-dashboard.',
        ].join('\n'),
        'info'
      )
    },
  })

  pi.registerCommand('disable-code-intelligence', {
    description: 'Disable local code intelligence for the current repo/directory without deleting stored data.',
    handler: async (args, ctx) => {
      const target = resolveTarget(ctx.cwd, args)
      const identity = await identifyRepo(target)
      const changed = await disableCodeIntelligenceRepo(identity.repoKey)

      if (runtime?.identity.repoKey === identity.repoKey) {
        teardownProgressWidget(ctx)
        teardownRecoveryMonitor()
        await deactivateCodeIntelligence(runtime, logger)
        runtime = undefined
        if (ctx.hasUI) {
          ;(ctx.ui as any).setWidget?.('code-intelligence-progress', undefined)
          ctx.ui.setStatus('code-intelligence', 'intelligence: disabled')
        }
      }
      if (currentIdentity?.repoKey === identity.repoKey) currentIdentity = identity

      ctx.ui.notify(
        changed
          ? `Code intelligence disabled for ${identity.repoKey}. Stored data was left intact.`
          : `Code intelligence was already disabled for ${identity.repoKey}.`,
        'info'
      )
    },
  })













  pi.registerCommand('reindex-code-intelligence', {
    description: 'Wipe and rebuild the code intelligence code index and embeddings for the current repo.',
    handler: async (_args, ctx) => {
      if (!runtime) {
        ctx.ui.notify('Code intelligence is not active. Use /enable-code-intelligence first.', 'warning')
        return
      }
      await runtime.indexScheduler.cancelActiveWorker()
      const resetIndex = resetCodeIndex(runtime.db, runtime.identity.repoKey)
      const resetEmbedding = resetEmbeddings(runtime.db, runtime.identity.repoKey)
      runtime.indexScheduler.enqueueFullRepoIndex('manual wipe-and-reindex command')
      await recoverInterruptedWork(runtime, logger, 'manual reindex', true)
      ctx.ui.notify(
        [
          'Wiped and queued code intelligence rebuild.',
          `deletedFiles: ${resetIndex.deletedFiles}`,
          `deletedChunks: ${resetIndex.deletedChunks}`,
          `deletedChunkEmbeddings: ${resetEmbedding.deletedChunkEmbeddings}`,
          `deletedLearningEmbeddings: ${resetEmbedding.deletedLearningEmbeddings}`,
          `deletedEntities: ${resetIndex.deletedEntities}`,
          `deletedRelationships: ${resetIndex.deletedCodeRelationships + resetIndex.deletedFileRelationships}`,
        ].join('\n'),
        'info'
      )
    },
  })



  pi.registerCommand('code-intelligence-debug', {
    description: 'Show bounded code intelligence indexing progress and graph debug metadata.',
    handler: async (_args, ctx) => {
      if (!runtime) {
        ctx.ui.notify('Code intelligence is not active. Use /enable-code-intelligence first.', 'warning')
        return
      }
      const indexingState = getIndexingState(runtime.db)
      const embeddingStats = getEmbeddingStats(runtime.db, runtime.identity.repoKey)
      const entityStats = getEntityStats(runtime.db, runtime.identity.repoKey)
      const relationshipStats = getRelationshipStats(runtime.db, runtime.identity.repoKey)
      const fileRelationshipStats = getFileRelationshipStats(runtime.db, runtime.identity.repoKey)
      const indexStatus = runtime.indexScheduler.getStatus()
      ctx.ui.notify(
        [
          'Code intelligence debug:',
          `phase: ${indexingState?.progress_phase ?? '(none)'}`,
          `currentFile: ${indexingState?.progress_current_path ?? '(none)'}`,
          `recentFiles: ${(indexingState?.progress_recent_paths ?? []).slice(0, 5).join(', ') || '(none)'}`,
          `filesScanned: ${indexingState?.progress_files_scanned ?? 0}`,
          `entitiesExtracted: ${indexingState?.progress_entities_extracted ?? 0}`,
          `relationshipsExtracted: ${indexingState?.progress_relationships_extracted ?? 0}`,
          `embeddingsMissing: ${embeddingStats.missingEmbeddings}`,
          `workerPid: ${indexStatus.workerPid ?? '(none)'}`,
          `graphEntities: ${entityStats.totalEntities}`,
          `relationshipCountsByKind: ${formatCounts({ ...relationshipStats.byKind, ...prefixFileRelationshipCounts(fileRelationshipStats.byKind) })}`,
          `reviewConfigFiles: ${runtime.config.review.status.filesLoaded.join(', ') || '(none)'}`,
          `reviewScopedRules: ${runtime.config.review.rules.length}`,
          `reviewConfigErrors: ${runtime.config.review.status.errors.join(' | ') || '(none)'}`,
          'largeSlowSkippedFiles: (scanner summary/logs only in this slice)',
        ].join('\n'),
        'info'
      )
    },
  })

  pi.registerCommand('code-intelligence-learnings', {
    description: 'Open a table view for code intelligence learnings and manage active/draft/rejected rules.',
    handler: async (args, ctx) => {
      const resolvedRuntime = await ensureRuntimeForCwd(ctx.cwd, ctx)
      if (!resolvedRuntime.runtime) {
        const message = resolvedRuntime.warning ?? 'Code intelligence is not active for this session. Use /enable-code-intelligence first.'
        if (ctx.hasUI) ctx.ui.notify(message, 'warning')
        else console.log(message)
        return
      }
      const activeRuntime = resolvedRuntime.runtime
      const filter = parseLearningStatusFilter(args)
      let learnings = listLearnings(activeRuntime.db, activeRuntime.identity.repoKey, filter)
      const renderTable = () => formatLearningsTable(learnings, filter)
      if (!ctx.hasUI) {
        console.log(renderTable())
        return
      }

      while (true) {
        await ctx.ui.editor('Code intelligence learnings', renderTable())
        learnings = listLearnings(activeRuntime.db, activeRuntime.identity.repoKey, filter)
        if (learnings.length === 0) return
        const selectedTitle = await ctx.ui.select('Manage code intelligence learning', [
          'Close',
          ...learnings.map((learning, index) => `${index + 1}. [${learning.status}] ${learning.title} (${learning.confidence.toFixed(2)})`),
        ])
        if (!selectedTitle || selectedTitle === 'Close') return
        const selectedIndex = Number(/^\d+/.exec(selectedTitle)?.[0] ?? '0') - 1
        const learning = learnings[selectedIndex]
        if (!learning) continue
        const action = await ctx.ui.select(`Learning: ${learning.title}`, [
          'Back',
          'View details',
          learning.status === 'active' ? 'Demote to draft' : 'Activate',
          'Reject / forget',
        ])
        if (action === 'Back') continue
        if (action === 'View details') {
          await ctx.ui.editor('Code intelligence learning details', formatLearningDetails(learning))
          continue
        }
        if (action === 'Activate') {
          updateLearningStatus(activeRuntime.db, learning.id, 'active')
          ctx.ui.notify(`Activated learning: ${learning.title}`, 'info')
        } else if (action === 'Demote to draft') {
          updateLearningStatus(activeRuntime.db, learning.id, 'draft')
          ctx.ui.notify(`Moved learning to draft: ${learning.title}`, 'info')
        } else if (action === 'Reject / forget') {
          const confirmed = await ctx.ui.confirm('Reject learning?', `Reject and disable derived rules for: ${learning.title}`)
          if (confirmed) {
            forgetLearning(activeRuntime.db, learning.id)
            ctx.ui.notify(`Rejected learning: ${learning.title}`, 'info')
          }
        }
        learnings = listLearnings(activeRuntime.db, activeRuntime.identity.repoKey, filter)
      }
    },
  })

  pi.registerCommand('code-intelligence-dashboard', {
    description: 'Open a rich Pi TUI dashboard for code intelligence status and per-project metrics.',
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify('The code intelligence dashboard requires interactive Pi UI.', 'warning')
        return
      }
      const enabledRepos = await listEnabledRepoRecords()
      await (ctx.ui as any).custom((_tui: { requestRender(): void }, theme: any, _keybindings: any, done: (value?: void) => void) => {
        if (progressUiState.progressTimer) progressUiState.progressTimer.dashboardTui = _tui
        const component = new CodeIntelligenceDashboardComponent(runtime, enabledRepos, () => {
          if (progressUiState.progressTimer?.dashboardTui === _tui) progressUiState.progressTimer.dashboardTui = undefined
          done(undefined)
        }, theme)
        return {
          render: (width: number) => component.render(width),
          invalidate: () => component.invalidate(),
          handleInput: (data: string) => {
            component.handleInput(data)
            component.invalidate()
            _tui.requestRender()
          },
        }
      }, { overlay: true, overlayOptions: { anchor: 'top-left', width: '80%', maxHeight: '90%', margin: 1 } })
    },
  })

}

function resolveTarget(cwd: string, args: string): string {
  const trimmed = args.trim()
  return trimmed ? resolve(cwd, trimmed) : cwd
}

function parseLearningStatusFilter(args: string): LearningStatus | undefined {
  const normalized = args.trim().toLowerCase()
  return normalized === 'active' || normalized === 'draft' || normalized === 'rejected' || normalized === 'superseded' ? normalized : undefined
}

function formatLearningsTable(learnings: CodebaseLearning[], filter?: LearningStatus): string {
  const counts = learnings.reduce<Record<string, number>>((acc, learning) => {
    acc[learning.status] = (acc[learning.status] ?? 0) + 1
    return acc
  }, {})
  const lines = [
    '# Code Intelligence Learnings',
    '',
    `Filter: ${filter ?? 'all'}    Total: ${learnings.length}    ${formatCounts(counts)}`,
    '',
    '| # | Status | Confidence | Priority | Type | Scope | Title |',
    '| ---: | --- | ---: | ---: | --- | --- | --- |',
  ]
  learnings.forEach((learning, index) => {
    lines.push(`| ${index + 1} | ${learning.status} | ${learning.confidence.toFixed(2)} | ${learning.priority} | ${learning.ruleType} | ${escapeMarkdownTable((learning.pathGlobs ?? [learning.packageKey ?? 'repo']).join(', '))} | ${escapeMarkdownTable(learning.title)} |`)
  })
  if (learnings.length === 0) lines.push('', '_No learnings found._')
  lines.push('', 'Manage actions: select a row after closing this preview to view details, activate/demote, or reject/forget.')
  return lines.join('\n')
}

function formatLearningDetails(learning: CodebaseLearning): string {
  return [
    `# ${learning.title}`,
    '',
    `- ID: ${learning.id}`,
    `- Status: ${learning.status}`,
    `- Type: ${learning.ruleType}`,
    `- Confidence: ${learning.confidence.toFixed(2)}`,
    `- Priority: ${learning.priority}`,
    `- Package: ${learning.packageKey ?? '(repo-wide)'}`,
    `- Paths: ${(learning.pathGlobs ?? []).join(', ') || '(repo-wide)'}`,
    `- Languages: ${(learning.languages ?? []).join(', ') || '(any)'}`,
    `- Source: ${learning.source.kind}${learning.source.ref ? ` · ${learning.source.ref}` : ''}`,
    `- Created: ${learning.createdAt ?? '(unknown)'}`,
    `- Updated: ${learning.updatedAt ?? '(unknown)'}`,
    `- Last used: ${learning.lastUsedAt ?? '(never)'}`,
    '',
    '## Summary',
    learning.summary,
    '',
    '## Applies when',
    learning.appliesWhen,
    learning.avoid ? `\n## Avoid\n${learning.avoid}` : '',
    learning.prefer ? `\n## Prefer\n${learning.prefer}` : '',
  ].filter(Boolean).join('\n')
}

function escapeMarkdownTable(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function normalizeSearchMode(mode: string | undefined): 'hybrid' | 'semantic' | 'graph' {
  return mode === 'semantic' || mode === 'graph' ? mode : 'hybrid'
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return entries.length > 0 ? entries.map(([kind, count]) => `${kind}=${count}`).join(', ') : '(none)'
}

function prefixFileRelationshipCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).map(([kind, count]) => [`file:${kind}`, count]))
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function clampPositiveInteger(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback
  return Math.min(max, Math.max(1, Math.floor(value)))
}

function setupProgressWidget(ctx: any, getRuntime: () => CodeIntelligenceRuntime | undefined): void {
  teardownProgressWidget(ctx)
  if (!ctx.hasUI) return

  registerStatusCard(CODE_INTELLIGENCE_CARD_ID, 200, () => syncProgressOverlay())

  const widget = new CodeIntelligenceProgressWidget(
    getRuntime,
    () => progressUiState.progressOverlayTheme,
    (layout) => updateStatusCardLayout(CODE_INTELLIGENCE_CARD_ID, layout)
  )
  const refresh = () => {
    widget.invalidate()
    updateProgressStatus(ctx, getRuntime())
    progressUiState.progressOverlayTui?.requestRender()
    progressUiState.progressTimer?.dashboardTui?.requestRender()
  }
  const timer = setInterval(refresh, 1000)
  progressUiState.progressTimer = { timer, widget }
  ensureProgressOverlay(ctx)
  refresh()
}

function teardownProgressWidget(_ctx?: any): void {
  if (progressUiState.progressTimer) clearInterval(progressUiState.progressTimer.timer)
  progressUiState.progressTimer = undefined
  progressUiState.progressOverlayHandle?.hide()
  progressUiState.progressOverlayHandle = undefined
  progressUiState.progressOverlayTui = undefined
  progressUiState.progressOverlayTheme = undefined
  progressUiState.progressOverlayTop = undefined
  progressUiState.progressOverlayInitializing = false
  updateStatusCardLayout(CODE_INTELLIGENCE_CARD_ID, { visible: false, height: 0 })
  unregisterStatusCard(CODE_INTELLIGENCE_CARD_ID)
}

function ensureProgressOverlay(ctx: any): void {
  if (!ctx.hasUI || progressUiState.progressOverlayTui || progressUiState.progressOverlayInitializing) return
  progressUiState.progressOverlayInitializing = true
  void (ctx.ui.custom as <T>(factory: (...args: any[]) => unknown, options?: unknown) => Promise<T>)<void>((tui: any, theme: any, _keybindings: any, done: (value?: void) => void) => {
    if (typeof tui?.showOverlay !== 'function') {
      progressUiState.progressOverlayInitializing = false
      queueMicrotask(() => done(undefined))
      return new EmptyComponent()
    }

    progressUiState.progressOverlayTui = tui
    progressUiState.progressOverlayTheme = theme
    progressUiState.progressOverlayInitializing = false
    syncProgressOverlay()
    queueMicrotask(() => done(undefined))
    return new EmptyComponent()
  })
}

function syncProgressOverlay(): void {
  if (!progressUiState.progressOverlayTui || !progressUiState.progressTimer?.widget) return
  const nextTop = getStatusCardTop(CODE_INTELLIGENCE_CARD_ID)
  if (progressUiState.progressOverlayHandle && progressUiState.progressOverlayTop === nextTop) {
    progressUiState.progressOverlayTui.requestRender()
    return
  }
  progressUiState.progressOverlayHandle?.hide()
  progressUiState.progressOverlayHandle = progressUiState.progressOverlayTui.showOverlay(progressUiState.progressTimer.widget, {
    nonCapturing: true,
    anchor: 'top-right',
    width: STATUS_CARD_OVERLAY_WIDTH,
    margin: { right: 0, top: nextTop },
    visible: isStatusCardSidebarVisible,
  })
  progressUiState.progressOverlayTop = nextTop
  progressUiState.progressOverlayTui.requestRender()
}

function setupRecoveryMonitor(getRuntime: () => CodeIntelligenceRuntime | undefined, logger: CodeIntelligenceLogger): void {
  teardownRecoveryMonitor()
  const timer = setInterval(() => {
    const activeRuntime = getRuntime()
    if (!activeRuntime) return
    void recoverInterruptedWork(activeRuntime, logger, 'recovery poll')
  }, RECOVERY_POLL_MS)
  progressUiState.recoveryTimer = { timer, lastAttemptAt: 0 }
}

function teardownRecoveryMonitor(): void {
  if (progressUiState.recoveryTimer) clearInterval(progressUiState.recoveryTimer.timer)
  progressUiState.recoveryTimer = undefined
}

async function recoverInterruptedWork(
  runtime: CodeIntelligenceRuntime | undefined,
  logger: CodeIntelligenceLogger,
  reason: string,
  force = false
): Promise<void> {
  if (!runtime) return
  const status = runtime.indexScheduler.getStatus()
  if (status.queuedJobs > 0 && !status.running && !status.workerPid) {
    logger.info('kicking stalled code-intelligence queue', {
      repoKey: runtime.identity.repoKey,
      reason,
      queuedJobs: status.queuedJobs,
    })
    runtime.indexScheduler.kick()
    return
  }
  if (status.running || status.workerPid) return

  const now = Date.now()
  if (!force && progressUiState.recoveryTimer && now - progressUiState.recoveryTimer.lastAttemptAt < RECOVERY_RETRY_MS) return

  const indexingState = getIndexingState(runtime.db)
  const embeddingStats = getEmbeddingStats(runtime.db, runtime.identity.repoKey)
  const chunkStats = getChunkStats(runtime.db, runtime.identity.repoKey)
  const embeddingStatus = getEmbeddingStatus(runtime.db)?.status

  if (!indexingState?.full_index_completed_at) {
    if (progressUiState.recoveryTimer) progressUiState.recoveryTimer.lastAttemptAt = now
    logger.info('resuming incomplete code index', {
      repoKey: runtime.identity.repoKey,
      reason,
      activeFiles: status.stats.activeFiles ?? 0,
      chunks: chunkStats.totalChunks,
      embeddedChunks: embeddingStats.embeddedChunks,
    })
    runtime.indexScheduler.enqueueFullRepoIndex(`resume incomplete index (${reason})`)
    return
  }

  if (embeddingStats.missingEmbeddings > 0 || (embeddingStatus === 'not_started' && chunkStats.totalChunks > 0 && embeddingStats.embeddedChunks === 0)) {
    if (progressUiState.recoveryTimer) progressUiState.recoveryTimer.lastAttemptAt = now
    logger.info('resuming embedding backfill', {
      repoKey: runtime.identity.repoKey,
      reason,
      missingEmbeddings: embeddingStats.missingEmbeddings,
      chunkCount: chunkStats.totalChunks,
      embeddingStatus,
    })
    runtime.indexScheduler.enqueueEmbeddingBackfill(`resume embedding backfill (${reason})`)
  }
}

function getRetrievalStats(contextPack: ContextPack) {
  const reasonCounts: Record<string, number> = {}
  for (const chunk of contextPack.codeContext) {
    for (const reason of chunk.reasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1
  }
  return {
    codeChunks: contextPack.codeContext.length,
    files: new Set(contextPack.codeContext.map((chunk) => chunk.path)).size,
    learnings: contextPack.learnings.length,
    hardRules: contextPack.hardRules.length,
    ftsMatches: reasonCounts.fts_match ?? 0,
    semanticMatches: reasonCounts.semantic_match ?? 0,
    workingSetMatches: contextPack.codeContext.filter((chunk) => hasAnyReason(chunk.reasons, ['current_file', 'visible_file', 'changed_file'])).length,
    reasonCounts,
  }
}

function formatCompactSearchOutput(contextPack: ContextPack, options: { includeRawCode: boolean; graph?: GraphFileSummary[]; graphEdges?: GraphEdgeDetails[] }): string {
  const stats = getRetrievalStats(contextPack)
  const lines = [
    '# Code Intelligence Search Results',
    '',
    `Freshness: index=${contextPack.freshness.indexState}, embeddings=${contextPack.freshness.embeddingState}`,
    `Retrieved: ${stats.codeChunks} chunk(s) across ${stats.files} file(s), ${stats.learnings} learning(s), ${stats.hardRules} hard rule(s)`,
    `Signals: FTS=${stats.ftsMatches}, semantic=${stats.semanticMatches}, working-set=${stats.workingSetMatches}`,
  ]

  if (contextPack.warnings.length > 0) {
    lines.push('', '## Warnings')
    for (const warning of contextPack.warnings) lines.push(`- [${warning.severity}] ${warning.message}`)
  }

  if (contextPack.hardRules.length > 0) {
    lines.push('', '## Hard Rules')
    for (const rule of contextPack.hardRules.slice(0, 8)) lines.push(`- [${rule.severity}] ${rule.message}`)
  }

  if (contextPack.learnings.length > 0) {
    lines.push('', '## Relevant Learnings')
    for (const learning of contextPack.learnings.slice(0, 8)) lines.push(`- ${learning.title} (${learning.reasons.join(', ')})`)
  }

  const graphSummary = formatGraphContextSummary(options.graph ?? [])
  if (graphSummary) lines.push('', graphSummary)
  const graphEdges = formatGraphEdgeDetails(options.graphEdges ?? [])
  if (graphEdges) lines.push('', graphEdges)

  lines.push('', '## Top Files')
  for (const item of summarizeChunksByFile(contextPack).slice(0, 10)) {
    lines.push(`- ${item.path}: ${item.count} chunk(s), lines ${item.ranges.join(', ')}; ${item.reasons.join(', ')}`)
  }

  const representativeChunks = selectRepresentativeChunks(contextPack.codeContext, 12, 2)
  lines.push('', '## Representative Chunks')
  for (const chunk of representativeChunks) {
    lines.push(`- ${chunk.path}:${chunk.startLine}-${chunk.endLine}${chunk.symbolName ? ` · ${chunk.symbolName}` : ''} (${chunk.reasons.join(', ')}, score ${chunk.score.toFixed(3)})`)
  }

  const representativeFiles = new Set(representativeChunks.map((chunk) => chunk.path))
  const additionalFiles = summarizeChunksByFile(contextPack).filter((item) => !representativeFiles.has(item.path)).slice(0, 8)
  if (additionalFiles.length > 0) {
    lines.push('', '## Additional Matching Files')
    for (const item of additionalFiles) lines.push(`- ${item.path}: ${item.count} chunk(s), lines ${item.ranges.join(', ')}; ${item.reasons.join(', ')}`)
  }

  lines.push('', '## Suggested Next Actions')
  const topFiles = summarizeChunksByFile(contextPack).slice(0, 3).map((item) => item.path)
  if (topFiles.length > 0) lines.push(`- Read likely relevant file(s): ${topFiles.map((path) => `\`${path}\``).join(', ')}`)
  const symbols = contextPack.codeContext.map((chunk) => chunk.symbolName).filter(isUsefulSuggestedSymbol).slice(0, 4)
  if (symbols.length > 0) lines.push(`- Use rg for exact confirmation of symbol(s): ${[...new Set(symbols)].map((symbol) => `\`${symbol}\``).join(', ')}`)
  lines.push('- Use tests/typecheck or direct reads to verify before editing when freshness or ranking is uncertain.')
  if (!options.includeRawCode) lines.push('- Use `format: "full"` or `includeRawCode: true` if you need raw code context immediately.')

  if (options.includeRawCode) {
    lines.push('', '## Raw Context', contextPack.promptText)
  }

  return lines.join('\n')
}

function appendGraphSummary(promptText: string, graph: GraphFileSummary[], graphEdges: GraphEdgeDetails[] = []): string {
  return [promptText, formatGraphContextSummary(graph), formatGraphEdgeDetails(graphEdges)].filter(Boolean).join('\n\n')
}

function selectGraphSummaryPaths(contextPack: ContextPack, input: { currentFiles?: string[]; visibleFiles?: string[]; changedFiles?: string[] }): string[] {
  return uniqueStrings([
    ...(input.currentFiles ?? []),
    ...(input.changedFiles ?? []),
    ...(input.visibleFiles ?? []),
    ...contextPack.codeContext.slice(0, 8).map((chunk) => chunk.path),
  ])
}

function selectRepresentativeChunks<T extends { path: string; score: number; reasons: string[]; chunkKind?: string; symbolKind?: string; symbolName?: string }>(
  chunks: T[],
  limit: number,
  maxPerFile: number
): T[] {
  const selected: T[] = []
  const countByFile = new Map<string, number>()
  const preferred = chunks.filter((chunk) => !isLowValueCompactChunk(chunk))

  for (const chunk of preferred) {
    const count = countByFile.get(chunk.path) ?? 0
    if (count >= maxPerFile) continue
    selected.push(chunk)
    countByFile.set(chunk.path, count + 1)
    if (selected.length >= limit) return selected
  }

  for (const chunk of preferred) {
    if (selected.includes(chunk)) continue
    selected.push(chunk)
    if (selected.length >= limit) return selected
  }

  // Only use low-value current-file/context chunks if there are not enough meaningful matches.
  for (const chunk of chunks) {
    if (selected.includes(chunk)) continue
    selected.push(chunk)
    if (selected.length >= Math.min(limit, 6)) break
  }
  return selected
}

function isLowValueCompactChunk(chunk: { reasons: string[]; chunkKind?: string; symbolKind?: string; symbolName?: string }): boolean {
  const onlyWorkingSet = chunk.reasons.every((reason) => ['current_file', 'visible_file', 'changed_file'].includes(reason))
  if (!onlyWorkingSet) return false
  if (chunk.chunkKind === 'type' || chunk.chunkKind === 'interface') return true
  if (chunk.symbolKind === 'type' || chunk.symbolKind === 'interface' || chunk.symbolKind === 'constant') return true
  if (chunk.symbolName && /^[A-Z0-9_]+$/.test(chunk.symbolName)) return true
  return false
}

function hasAnyReason(reasons: string[], candidates: string[]): boolean {
  return candidates.some((candidate) => reasons.includes(candidate))
}

function isUsefulSuggestedSymbol(symbol: string | undefined): symbol is string {
  if (!symbol) return false
  if (symbol === 'default export') return false
  if (symbol === 'describe' || symbol === 'test') return false
  if (/^[A-Z0-9_]+$/.test(symbol)) return false
  return symbol.length > 2
}

function summarizeChunksByFile(contextPack: ContextPack): Array<{ path: string; count: number; ranges: string[]; reasons: string[]; score: number }> {
  const byFile = new Map<string, { path: string; count: number; ranges: string[]; reasons: Set<string>; score: number }>()
  for (const chunk of contextPack.codeContext) {
    const entry = byFile.get(chunk.path) ?? { path: chunk.path, count: 0, ranges: [], reasons: new Set<string>(), score: 0 }
    entry.count += 1
    entry.ranges.push(`${chunk.startLine}-${chunk.endLine}`)
    entry.score = Math.max(entry.score, chunk.score)
    for (const reason of chunk.reasons) entry.reasons.add(reason)
    byFile.set(chunk.path, entry)
  }
  return [...byFile.values()]
    .map((entry) => ({ ...entry, reasons: [...entry.reasons] }))
    .sort((a, b) => b.score - a.score || b.count - a.count)
}

function updateProgressStatus(ctx: any, runtime: CodeIntelligenceRuntime | undefined): void {
  if (!ctx.hasUI || !runtime) return
  const indexStatus = runtime.indexScheduler.getStatus()
  const embeddingService = runtime.services.get<EmbeddingService>('embeddingService')
  const dbEmbeddingStatus = getEmbeddingStatus(runtime.db)
  const embeddingStatus = dbEmbeddingStatus?.status ?? embeddingService?.status ?? 'not_started'
  const embeddingStats = getEmbeddingStats(runtime.db, runtime.identity.repoKey)
  const busy = Boolean(indexStatus.workerPid) || indexStatus.running || indexStatus.queuedJobs > 0 || !['ready', 'fts_only', 'failed'].includes(embeddingStatus)
  const value = busy ? 'intelligence: active' : undefined
  if (progressUiState.progressTimer?.lastStatus === value) return
  if (progressUiState.progressTimer) progressUiState.progressTimer.lastStatus = value
  ctx.ui.setStatus('code-intelligence', value)
  progressUiState.progressTimer?.widget?.invalidate()
}

async function getCurrentGitDiff(pi: ExtensionAPI, cwd: string): Promise<string> {
  const unstaged = await pi.exec('git', ['-C', cwd, 'diff', '--no-ext-diff'], { timeout: 10_000 })
  const staged = await pi.exec('git', ['-C', cwd, 'diff', '--cached', '--no-ext-diff'], { timeout: 10_000 })
  return `${unstaged.stdout ?? ''}
${staged.stdout ?? ''}`
}

async function runPostEditReview(
  pi: ExtensionAPI,
  runtime: CodeIntelligenceRuntime | undefined,
  logger: CodeIntelligenceLogger
): Promise<void> {
  if (!runtime) return
  try {
    const diff = await getCurrentGitDiff(pi, runtime.identity.gitRoot)
    if (!diff.trim()) return
    const result = reviewDiff(runtime.db, { repoKey: runtime.identity.repoKey, diff })
    const highConfidenceWarnings = result.warnings.filter((warning) => warning.severity === 'error' || warning.severity === 'warning')
    if (highConfidenceWarnings.length === 0) return
    pi.sendMessage(
      {
        customType: 'code-intelligence-diff-review',
        content: formatDiffReviewWarnings({ ...result, warnings: highConfidenceWarnings }),
        display: true,
        details: { warnings: highConfidenceWarnings },
      },
      { deliverAs: 'steer', triggerTurn: true }
    )
  } catch (error) {
    logger.warn('post-edit code intelligence review failed', { error: (error as Error).message })
  }
}
