import { openCodeIntelligenceDb, closeCodeIntelligenceDb } from '../db/connection.ts'
import { updateEmbeddingStatus } from '../db/repositories/embeddingStatusRepo.ts'
import { resolveModelCacheDir } from '../repo/storage.ts'
import type { CodeIntelligenceConfig } from '../config.ts'
import type { RepoIdentity } from '../repo/identifyRepo.ts'
import { runFullRepoIndex, runIncrementalIndex } from './indexScheduler.ts'
import { embedMissingChunksForRepo } from '../embeddings/embeddingIndexer.ts'
import { refreshSimilarRelationshipsForRepo } from './similarRelationships.ts'
import { TransformersEmbeddingService } from '../embeddings/transformersEmbeddingService.ts'
import type { CodeIntelligenceLogger } from '../logger.ts'

type WorkerPayload = {
  storageDir: string
  identity: RepoIdentity
  config: CodeIntelligenceConfig
  job:
    | { kind: 'fullRepoIndex'; reason: string }
    | { kind: 'changedFilesIndex'; paths: string[]; reason: string }
    | { kind: 'deletedFileCleanup'; paths: string[]; reason: string }
    | { kind: 'embeddingBackfill'; reason: string }
}

const logger = {
  debug(message: string, details?: unknown) { writeLog('debug', message, details) },
  info(message: string, details?: unknown) { writeLog('info', message, details) },
  warn(message: string, details?: unknown) { writeLog('warn', message, details) },
  error(message: string, details?: unknown) { writeLog('error', message, details) },
} as CodeIntelligenceLogger

const parentMonitor = startParentMonitor(parseParentPid())

async function main(): Promise<void> {
  const raw = process.env.PI_CODE_INTELLIGENCE_WORKER_PAYLOAD
  if (!raw) throw new Error('Missing PI_CODE_INTELLIGENCE_WORKER_PAYLOAD')
  const payload = JSON.parse(raw) as WorkerPayload
  const db = await openCodeIntelligenceDb(payload.storageDir)
  try {
    const embeddingService = new TransformersEmbeddingService(payload.config, logger, (service) => {
      updateEmbeddingStatus(db, {
        status: service.status,
        activeModel: service.modelId,
        activeDimensions: service.dimensions,
        activeDevice: service.activeDevice,
        downloadStatus: service.downloadStatus,
        downloadFile: service.downloadFile,
        downloadLoadedBytes: service.downloadLoadedBytes,
        downloadTotalBytes: service.downloadTotalBytes,
        downloadProgress: service.downloadProgress,
        cacheDir: resolveModelCacheDir(),
        lastError: service.lastError,
      })
    })
    const common = { identity: payload.identity, db, config: payload.config, logger, embeddingService }
    const result = payload.job.kind === 'fullRepoIndex'
      ? await runFullRepoIndex(common, payload.job.reason)
      : payload.job.kind === 'embeddingBackfill'
        ? emptyIncrementalResult()
        : await runIncrementalIndex(common, {
            changedPaths: payload.job.kind === 'changedFilesIndex' ? payload.job.paths : [],
            deletedPaths: payload.job.kind === 'deletedFileCleanup' ? payload.job.paths : [],
            reason: payload.job.reason,
          })
    const backfilledEmbeddings = await embedMissingChunksForRepo(
      db,
      embeddingService,
      payload.identity.repoKey,
      payload.config.embedding,
      1000
    )
    result.embeddingsIndexed += backfilledEmbeddings
    const similarRelationships = backfilledEmbeddings > 0 ? refreshSimilarRelationshipsForRepo(db, payload.identity.repoKey) : 0
    process.stdout.write(`${JSON.stringify({ ok: true, kind: payload.job.kind, result, backfilledEmbeddings, similarRelationships })}\n`)
  } finally {
    parentMonitor?.stop()
    closeCodeIntelligenceDb(db)
  }
}

function emptyIncrementalResult() {
  const now = new Date().toISOString()
  return {
    changedFiles: 0,
    deletedFiles: 0,
    skippedUnchanged: 0,
    skippedIgnored: 0,
    chunksIndexed: 0,
    embeddingsIndexed: 0,
    startedAt: now,
    completedAt: now,
  }
}

function writeLog(level: string, message: string, details?: unknown): void {
  if (process.env.PI_CODE_INTELLIGENCE_LOG_LEVEL === 'debug') {
    process.stderr.write(`[pi-code-intelligence:index-worker] ${level} ${message}${details ? ` ${JSON.stringify(details)}` : ''}\n`)
  }
}

function parseParentPid(): number | undefined {
  const arg = process.argv.find((item) => item.startsWith('--parent-pid='))
  const raw = arg?.slice('--parent-pid='.length) ?? process.env.PI_CODE_INTELLIGENCE_PARENT_PID
  if (!raw) return undefined
  const pid = Number.parseInt(raw, 10)
  return Number.isFinite(pid) ? pid : undefined
}

function startParentMonitor(parentPid: number | undefined): { stop(): void } | undefined {
  if (!parentPid) return undefined
  const timer = setInterval(() => {
    if (isProcessAlive(parentPid)) return
    writeLog('warn', 'parent process exited; stopping orphaned worker', { parentPid })
    process.exit(0)
  }, 1000)
  timer.unref?.()
  return { stop: () => clearInterval(timer) }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: (error as Error).message })}\n`)
  process.exit(1)
})
