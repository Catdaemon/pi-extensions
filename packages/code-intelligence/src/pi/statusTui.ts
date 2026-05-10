import type { CodeIntelligenceRuntime } from '../lifecycle/activate.ts'
import { getChunkStats } from '../db/repositories/chunksRepo.ts'
import { getEmbeddingStats } from '../db/repositories/embeddingsRepo.ts'
import { getEntityStats } from '../db/repositories/entitiesRepo.ts'
import { getRelationshipStats } from '../db/repositories/relationshipsRepo.ts'
import { getFileRelationshipStats } from '../db/repositories/fileRelationshipsRepo.ts'
import { getEmbeddingStatus } from '../db/repositories/embeddingStatusRepo.ts'
import { getIndexingState } from '../db/repositories/indexingStateRepo.ts'
import { listLearnings } from '../db/repositories/learningsRepo.ts'
import { getMachineRuleStats } from '../db/repositories/rulesRepo.ts'
import type { EnabledRepoRecord } from '../repo/enabledRepos.ts'
import type { EmbeddingService } from '../embeddings/EmbeddingService.ts'

export class CodeIntelligenceDashboardComponent {
  private cachedWidth?: number
  private cachedLines?: string[]

  constructor(
    private readonly runtime: CodeIntelligenceRuntime | undefined,
    private readonly enabledRepos: EnabledRepoRecord[],
    private readonly done: () => void,
    private readonly theme?: { fg?: (color: string, text: string) => string; bold?: (text: string) => string }
  ) {}

  handleInput(data: string): void {
    if (data === 'q' || data === 'Q' || data === '\u001b') this.done()
  }

  render(width: number): string[] {
    this.invalidate()
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines
    const lines: string[] = []
    const title = this.style('accent', this.theme?.bold?.('Pi Code Intelligence') ?? 'Pi Code Intelligence')
    lines.push(truncate(title, width))
    lines.push(truncate('─'.repeat(Math.max(0, Math.min(width, 80))), width))

    if (!this.runtime) {
      lines.push('Current project: inactive')
      lines.push('Use /enable-code-intelligence to enable this repo.')
    } else {
      const runtime = this.runtime
      const indexStatus = runtime.indexScheduler.getStatus()
      const watcherStatus = runtime.fileWatcher.getStatus()
      const indexingState = getIndexingState(runtime.db)
      const chunkStats = getChunkStats(runtime.db, runtime.identity.repoKey)
      const embeddingStatus = getEmbeddingStatus(runtime.db)
      const embeddingStats = getEmbeddingStats(runtime.db, runtime.identity.repoKey)
      const activeLearnings = listLearnings(runtime.db, runtime.identity.repoKey, 'active')
      const draftLearnings = listLearnings(runtime.db, runtime.identity.repoKey, 'draft')
      const staleLearnings = listLearnings(runtime.db, runtime.identity.repoKey).filter((learning) => learning.status === 'superseded' || learning.status === 'rejected')
      const ruleStats = getMachineRuleStats(runtime.db, runtime.identity.repoKey)
      const entityStats = getEntityStats(runtime.db, runtime.identity.repoKey)
      const relationshipStats = getRelationshipStats(runtime.db, runtime.identity.repoKey)
      const fileRelationshipStats = getFileRelationshipStats(runtime.db, runtime.identity.repoKey)

      lines.push(`Project: ${runtime.identity.gitRoot}`)
      lines.push(`Repo key: ${runtime.identity.repoKey}`)
      lines.push(`Storage: ${runtime.storageDir}`)
      lines.push('')
      lines.push(section('Indexing'))
      lines.push(`Running: ${yesNo(indexStatus.running)}    Queue: ${indexStatus.queuedJobs}    Watcher: ${yesNo(watcherStatus.active)}`)
      lines.push(`Pending watcher changes: ${watcherStatus.pendingChanged + watcherStatus.pendingDeleted}`)
      lines.push(`Phase: ${indexingState?.progress_phase ?? '(none)'}    Current: ${indexingState?.progress_current_path ?? '(none)'}`)
      lines.push(`Progress counts: files scanned ${indexingState?.progress_files_scanned ?? 0}    entities ${indexingState?.progress_entities_extracted ?? 0}    relationships ${indexingState?.progress_relationships_extracted ?? 0}    embeddings missing ${embeddingStats.missingEmbeddings}`)
      if ((indexingState?.progress_recent_paths?.length ?? 0) > 0) lines.push(`Recent files: ${indexingState!.progress_recent_paths.slice(0, 3).join(', ')}`)
      lines.push(`Files: ${indexStatus.stats.activeFiles ?? 0} active / ${indexStatus.stats.totalFiles ?? 0} total    Generated: ${indexStatus.stats.generatedFiles ?? 0}`)
      lines.push(`Chunks: ${chunkStats.totalChunks} across ${chunkStats.chunkedFiles} file(s)`)
      lines.push(`Last indexed: ${indexStatus.stats.lastIndexedAt ?? '(never)'}`)
      lines.push(`Full index completed: ${indexingState?.full_index_completed_at ?? '(never)'}`)
      lines.push('')
      lines.push(section('Embeddings'))
      const embeddingService = runtime.services.get<EmbeddingService>('embeddingService')
      lines.push(`Status: ${embeddingStatus?.status ?? 'not_started'}    Model: ${embeddingStatus?.active_model ?? '(none)'}    Device: ${embeddingService?.activeDevice ?? '(auto/cpu pending)'}`)
      lines.push(`Embedded chunks: ${embeddingStats.embeddedChunks}/${embeddingStats.totalEmbeddableChunks}    Missing: ${embeddingStats.missingEmbeddings}    Stale: ${embeddingStats.staleEmbeddings ?? 0}`)
      lines.push(`Last embedded: ${embeddingStats.lastEmbeddedAt ?? '(never)'}`)
      lines.push('')
      lines.push(section('Graph debug'))
      lines.push(`Entities: ${entityStats.totalEntities}    Kinds: ${formatCounts(entityStats.byKind)}`)
      lines.push(`Code relationships: ${relationshipStats.totalRelationships}    By kind: ${formatCounts(relationshipStats.byKind)}`)
      lines.push(`File relationships: ${fileRelationshipStats.totalRelationships}    By kind: ${formatCounts(fileRelationshipStats.byKind)}`)
      lines.push('Large/slow skipped files: see scanner summary/logs; bounded table pending graph/index stage.')
      lines.push('')
      lines.push(section('Review config'))
      lines.push(`Files loaded: ${runtime.config.review.status.filesLoaded.length > 0 ? runtime.config.review.status.filesLoaded.join(', ') : '(none)'}    Scoped rules: ${runtime.config.review.rules.length}`)
      if (runtime.config.review.status.errors.length > 0) lines.push(`Errors: ${runtime.config.review.status.errors.slice(0, 2).join(' | ')}`)
      lines.push('')
      lines.push(section('Learnings & Rules'))
      lines.push(`Active learnings: ${activeLearnings.length}    Draft: ${draftLearnings.length}    Superseded/rejected: ${staleLearnings.length}`)
      lines.push(`Rules: ${ruleStats.activeRules ?? 0} active / ${ruleStats.totalRules} total`)
      if (activeLearnings.length > 0) {
        lines.push('Recent active learnings:')
        for (const learning of activeLearnings.slice(0, 5)) lines.push(`  • ${learning.title} (${learning.confidence.toFixed(2)})`)
      }
    }

    lines.push('')
    lines.push(section('Enabled projects'))
    if (this.enabledRepos.length === 0) lines.push('No enabled projects.')
    else for (const repo of this.enabledRepos.slice(0, 8)) lines.push(`• ${repo.repoKey.slice(0, 8)} ${repo.gitRoot} (last seen ${repo.lastSeenAt})`)
    if (this.enabledRepos.length > 8) lines.push(`…and ${this.enabledRepos.length - 8} more`)
    lines.push('')
    lines.push(this.style('dim', 'q / esc close'))

    this.cachedLines = lines.flatMap((line) => wrapLine(line, Math.max(20, width))).slice(0, 40)
    this.cachedWidth = width
    return this.cachedLines
  }

  invalidate(): void {
    this.cachedWidth = undefined
    this.cachedLines = undefined
  }

  private style(color: string, text: string): string {
    return this.theme?.fg?.(color, text) ?? text
  }
}

function section(text: string): string {
  return `▸ ${text}`
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8)
  return entries.length > 0 ? entries.map(([kind, count]) => `${kind}=${count}`).join(', ') : '(none)'
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no'
}

function truncate(text: string, width: number): string {
  if (width <= 0) return ''
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`
}

function wrapLine(text: string, width: number): string[] {
  if (text.length <= width) return [text]
  const lines: string[] = []
  let rest = text
  while (rest.length > width) {
    lines.push(truncate(rest, width))
    rest = `  ${rest.slice(Math.max(1, width - 1))}`
  }
  if (rest) lines.push(rest)
  return lines
}
