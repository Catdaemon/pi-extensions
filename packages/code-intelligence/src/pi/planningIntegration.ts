import type { CodeIntelligenceConfig } from '../config.ts'
import type { CodeIntelligenceRuntime } from '../lifecycle/activate.ts'
import { packageKeyForPath } from '../repo/packageDetection.ts'
import { retrieveHardRules } from '../db/repositories/rulesRepo.ts'
import { buildContextPack, type ContextPack } from '../retrieval/contextPack.ts'
import { retrieveCodeHybrid, type RetrieveCodeRequest } from '../retrieval/retrieveCode.ts'
import { retrieveLearningsHybrid } from '../retrieval/retrieveLearnings.ts'
import type { EmbeddingService } from '../embeddings/EmbeddingService.ts'

export type PlanningContextRequest = RetrieveCodeRequest & {
  task: string
  selectedCode?: string
  errorOutput?: string
  maxChunkChars?: number
  maxTotalContextChars?: number
}

const PLANNING_TRIGGER = /\b(implement|add|create|change|modify|update|refactor|fix|debug|test|failing|error|route|component|api|endpoint|feature|bug|edit|rewrite|migrate|rename|remove)\b/i
const TRIVIAL_PROMPT = /^(thanks|thank you|ok|okay|yes|no|nice|looks good|continue|go on|proceed)\.?$/i
const PATH_PATTERN = /(?:^|[\s`'"(])((?:[\w.-]+\/)+[\w.@-]+\.[A-Za-z0-9]+|[\w.@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|yaml|yml|toml|css|scss|html|py|go|rs|java|sh))(?:$|[\s`'"),:])/g

export function shouldRetrievePlanningContext(prompt: string): boolean {
  const text = prompt.trim()
  if (text.length < 12) return false
  if (TRIVIAL_PROMPT.test(text)) return false
  return PLANNING_TRIGGER.test(text) || extractMentionedFilePaths(text).length > 0
}

export function buildPlanningContextRequest(input: {
  repoKey: string
  task: string
  config: CodeIntelligenceConfig
}): PlanningContextRequest {
  const currentFiles = extractMentionedFilePaths(input.task)
  const counterpartFiles = findSourceTestCounterparts(currentFiles, input.config)
  const packageKey = currentFiles.map((path) => packageKeyForPath(path, input.config)).find(Boolean)

  return {
    repoKey: input.repoKey,
    task: input.task,
    query: input.task,
    currentFiles,
    visibleFiles: [...new Set([...currentFiles, ...counterpartFiles])],
    sourceTestCounterpartFiles: counterpartFiles,
    packageKey,
    maxCodeChunks: input.config.maxCodeChunks,
    maxChunkChars: input.config.maxChunkChars,
    maxTotalContextChars: input.config.maxTotalContextChars,
  }
}

export async function retrievePlanningContextPack(runtime: CodeIntelligenceRuntime, task: string): Promise<ContextPack | undefined> {
  if (!shouldRetrievePlanningContext(task)) return undefined

  const request = buildPlanningContextRequest({
    repoKey: runtime.identity.repoKey,
    task,
    config: runtime.config,
  })
  const indexStatus = runtime.indexScheduler.getStatus()
  const watcherStatus = runtime.fileWatcher.getStatus()
  const embeddingService = runtime.services.get<EmbeddingService>('embeddingService')
  const chunks = await retrieveCodeHybrid(runtime.db, embeddingService, request)
  const learnings = await retrieveLearningsHybrid(runtime.db, embeddingService, {
    repoKey: runtime.identity.repoKey,
    query: task,
    packageKey: request.packageKey,
    maxLearnings: runtime.config.maxLearnings,
  })
  const hardRules = retrieveHardRules(runtime.db, runtime.identity.repoKey)

  return buildContextPack({
    db: runtime.db,
    repoKey: runtime.identity.repoKey,
    codeContext: chunks,
    learnings,
    hardRules,
    indexRunning: indexStatus.running,
    pendingFiles: watcherStatus.pendingChanged + watcherStatus.pendingDeleted,
    maxChunkChars: request.maxChunkChars,
    maxTotalContextChars: request.maxTotalContextChars,
  })
}

export function formatPlanningContextMessage(contextPack: ContextPack): string {
  const warningText = contextPack.warnings.length
    ? `\n\n## Context Warnings\n${contextPack.warnings.map((warning) => `- ${warning.message}`).join('\n')}`
    : ''

  return [
    'Use this local code intelligence context silently before planning or editing.',
    'Do not dump the raw context to the user; mention only relevant constraints or patterns.',
    `Freshness: index=${contextPack.freshness.indexState}, embeddings=${contextPack.freshness.embeddingState}`,
    warningText,
    '',
    contextPack.promptText,
  ]
    .filter(Boolean)
    .join('\n')
}

export function extractMentionedFilePaths(text: string): string[] {
  const paths = new Set<string>()
  for (const match of text.matchAll(PATH_PATTERN)) {
    const path = match[1]
    if (path && !path.startsWith('http')) paths.add(path.replace(/^\.\//, ''))
  }
  return [...paths]
}

export function findSourceTestCounterparts(paths: string[], config: Pick<CodeIntelligenceConfig, 'testPaths'>): string[] {
  const candidates = new Set<string>()
  for (const path of paths) {
    const withoutExt = path.replace(/\.[^.\/]+$/, '')
    const ext = path.match(/\.[^.\/]+$/)?.[0] ?? '.ts'
    const fileName = withoutExt.split('/').at(-1) ?? withoutExt
    const dir = withoutExt.split('/').slice(0, -1).join('/')

    if (/\.(test|spec)$/.test(withoutExt) || config.testPaths.some((pattern) => path.includes(pattern.replace('/**', '')))) {
      candidates.add(`${withoutExt.replace(/\.(test|spec)$/, '')}${ext}`)
      candidates.add(path.replace(/^test\//, 'src/').replace(/^tests\//, 'src/').replace(/\.(test|spec)(\.[^.]+)$/, '$2'))
    } else {
      candidates.add(`${withoutExt}.test${ext}`)
      candidates.add(`${withoutExt}.spec${ext}`)
      if (dir.startsWith('src/')) candidates.add(`${dir}/${fileName}.test${ext}`)
      candidates.add(`test/${fileName}.test${ext}`)
      candidates.add(`tests/${fileName}.test${ext}`)
    }
  }
  return [...candidates].filter((candidate) => !paths.includes(candidate))
}
