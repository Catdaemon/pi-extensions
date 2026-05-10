import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { CodeIntelligenceConfig } from '../config.ts'
import type { CodeIntelligenceDb } from '../db/connection.ts'
import { deleteChunksForFilePaths, replaceChunksForFile, type InsertedChunk } from '../db/repositories/chunksRepo.ts'
import { deleteEntitiesForFilePaths, findEntitiesByName, listEntitiesForPath, replaceEntitiesForFile } from '../db/repositories/entitiesRepo.ts'
import { deleteCodeRelationshipsForFilePaths, listIncomingCodeRelationshipsForPath, replaceCodeRelationshipsForFile } from '../db/repositories/relationshipsRepo.ts'
import { deleteFileRelationshipsForFilePaths, listIncomingFileRelationshipsForPath, replaceFileRelationshipsForFile } from '../db/repositories/fileRelationshipsRepo.ts'
import { findActiveFilePaths, findMissingActiveFilePaths, getFileIndexStats, markFileDeleted, markMissingFilesDeleted, pruneDeletedFileRows, upsertIndexedFile } from '../db/repositories/filesRepo.ts'
import { markFullIndexCompleted, markIncrementalIndexCompleted, updateIndexProgress } from '../db/repositories/indexingStateRepo.ts'
import { embedChunksIncremental } from '../embeddings/embeddingIndexer.ts'
import type { EmbeddingService } from '../embeddings/EmbeddingService.ts'
import type { CodeIntelligenceLogger } from '../logger.ts'
import type { RepoIdentity } from '../repo/identifyRepo.ts'
import { packageKeyForPath } from '../repo/packageDetection.ts'
import { chunkFile } from './chunker.ts'
import { extractCodeRelationshipsForFile, extractReferencedNamesForFile } from './codeRelationshipExtractor.ts'
import { extractEntitiesForFile } from './entityExtractor.ts'
import { extractFileRelationshipsForFile } from './relationshipExtractor.ts'
import { refreshSimilarRelationshipsForRepo } from './similarRelationships.ts'
import { scanRepoFiles, scanSingleFile, shouldIncludePath, type ScannedFile, type ScanSummary } from './fileScanner.ts'

export type FullIndexResult = {
  scanned: number
  insertedOrChanged: number
  skippedUnchanged: number
  deleted: number
  generated: number
  chunksIndexed: number
  embeddingsIndexed: number
  summary: ScanSummary
  startedAt: string
  completedAt: string
}

export type IncrementalIndexResult = {
  changedFiles: number
  deletedFiles: number
  skippedUnchanged: number
  skippedIgnored: number
  chunksIndexed: number
  embeddingsIndexed: number
  startedAt: string
  completedAt: string
}

type IndexJob =
  | {
      kind: 'fullRepoIndex'
      reason: string
    }
  | {
      kind: 'changedFilesIndex'
      paths: string[]
      reason: string
    }
  | {
      kind: 'deletedFileCleanup'
      paths: string[]
      reason: string
    }
  | {
      kind: 'embeddingBackfill'
      reason: string
    }

const execFileAsync = promisify(execFile)
const WORKER_PROCESS_MARKER = '--pi-code-intelligence-worker'
const WORKER_PROCESS_POLL_MS = 250
const DELETED_FILE_PRUNE_AGE_MS = 30 * 24 * 60 * 60 * 1000
const WORKER_START_LOCK_DIR = 'worker-start.lock'
const MAX_INCREMENTAL_DEPENDENCY_REFRESH_FILES = 50

export type WorkerProcessInfo = {
  pid: number
  command: string
  parentPid?: number
}

export function buildWorkerProcessArgs(repoKey: string, parentPid = process.pid): string[] {
  return [WORKER_PROCESS_MARKER, `--repo-key=${repoKey}`, `--parent-pid=${parentPid}`]
}

export function parseWorkerProcessEntries(output: string, repoKey: string, excludePids: number[] = []): WorkerProcessInfo[] {
  const excluded = new Set(excludePids.filter((pid) => Number.isFinite(pid)))
  const repoArg = `--repo-key=${repoKey}`
  return output
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(.*)$/)
      if (!match) return []
      const pid = Number.parseInt(match[1] ?? '', 10)
      const command = match[2] ?? ''
      if (!Number.isFinite(pid) || excluded.has(pid)) return []
      if (!command.includes(WORKER_PROCESS_MARKER) || !command.includes(repoArg)) return []
      return [{ pid, command, parentPid: parseParentPid(command) }]
    })
}

export function parseWorkerProcessList(output: string, repoKey: string, excludePids: number[] = []): number[] {
  return parseWorkerProcessEntries(output, repoKey, excludePids).map((entry) => entry.pid)
}

export async function listCodeIntelligenceWorkerPids(
  repoKey: string,
  options: { excludePids?: number[]; logger?: Pick<CodeIntelligenceLogger, 'debug'> } = {}
): Promise<number[]> {
  return (await listCodeIntelligenceWorkerProcesses(repoKey, options)).map((entry) => entry.pid)
}

export async function listCodeIntelligenceWorkerProcesses(
  repoKey: string,
  options: { excludePids?: number[]; logger?: Pick<CodeIntelligenceLogger, 'debug'> } = {}
): Promise<WorkerProcessInfo[]> {
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='], { maxBuffer: 1024 * 1024 })
    return parseWorkerProcessEntries(String(stdout ?? ''), repoKey, options.excludePids ?? [])
  } catch (error) {
    options.logger?.debug('failed to inspect process list for code-intelligence workers', {
      repoKey,
      error: (error as Error).message,
    })
    return []
  }
}

export class IndexScheduler {
  private readonly queue: IndexJob[] = []
  private running = false
  private stopped = false
  private lastFullIndexResult: FullIndexResult | undefined
  private lastIncrementalIndexResult: IncrementalIndexResult | undefined
  private currentWorker: ChildProcess | undefined
  private externalWorkerPid: number | undefined
  private lastEmbeddingBackfillEnqueueAt = 0

  constructor(
    private readonly options: {
      identity: RepoIdentity
      db: CodeIntelligenceDb
      config: CodeIntelligenceConfig
      logger: CodeIntelligenceLogger
      embeddingService?: EmbeddingService
      dbStorageDir: string
    }
  ) {}

  enqueueFullRepoIndex(reason = 'scheduled'): void {
    if (this.stopped) return
    if (this.queue.some((job) => job.kind === 'fullRepoIndex')) return
    this.queue.push({ kind: 'fullRepoIndex', reason })
    void this.drain()
  }

  enqueueChangedFiles(paths: string[], reason = 'file watcher'): void {
    if (this.stopped || paths.length === 0) return
    const normalized = [...new Set(paths)]
    const existing = this.queue.find((job): job is Extract<IndexJob, { kind: 'changedFilesIndex' }> => job.kind === 'changedFilesIndex')
    if (existing) existing.paths = [...new Set([...existing.paths, ...normalized])]
    else this.queue.push({ kind: 'changedFilesIndex', paths: normalized, reason })
    void this.drain()
  }

  enqueueDeletedFiles(paths: string[], reason = 'file watcher'): void {
    if (this.stopped || paths.length === 0) return
    const normalized = [...new Set(paths)]
    const existing = this.queue.find((job): job is Extract<IndexJob, { kind: 'deletedFileCleanup' }> => job.kind === 'deletedFileCleanup')
    if (existing) existing.paths = [...new Set([...existing.paths, ...normalized])]
    else this.queue.push({ kind: 'deletedFileCleanup', paths: normalized, reason })
    void this.drain()
  }

  enqueueEmbeddingBackfill(reason = 'embedding backfill'): void {
    if (this.stopped) return
    if (this.running || this.queue.some((job) => job.kind === 'embeddingBackfill' || job.kind === 'fullRepoIndex')) return
    const now = Date.now()
    if (now - this.lastEmbeddingBackfillEnqueueAt < 30_000) return
    this.lastEmbeddingBackfillEnqueueAt = now
    this.queue.push({ kind: 'embeddingBackfill', reason })
    void this.drain()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.queue.length = 0
    await this.cancelActiveWorker()
  }

  async cancelActiveWorker(timeoutMs = 1500): Promise<void> {
    this.queue.length = 0
    const worker = this.currentWorker
    if (worker && !worker.killed) worker.kill('SIGTERM')
    await this.releaseWorkerStartLock()

    let externalPids = await listCodeIntelligenceWorkerPids(this.options.identity.repoKey, {
      excludePids: worker?.pid ? [worker.pid] : [],
      logger: this.options.logger,
    })
    for (const pid of externalPids) safeKill(pid, 'SIGTERM')

    const started = Date.now()
    let sentKill = false
    while (Date.now() - started < timeoutMs) {
      externalPids = await listCodeIntelligenceWorkerPids(this.options.identity.repoKey, {
        excludePids: worker?.pid ? [worker.pid] : [],
        logger: this.options.logger,
      })
      const waitingOnCurrent = Boolean(this.running)
      const waitingOnExternal = externalPids.length > 0
      if (!waitingOnCurrent && !waitingOnExternal) break

      if (!sentKill && Date.now() - started > 500) {
        if (worker && !worker.killed) worker.kill('SIGKILL')
        for (const pid of externalPids) safeKill(pid, 'SIGKILL')
        sentKill = true
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    if (Date.now() - started >= timeoutMs) {
      this.options.logger.warn('timed out waiting for index worker to stop; continuing UI flow', {
        repoKey: this.options.identity.repoKey,
        pid: worker?.pid,
        externalPids,
      })
      this.currentWorker = undefined
      this.running = false
      this.externalWorkerPid = undefined
    }
  }

  getStatus() {
    const stats = getFileIndexStats(this.options.db, this.options.identity.repoKey)
    return {
      running: this.running,
      queuedJobs: this.queue.length,
      workerPid: this.currentWorker?.pid ?? this.externalWorkerPid,
      lastFullIndexResult: this.lastFullIndexResult,
      lastIncrementalIndexResult: this.lastIncrementalIndexResult,
      stats,
    }
  }

  kick(): void {
    if (this.stopped || this.running || this.queue.length === 0) return
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.running || this.stopped) return
    this.running = true

    try {
      while (!this.stopped) {
        const queuedJob = this.queue[0]
        if (!queuedJob) break
        await this.waitForWorkerSlot()
        if (this.stopped) break
        const job = this.queue.shift()
        if (!job) continue
        const result = await this.runJobInWorker(job)
        if (job.kind === 'fullRepoIndex') this.lastFullIndexResult = result as FullIndexResult
        else this.lastIncrementalIndexResult = result as IncrementalIndexResult
      }
    } catch (error) {
      this.options.logger.error('index job failed', { error: (error as Error).message })
    } finally {
      this.currentWorker = undefined
      this.running = false
    }
  }

  private async runJobInWorker(job: IndexJob): Promise<FullIndexResult | IncrementalIndexResult> {
    await this.acquireWorkerStartLock()
    try {
      await this.waitForWorkerSlot()
      const workerPath = fileURLToPath(new URL('./indexWorker.ts', import.meta.url))
      const require = createRequire(import.meta.url)
      const tsxLoader = require.resolve('tsx')
      const payload = JSON.stringify({
        storageDir: this.options.dbStorageDir,
        identity: this.options.identity,
        config: this.options.config,
        job,
      })
      const workerArgs = ['--import', tsxLoader, workerPath, ...buildWorkerProcessArgs(this.options.identity.repoKey)]
      this.externalWorkerPid = undefined
      return await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, workerArgs, {
          env: { ...process.env, PI_CODE_INTELLIGENCE_WORKER_PAYLOAD: payload, PI_CODE_INTELLIGENCE_PARENT_PID: String(process.pid) },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        this.currentWorker = child
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => { stdout += String(chunk) })
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk)
        })
        child.on('error', (error) => {
          this.currentWorker = undefined
          reject(error)
        })
        child.on('exit', (code, signal) => {
          this.currentWorker = undefined
          const lines = stdout.trim().split(/\n/).filter(Boolean)
          const last = lines.at(-1)
          if (signal && this.stopped) return resolve(job.kind === 'fullRepoIndex' ? emptyFullIndexResult() : emptyIncrementalIndexResult())
          if (!last) return reject(new Error(`Index worker exited without result (code ${code}, signal ${signal}): ${stderr.slice(-1000)}`))
          try {
            const parsed = JSON.parse(last) as { ok: boolean; error?: string; result?: FullIndexResult | IncrementalIndexResult }
            if (!parsed.ok || !parsed.result) return reject(new Error(parsed.error ?? `Index worker failed with code ${code}`))
            resolve(parsed.result)
          } catch (error) {
            reject(new Error(`Failed to parse index worker result: ${(error as Error).message}; stderr: ${stderr.slice(-1000)}`))
          }
        })
      })
    } finally {
      await this.releaseWorkerStartLock()
    }
  }

  private lockDir(): string {
    return join(this.options.dbStorageDir, 'worker.lock')
  }

  private startLockDir(): string {
    return join(this.options.dbStorageDir, WORKER_START_LOCK_DIR)
  }

  private async acquireWorkerStartLock(): Promise<void> {
    const lockDir = this.startLockDir()
    while (!this.stopped) {
      try {
        await mkdir(lockDir)
        await writeFile(join(lockDir, 'owner-pid'), `${process.pid}\n`, 'utf8')
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const ownerPid = await readLockPid(lockDir)
        const externalPid = await this.findExternalWorkerPid()
        if (ownerPid && isProcessAlive(ownerPid)) {
          this.externalWorkerPid = externalPid ?? ownerPid
          await sleep(WORKER_PROCESS_POLL_MS)
          continue
        }
        if (externalPid) {
          this.externalWorkerPid = externalPid
          await sleep(WORKER_PROCESS_POLL_MS)
          continue
        }
        await rm(lockDir, { recursive: true, force: true })
      }
    }
    throw new Error('Index scheduler stopped before acquiring worker start lock')
  }

  private async releaseWorkerStartLock(): Promise<void> {
    await rm(this.startLockDir(), { recursive: true, force: true })
  }

  private async waitForWorkerSlot(): Promise<void> {
    while (!this.stopped && this.queue.length > 0) {
      await this.cleanupLegacyLockDir()
      const pid = await this.findExternalWorkerPid()
      if (!pid) {
        this.externalWorkerPid = undefined
        return
      }
      this.externalWorkerPid = pid
      await sleep(WORKER_PROCESS_POLL_MS)
    }
  }

  private async findExternalWorkerPid(): Promise<number | undefined> {
    const workers = await listCodeIntelligenceWorkerProcesses(this.options.identity.repoKey, {
      excludePids: this.currentWorker?.pid ? [this.currentWorker.pid] : [],
      logger: this.options.logger,
    })
    for (const worker of workers) {
      if (worker.parentPid && !isProcessAlive(worker.parentPid)) {
        this.options.logger.warn('terminating orphaned code-intelligence worker', {
          repoKey: this.options.identity.repoKey,
          pid: worker.pid,
          parentPid: worker.parentPid,
        })
        safeKill(worker.pid, 'SIGTERM')
        continue
      }
      return worker.pid
    }
    return undefined
  }

  private async cleanupLegacyLockDir(): Promise<void> {
    const lockDir = this.lockDir()
    if (!existsSync(lockDir)) return
    const pid = await readLockPid(lockDir)
    if (pid && isProcessAlive(pid)) return
    try {
      await rm(lockDir, { recursive: true, force: true })
    } catch (error) {
      this.options.logger.warn('failed to remove legacy code-intelligence worker lock; ignoring', {
        repoKey: this.options.identity.repoKey,
        lockDir,
        error: (error as Error).message,
      })
    }
  }
}


export async function runIncrementalIndex(
  options: {
    identity: RepoIdentity
    db: CodeIntelligenceDb
    config: CodeIntelligenceConfig
    logger: CodeIntelligenceLogger
    embeddingService?: EmbeddingService
  },
  input: { changedPaths: string[]; deletedPaths: string[]; reason?: string }
): Promise<IncrementalIndexResult> {
  const startedAt = new Date().toISOString()
  const changedPaths = [...new Set(input.changedPaths)]
  const deletedPaths = [...new Set(input.deletedPaths)]
  options.logger.info('incremental index started', {
    repoKey: options.identity.repoKey,
    changedFiles: changedPaths.length,
    deletedFiles: deletedPaths.length,
    reason: input.reason ?? 'manual',
  })

  const insertedChunksForEmbedding: InsertedChunk[] = []
  let changedFiles = 0
  let skippedUnchanged = 0
  let skippedIgnored = 0
  let chunksIndexed = 0
  let entitiesExtracted = 0
  let relationshipsExtracted = 0

  const dependencyRefreshCandidates = collectDependencyRefreshCandidates(options.db, options.identity.repoKey, changedPaths, deletedPaths)
  const scannedFiles: ScannedFile[] = []
  const deleteSet = new Set(deletedPaths)
  updateIndexProgress(options.db, { repoKey: options.identity.repoKey, phase: 'scanning', filesScanned: 0, startedAt })
  for (const path of changedPaths) {
    updateIndexProgress(options.db, { repoKey: options.identity.repoKey, phase: 'scanning', currentPath: path, filesScanned: scannedFiles.length, startedAt })
    try {
      const scanned = await scanSingleFile(options.identity.gitRoot, path, options.config)
      if (scanned) scannedFiles.push(scanned)
      else {
        skippedIgnored += 1
        deleteSet.add(path)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') deleteSet.add(path)
      else throw error
    }
  }

  const activePaths = new Set([...findActiveFilePaths(options.db, options.identity.repoKey), ...scannedFiles.map((file) => file.relativePath)].filter((path) => !deleteSet.has(path)))
  for (let index = 0; index < scannedFiles.length; index += 1) {
    const file = scannedFiles[index]!
    updateIndexProgress(options.db, { repoKey: options.identity.repoKey, phase: 'chunking', currentPath: file.relativePath, filesScanned: index + 1, startedAt })
    const result = indexScannedFile(options, file, activePaths)
    entitiesExtracted += result.entityCount
    relationshipsExtracted += result.relationshipCount
    updateIndexProgress(options.db, { repoKey: options.identity.repoKey, phase: 'graph extraction', currentPath: file.relativePath, filesScanned: index + 1, entitiesExtracted, relationshipsExtracted, startedAt })
    if (result.skippedUnchanged) skippedUnchanged += 1
    else {
      changedFiles += 1
      chunksIndexed += result.insertedChunks.length
      insertedChunksForEmbedding.push(...result.insertedChunks)
    }
    if (index % 10 === 9) await yieldToEventLoop()
  }

  const indexedChangedPaths = new Set(scannedFiles.map((file) => file.relativePath))
  const dependencyRefreshFiles = await scanDependencyRefreshFiles(options, dependencyRefreshCandidates, activePaths, indexedChangedPaths, deleteSet)
  if (dependencyRefreshFiles.length > 0) {
    updateIndexProgress(options.db, { repoKey: options.identity.repoKey, phase: 'graph extraction', currentPath: null, filesScanned: scannedFiles.length, entitiesExtracted, relationshipsExtracted, startedAt })
    relationshipsExtracted += refreshCodeRelationshipsForScannedFiles({ identity: options.identity, db: options.db }, dependencyRefreshFiles)
    updateIndexProgress(options.db, { repoKey: options.identity.repoKey, phase: 'graph extraction', currentPath: null, filesScanned: scannedFiles.length, entitiesExtracted, relationshipsExtracted, startedAt })
  }

  updateIndexProgress(options.db, { repoKey: options.identity.repoKey, phase: 'embedding', currentPath: null, filesScanned: scannedFiles.length, startedAt })

  let deletedFiles = 0
  const deletePaths = [...deleteSet]
  for (let index = 0; index < deletePaths.length; index += 1) {
    const path = deletePaths[index]!
    if (markFileDeleted(options.db, options.identity.repoKey, path)) deletedFiles += 1
    deleteGraphForFilePaths(options.db, options.identity.repoKey, [path])
    deleteChunksForFilePaths(options.db, options.identity.repoKey, [path])
    if (index % 10 === 9) await yieldToEventLoop()
  }

  const embeddingsIndexed = options.embeddingService
    ? await embedChunksIncremental(
        options.db,
        options.embeddingService,
        insertedChunksForEmbedding,
        options.config.embedding.batchSize
      )
    : 0
  if (embeddingsIndexed > 0) {
    relationshipsExtracted += refreshSimilarRelationshipsForRepo(options.db, options.identity.repoKey)
    updateIndexProgress(options.db, { repoKey: options.identity.repoKey, phase: 'graph extraction', currentPath: null, filesScanned: scannedFiles.length, entitiesExtracted, relationshipsExtracted, startedAt })
  }
  pruneDeletedFileRows(options.db, options.identity.repoKey, deletedFilePruneCutoff())

  const completedAt = new Date().toISOString()
  markIncrementalIndexCompleted(options.db, options.identity.repoKey, completedAt)

  const result: IncrementalIndexResult = {
    changedFiles,
    deletedFiles,
    skippedUnchanged,
    skippedIgnored,
    chunksIndexed,
    embeddingsIndexed,
    startedAt,
    completedAt,
  }
  options.logger.info('incremental index completed', result)
  return result
}

function markDeletedPaths(db: CodeIntelligenceDb, repoKey: string, paths: string[]): number {
  let deleted = 0
  for (const path of paths) {
    if (markFileDeleted(db, repoKey, path)) deleted += 1
  }
  return deleted
}

function collectDependencyRefreshCandidates(db: CodeIntelligenceDb, repoKey: string, changedPaths: string[], deletedPaths: string[]): string[] {
  const changed = new Set(changedPaths)
  const deleted = new Set(deletedPaths)
  const candidates = new Set<string>()
  for (const path of changedPaths) {
    for (const rel of listIncomingFileRelationshipsForPath(db, repoKey, path)) {
      if (!changed.has(rel.sourcePath) && !deleted.has(rel.sourcePath)) candidates.add(rel.sourcePath)
    }
    for (const rel of listIncomingCodeRelationshipsForPath(db, repoKey, path)) {
      if (!changed.has(rel.sourcePath) && !deleted.has(rel.sourcePath)) candidates.add(rel.sourcePath)
    }
  }
  return [...candidates].slice(0, MAX_INCREMENTAL_DEPENDENCY_REFRESH_FILES)
}

async function scanDependencyRefreshFiles(
  options: { identity: RepoIdentity; config: CodeIntelligenceConfig; logger: CodeIntelligenceLogger },
  paths: string[],
  activePaths: Set<string>,
  indexedChangedPaths: Set<string>,
  deletedPaths: Set<string>
): Promise<ScannedFile[]> {
  const files: ScannedFile[] = []
  for (const path of paths) {
    if (indexedChangedPaths.has(path) || deletedPaths.has(path) || !activePaths.has(path)) continue
    try {
      const scanned = await scanSingleFile(options.identity.gitRoot, path, options.config)
      if (scanned) files.push(scanned)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        options.logger.warn('failed to scan dependency for code relationship refresh', { path, error: (error as Error).message })
      }
    }
  }
  return files
}

function deleteGraphForFilePaths(db: CodeIntelligenceDb, repoKey: string, paths: string[]): void {
  deleteCodeRelationshipsForFilePaths(db, repoKey, paths)
  deleteFileRelationshipsForFilePaths(db, repoKey, paths)
  deleteEntitiesForFilePaths(db, repoKey, paths)
}

function indexScannedFile(
  options: {
    identity: RepoIdentity
    db: CodeIntelligenceDb
    config: CodeIntelligenceConfig
  },
  file: ScannedFile,
  activePaths: Set<string>
): { skippedUnchanged: boolean; insertedChunks: InsertedChunk[]; entityCount: number; relationshipCount: number } {
  const packageKey = packageKeyForPath(file.relativePath, options.config)
  const result = upsertIndexedFile(options.db, {
    repoKey: options.identity.repoKey,
    packageKey,
    path: file.relativePath,
    language: file.language,
    fileHash: file.fileHash,
    sizeBytes: file.sizeBytes,
    isGenerated: file.generated.isGenerated,
    generatedReason: file.generated.reason,
  })

  if (result.skippedUnchanged) return { skippedUnchanged: true, insertedChunks: [], entityCount: 0, relationshipCount: 0 }

  const chunks = chunkFile({ path: file.relativePath, language: file.language, content: file.content }).map((chunk) => ({
    repoKey: options.identity.repoKey,
    fileId: result.id,
    path: file.relativePath,
    packageKey,
    language: file.language,
    chunkKind: chunk.chunkKind,
    symbolName: chunk.symbolName,
    symbolKind: chunk.symbolKind,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    content: chunk.content,
    contentHash: chunk.contentHash,
  }))

  const entities = extractEntitiesForFile({ repoKey: options.identity.repoKey, fileId: result.id, path: file.relativePath, packageKey, language: file.language, content: file.content })
  const entityRows = replaceEntitiesForFile(options.db, options.identity.repoKey, file.relativePath, entities)
  const fileRelationships = extractFileRelationshipsForFile({ repoKey: options.identity.repoKey, path: file.relativePath, content: file.content, activePaths, config: options.config })
  replaceFileRelationshipsForFile(options.db, options.identity.repoKey, file.relativePath, fileRelationships)
  const referencedNames = extractReferencedNamesForFile({ content: file.content, entities: entityRows })
  const candidateEntities = findEntitiesByName(options.db, options.identity.repoKey, referencedNames, 100)
  const codeRelationships = extractCodeRelationshipsForFile({ repoKey: options.identity.repoKey, path: file.relativePath, content: file.content, entities: entityRows, candidateEntities })
  replaceCodeRelationshipsForFile(options.db, options.identity.repoKey, file.relativePath, codeRelationships)

  return { skippedUnchanged: false, insertedChunks: replaceChunksForFile(options.db, result.id, chunks), entityCount: entities.length, relationshipCount: fileRelationships.length + codeRelationships.length }
}

function refreshCodeRelationshipsForScannedFiles(
  options: { identity: RepoIdentity; db: CodeIntelligenceDb },
  files: ScannedFile[]
): number {
  let relationshipCount = 0
  for (const file of files) {
    const localEntities = listEntitiesForPath(options.db, options.identity.repoKey, file.relativePath)
    const referencedNames = extractReferencedNamesForFile({ content: file.content, entities: localEntities })
    const candidateEntities = findEntitiesByName(options.db, options.identity.repoKey, referencedNames, 100)
    const codeRelationships = extractCodeRelationshipsForFile({ repoKey: options.identity.repoKey, path: file.relativePath, content: file.content, entities: localEntities, candidateEntities })
    replaceCodeRelationshipsForFile(options.db, options.identity.repoKey, file.relativePath, codeRelationships)
    relationshipCount += codeRelationships.length
  }
  return relationshipCount
}

export async function runFullRepoIndex(options: {
  identity: RepoIdentity
  db: CodeIntelligenceDb
  config: CodeIntelligenceConfig
  logger: CodeIntelligenceLogger
  embeddingService?: EmbeddingService
}, reason = 'manual'): Promise<FullIndexResult> {
  const startedAt = new Date().toISOString()
  options.logger.info('full repo index started', { repoKey: options.identity.repoKey, reason })
  updateIndexProgress(options.db, { repoKey: options.identity.repoKey, phase: 'scanning', filesScanned: 0, startedAt })

  const scan = await scanRepoFiles(options.identity.gitRoot, options.config)
  const seenPaths = new Set<string>()
  let insertedOrChanged = 0
  let skippedUnchanged = 0
  let generated = 0
  let chunksIndexed = 0
  let entitiesExtracted = 0
  const insertedChunksForEmbedding: InsertedChunk[] = []

  const activePaths = new Set(scan.files.map((file) => file.relativePath))
  let relationshipsExtracted = 0
  for (let index = 0; index < scan.files.length; index += 1) {
    const file = scan.files[index]!
    updateIndexProgress(options.db, { repoKey: options.identity.repoKey, phase: 'chunking', currentPath: file.relativePath, filesScanned: index + 1, startedAt })
    seenPaths.add(file.relativePath)
    if (file.generated.isGenerated) generated += 1
    const packageKey = packageKeyForPath(file.relativePath, options.config)
    const result = upsertIndexedFile(options.db, {
      repoKey: options.identity.repoKey,
      packageKey,
      path: file.relativePath,
      language: file.language,
      fileHash: file.fileHash,
      sizeBytes: file.sizeBytes,
      isGenerated: file.generated.isGenerated,
      generatedReason: file.generated.reason,
    })
    if (result.skippedUnchanged) {
      skippedUnchanged += 1
    } else if (result.changed) {
      insertedOrChanged += 1
      updateIndexProgress(options.db, { repoKey: options.identity.repoKey, phase: 'graph extraction', currentPath: file.relativePath, filesScanned: index + 1, startedAt })
      const entities = extractEntitiesForFile({ repoKey: options.identity.repoKey, fileId: result.id, path: file.relativePath, packageKey, language: file.language, content: file.content })
      const entityRows = replaceEntitiesForFile(options.db, options.identity.repoKey, file.relativePath, entities)
      const fileRelationships = extractFileRelationshipsForFile({ repoKey: options.identity.repoKey, path: file.relativePath, content: file.content, activePaths, config: options.config })
      replaceFileRelationshipsForFile(options.db, options.identity.repoKey, file.relativePath, fileRelationships)
      const referencedNames = extractReferencedNamesForFile({ content: file.content, entities: entityRows })
      const candidateEntities = findEntitiesByName(options.db, options.identity.repoKey, referencedNames, 100)
      const codeRelationships = extractCodeRelationshipsForFile({ repoKey: options.identity.repoKey, path: file.relativePath, content: file.content, entities: entityRows, candidateEntities })
      replaceCodeRelationshipsForFile(options.db, options.identity.repoKey, file.relativePath, codeRelationships)
      entitiesExtracted += entities.length
      relationshipsExtracted += fileRelationships.length + codeRelationships.length
      updateIndexProgress(options.db, { repoKey: options.identity.repoKey, phase: 'graph extraction', currentPath: file.relativePath, filesScanned: index + 1, entitiesExtracted, relationshipsExtracted, startedAt })
      const chunks = chunkFile({ path: file.relativePath, language: file.language, content: file.content }).map((chunk) => ({
        repoKey: options.identity.repoKey,
        fileId: result.id,
        path: file.relativePath,
        packageKey,
        language: file.language,
        chunkKind: chunk.chunkKind,
        symbolName: chunk.symbolName,
        symbolKind: chunk.symbolKind,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.content,
        contentHash: chunk.contentHash,
      }))
      const insertedChunks = replaceChunksForFile(options.db, result.id, chunks)
      chunksIndexed += insertedChunks.length
      insertedChunksForEmbedding.push(...insertedChunks)
    }
    if (index % 10 === 9) await yieldToEventLoop()
  }

  relationshipsExtracted += refreshCodeRelationshipsForScannedFiles({ identity: options.identity, db: options.db }, scan.files)
  updateIndexProgress(options.db, { repoKey: options.identity.repoKey, phase: 'graph extraction', currentPath: null, filesScanned: scan.files.length, entitiesExtracted, relationshipsExtracted, startedAt })

  const missingPaths = findMissingActiveFilePaths(options.db, options.identity.repoKey, seenPaths)
  const excludedActivePaths = findActiveFilePaths(options.db, options.identity.repoKey).filter((path) => !shouldIncludePath(path, options.config))
  const cleanupPaths = [...new Set([...missingPaths, ...excludedActivePaths])]
  const deleted = markMissingFilesDeleted(options.db, options.identity.repoKey, seenPaths) + markDeletedPaths(options.db, options.identity.repoKey, excludedActivePaths)
  deleteGraphForFilePaths(options.db, options.identity.repoKey, cleanupPaths)
  deleteChunksForFilePaths(options.db, options.identity.repoKey, cleanupPaths)
  pruneDeletedFileRows(options.db, options.identity.repoKey, deletedFilePruneCutoff())
  updateIndexProgress(options.db, { repoKey: options.identity.repoKey, phase: 'embedding', currentPath: null, filesScanned: scan.files.length, startedAt })
  const embeddingsIndexed = options.embeddingService
    ? await embedChunksIncremental(
        options.db,
        options.embeddingService,
        insertedChunksForEmbedding,
        options.config.embedding.batchSize
      )
    : 0
  if (embeddingsIndexed > 0) {
    relationshipsExtracted += refreshSimilarRelationshipsForRepo(options.db, options.identity.repoKey)
    updateIndexProgress(options.db, { repoKey: options.identity.repoKey, phase: 'graph extraction', currentPath: null, filesScanned: scan.files.length, entitiesExtracted, relationshipsExtracted, startedAt })
  }

  const completedAt = new Date().toISOString()
  markFullIndexCompleted(options.db, options.identity.repoKey, completedAt)

  const result: FullIndexResult = {
    scanned: scan.files.length,
    insertedOrChanged,
    skippedUnchanged,
    deleted,
    generated,
    chunksIndexed,
    embeddingsIndexed,
    summary: scan.summary,
    startedAt,
    completedAt,
  }
  options.logger.info('full repo index completed', result)
  return result
}

async function readLockPid(lockDir: string): Promise<number | undefined> {
  try {
    const value = Number.parseInt(await readFile(join(lockDir, 'pid'), 'utf8'), 10)
    return Number.isFinite(value) ? value : undefined
  } catch {
    return undefined
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function safeKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {}
}

function parseParentPid(command: string): number | undefined {
  const match = command.match(/(?:^|\s)--parent-pid=(\d+)(?:\s|$)/)
  if (!match) return undefined
  const pid = Number.parseInt(match[1] ?? '', 10)
  return Number.isFinite(pid) ? pid : undefined
}

function deletedFilePruneCutoff(): string {
  return new Date(Date.now() - DELETED_FILE_PRUNE_AGE_MS).toISOString()
}

function emptyFullIndexResult(): FullIndexResult {
  const now = new Date().toISOString()
  return {
    scanned: 0,
    insertedOrChanged: 0,
    skippedUnchanged: 0,
    deleted: 0,
    generated: 0,
    chunksIndexed: 0,
    embeddingsIndexed: 0,
    summary: { scanned: 0, skipped: 0, skippedTooLarge: 0, skippedBinary: 0, skippedIgnored: 0 },
    startedAt: now,
    completedAt: now,
  }
}

function emptyIncrementalIndexResult(): IncrementalIndexResult {
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
