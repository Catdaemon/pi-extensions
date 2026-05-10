import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { CodeIntelligenceConfig } from '../config.ts'
import { detectGeneratedFile, type GeneratedDetection } from './generated.ts'
import { matchesAnyGlob, normalizeRelativePath } from './glob.ts'
import { sha256Buffer } from './hash.ts'
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
  if (fileStat.size > config.maxFileBytes) return undefined

  const buffer = await readFile(absolutePath)
  if (isLikelyBinaryBuffer(buffer)) return undefined

  const content = buffer.toString('utf8')
  return {
    absolutePath,
    relativePath: normalizeRelativePath(relative(repoRoot, absolutePath)),
    language: detectLanguage(normalizedRelativePath),
    fileHash: sha256Buffer(buffer),
    sizeBytes: fileStat.size,
    content,
    generated: detectGeneratedFile(normalizedRelativePath, content, config),
  }
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
  await walkDirectory(repoRoot, '', config, files, summary, () => {
    visitedEntries += 1
    return visitedEntries
  })
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
      await walkDirectory(repoRoot, relativePath, config, files, summary, nextVisitedCount)
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

    const scanned = await scanSingleFile(repoRoot, relativePath, config)
    if (!scanned) {
      summary.skipped += 1
      summary.skippedBinary += 1
      continue
    }

    files.push(scanned)
    summary.scanned += 1
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
