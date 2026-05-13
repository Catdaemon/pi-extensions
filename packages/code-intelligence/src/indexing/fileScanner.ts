import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { CodeIntelligenceConfig } from '../config.ts'
import { detectGeneratedFile, type GeneratedDetection } from './generated.ts'
import { matchesAnyGlob, normalizeRelativePath } from './glob.ts'
import { sha256Buffer } from './hash.ts'
import { yieldToEventLoop } from '../lib/async.ts'
import { detectLanguage, isLikelyBinaryBuffer, isLikelyBinaryPath } from './language.ts'

export type ScannedFile = {
  absolutePath: string
  relativePath: string
  language?: string
  fileHash: string
  sizeBytes: number
  content: string
  generated: GeneratedDetection
}

export type ScanSummary = {
  scanned: number
  skipped: number
  skippedTooLarge: number
  skippedBinary: number
  skippedIgnored: number
}

export type ScanResult = {
  files: ScannedFile[]
  summary: ScanSummary
}

export async function scanSingleFile(
  repoRoot: string,
  relativePath: string,
  config: CodeIntelligenceConfig
): Promise<ScannedFile | undefined> {
  const normalizedRelativePath = normalizeRelativePath(relativePath)
  const absolutePath = join(repoRoot, normalizedRelativePath)

  if (!shouldIncludePath(normalizedRelativePath, config)) return undefined
  if (isLikelyBinaryPath(normalizedRelativePath)) return undefined

  const fileStat = await stat(absolutePath)
  if (!fileStat.isFile()) return undefined
  return scanKnownFile(repoRoot, normalizedRelativePath, absolutePath, fileStat.size, config)
}

export async function scanRepoFiles(repoRoot: string, config: CodeIntelligenceConfig): Promise<ScanResult> {
  const files: ScannedFile[] = []
  const summary: ScanSummary = {
    scanned: 0,
    skipped: 0,
    skippedTooLarge: 0,
    skippedBinary: 0,
    skippedIgnored: 0,
  }

  let visitedEntries = 0
  await walkDirectory(repoRoot, '', config, files, summary, createScanLimiter(config.indexing.scanConcurrency), () => {
    visitedEntries += 1
    return visitedEntries
  })
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  return { files, summary }
}

export function shouldIncludePath(relativePath: string, config: Pick<CodeIntelligenceConfig, 'include' | 'exclude'>): boolean {
  const rel = normalizeRelativePath(relativePath)
  if (!rel || matchesAnyGlob(rel, config.exclude)) return false
  return config.include.length === 0 || matchesAnyGlob(rel, config.include)
}

export function shouldPruneDirectory(relativePath: string, config: Pick<CodeIntelligenceConfig, 'exclude'>): boolean {
  const rel = normalizeRelativePath(relativePath)
  return Boolean(rel) && matchesAnyGlob(rel, config.exclude)
}

async function walkDirectory(
  repoRoot: string,
  relativeDir: string,
  config: CodeIntelligenceConfig,
  files: ScannedFile[],
  summary: ScanSummary,
  scanLimiter: ScanLimiter,
  nextVisitedCount: () => number
): Promise<void> {
  const absoluteDir = join(repoRoot, relativeDir)
  const entries = await readdir(absoluteDir, { withFileTypes: true })

  for (const entry of entries) {
    if (nextVisitedCount() % 50 === 0) await yieldToEventLoop()
    const relativePath = normalizeRelativePath(join(relativeDir, entry.name))
    const absolutePath = join(repoRoot, relativePath)

    if (entry.isDirectory()) {
      if (shouldPruneDirectory(relativePath, config)) {
        summary.skippedIgnored += 1
        continue
      }
      await walkDirectory(repoRoot, relativePath, config, files, summary, scanLimiter, nextVisitedCount)
      continue
    }

    if (!entry.isFile()) continue

    if (!shouldIncludePath(relativePath, config)) {
      summary.skipped += 1
      if (matchesAnyGlob(relativePath, config.exclude)) summary.skippedIgnored += 1
      continue
    }

    if (isLikelyBinaryPath(relativePath)) {
      summary.skipped += 1
      summary.skippedBinary += 1
      continue
    }

    const fileStat = await stat(absolutePath)
    if (fileStat.size > config.maxFileBytes) {
      summary.skipped += 1
      summary.skippedTooLarge += 1
      continue
    }

    void scanLimiter.run(async () => {
      const scanned = await scanKnownFile(repoRoot, relativePath, absolutePath, fileStat.size, config)
      if (!scanned) {
        summary.skipped += 1
        summary.skippedBinary += 1
        return
      }
      files.push(scanned)
      summary.scanned += 1
    })
  }

  await scanLimiter.drain()
}

type ScanLimiter = {
  run<T>(task: () => Promise<T>): Promise<T>
  drain(): Promise<void>
}

function createScanLimiter(concurrency: number): ScanLimiter {
  const limit = Math.max(1, Math.trunc(concurrency || 1))
  const active = new Set<Promise<unknown>>()

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      while (active.size >= limit) await Promise.race(active)
      const promise = task().finally(() => active.delete(promise))
      active.add(promise)
      return promise
    },
    async drain(): Promise<void> {
      while (active.size > 0) await Promise.all([...active])
    },
  }
}

async function scanKnownFile(
  repoRoot: string,
  relativePath: string,
  absolutePath: string,
  sizeBytes: number,
  config: CodeIntelligenceConfig
): Promise<ScannedFile | undefined> {
  if (sizeBytes > config.maxFileBytes) return undefined

  const buffer = await readFile(absolutePath)
  if (isLikelyBinaryBuffer(buffer)) return undefined

  const normalizedRelativePath = normalizeRelativePath(relativePath)
  const content = buffer.toString('utf8')
  return {
    absolutePath,
    relativePath: normalizeRelativePath(relative(repoRoot, absolutePath)),
    language: detectLanguage(normalizedRelativePath),
    fileHash: sha256Buffer(buffer),
    sizeBytes,
    content,
    generated: detectGeneratedFile(normalizedRelativePath, content, config),
  }
}

