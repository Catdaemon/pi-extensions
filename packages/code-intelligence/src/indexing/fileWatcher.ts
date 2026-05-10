import { relative } from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import type { CodeIntelligenceConfig } from '../config.ts'
import type { CodeIntelligenceLogger } from '../logger.ts'
import { normalizeRelativePath } from './glob.ts'
import { shouldIncludePath, shouldPruneDirectory } from './fileScanner.ts'
import type { IndexScheduler } from './indexScheduler.ts'

export class CodeIntelligenceFileWatcher {
  private watcher: FSWatcher | undefined
  private timer: NodeJS.Timeout | undefined
  private readonly changed = new Set<string>()
  private readonly deleted = new Set<string>()

  constructor(
    private readonly options: {
      repoRoot: string
      config: CodeIntelligenceConfig
      indexScheduler: IndexScheduler
      logger: CodeIntelligenceLogger
      debounceMs?: number
      largeChangeThreshold?: number
    }
  ) {}

  start(): void {
    if (this.watcher) return

    this.watcher = chokidar.watch(this.options.repoRoot, {
      ignoreInitial: true,
      persistent: true,
      ignored: (path, stats) => {
        const rel = this.toRelative(path)
        if (!rel) return false
        if (stats?.isDirectory()) return shouldPruneDirectory(rel, this.options.config)
        return !shouldIncludePath(rel, this.options.config)
      },
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    })

    this.watcher.on('add', (path) => this.queueChanged(path))
    this.watcher.on('change', (path) => this.queueChanged(path))
    this.watcher.on('unlink', (path) => this.queueDeleted(path))
    this.watcher.on('error', (error) => {
      this.options.logger.warn('file watcher error', { error: String(error) })
    })

    this.options.logger.info('file watcher started', { repoRoot: this.options.repoRoot })
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.flush()
    await this.watcher?.close()
    this.watcher = undefined
    this.options.logger.info('file watcher stopped', { repoRoot: this.options.repoRoot })
  }

  getStatus() {
    return {
      active: Boolean(this.watcher),
      pendingChanged: this.changed.size,
      pendingDeleted: this.deleted.size,
    }
  }

  private queueChanged(path: string): void {
    const rel = this.toRelative(path)
    if (!rel) return
    this.deleted.delete(rel)
    this.changed.add(rel)
    this.scheduleFlush()
  }

  private queueDeleted(path: string): void {
    const rel = this.toRelative(path)
    if (!rel) return
    this.changed.delete(rel)
    this.deleted.add(rel)
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.timer) clearTimeout(this.timer)
    const total = this.changed.size + this.deleted.size
    const debounceMs = total >= (this.options.largeChangeThreshold ?? 100) ? 5_000 : (this.options.debounceMs ?? 750)
    this.timer = setTimeout(() => this.flush(), debounceMs)
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined

    const changed = [...this.changed]
    const deleted = [...this.deleted]
    this.changed.clear()
    this.deleted.clear()

    if (changed.length > 0) this.options.indexScheduler.enqueueChangedFiles(changed, 'file watcher')
    if (deleted.length > 0) this.options.indexScheduler.enqueueDeletedFiles(deleted, 'file watcher')
  }

  private toRelative(path: string): string | undefined {
    const rel = normalizeRelativePath(relative(this.options.repoRoot, path))
    if (!rel || rel.startsWith('..')) return undefined
    return rel
  }
}
