import type { CodeIntelligenceRuntime } from '../lifecycle/activate.ts'
import { renderStatusCard } from '@catdaemon/pi-sidebar'

type Component = {
  render(width: number): string[]
  invalidate(): void
}

type ProgressTheme = {
  fg?: (color: string, text: string) => string
  bold?: (text: string) => string
}

import { getEmbeddingStats } from '../db/repositories/embeddingsRepo.ts'
import { getEmbeddingStatus } from '../db/repositories/embeddingStatusRepo.ts'
import { getIndexingState } from '../db/repositories/indexingStateRepo.ts'
import type { EmbeddingService } from '../embeddings/EmbeddingService.ts'

export class CodeIntelligenceProgressWidget implements Component {
  private cachedWidth?: number
  private cachedLines?: string[]

  constructor(
    private readonly getRuntime: () => CodeIntelligenceRuntime | undefined,
    private readonly getTheme?: () => ProgressTheme | undefined,
    private readonly onLayout?: (layout: { visible: boolean; height: number }) => void
  ) {}

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines
    const runtime = this.getRuntime()
    if (!runtime) return []

    const indexStatus = runtime.indexScheduler.getStatus()
    const embeddingService = runtime.services.get<EmbeddingService>('embeddingService')
    const embeddingStatus = getEmbeddingStatus(runtime.db)?.status ?? embeddingService?.status ?? 'not_started'
    const embeddingStats = getEmbeddingStats(runtime.db, runtime.identity.repoKey)
    const indexingState = getIndexingState(runtime.db)
    const busy = indexStatus.running || indexStatus.queuedJobs > 0 || Boolean(indexStatus.workerPid) || !['ready', 'fts_only', 'failed'].includes(embeddingStatus) || embeddingStats.missingEmbeddings > 0
    if (!busy) {
      this.onLayout?.({ visible: false, height: 0 })
      this.cachedLines = []
      this.cachedWidth = width
      return []
    }

    const theme = this.getTheme?.()
    const worker = indexStatus.workerPid ? `worker ${indexStatus.workerPid}` : indexStatus.queuedJobs > 0 ? 'queued' : 'pending'
    const action = indexStatus.workerPid || indexStatus.running ? 'Indexing / embedding' : indexStatus.queuedJobs > 0 ? 'Queued' : 'Embedding backfill pending'
    const pct = embeddingStats.totalEmbeddableChunks > 0
      ? `${Math.round((embeddingStats.embeddedChunks / embeddingStats.totalEmbeddableChunks) * 100)}%`
      : '0%'
    const lines = renderStatusCard(
      {
        fg: (color: string, text: string) => style(theme, color, text),
        bold: (text: string) => theme?.bold?.(text) ?? text,
      },
      'Code Intelligence',
      [
        ` → ${action} • ${worker}`,
        ` ○ Phase ${indexingState?.progress_phase ?? 'pending'}${indexingState?.progress_current_path ? ` • ${indexingState.progress_current_path}` : ''}`,
        ` ○ Files ${indexingState?.progress_files_scanned ?? indexStatus.stats.activeFiles ?? 0}/${indexStatus.stats.totalFiles ?? '?'} • embeddings ${embeddingStats.embeddedChunks}/${embeddingStats.totalEmbeddableChunks} (${pct})`,
        ` ○ Status ${embeddingStatus}${embeddingStats.missingEmbeddings > 0 ? ` • ${embeddingStats.missingEmbeddings} missing` : ''}`,
        ` ○ Graph entities ${indexingState?.progress_entities_extracted ?? 0} • relationships ${indexingState?.progress_relationships_extracted ?? 0}`,
      ],
      width
    )
    this.onLayout?.({ visible: true, height: lines.length })
    this.cachedLines = lines
    this.cachedWidth = width
    return lines
  }

  invalidate(): void {
    this.cachedWidth = undefined
    this.cachedLines = undefined
  }
}

function style(theme: ProgressTheme | undefined, color: string, text: string): string {
  return theme?.fg?.(color, text) ?? text
}
