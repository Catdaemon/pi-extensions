import { dirname, extname, join, normalize } from 'node:path'
import type { CodeIntelligenceConfig } from '../config.ts'
import type { FileRelationshipInput } from '../db/repositories/fileRelationshipsRepo.ts'
import { findSourceTestCounterparts } from '../pi/planningIntegration.ts'
import { extractImportsForFile } from './entityExtractor.ts'

const RESOLVABLE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json']

export function extractFileRelationshipsForFile(input: {
  repoKey: string
  path: string
  content: string
  activePaths: Set<string>
  config: Pick<CodeIntelligenceConfig, 'testPaths'>
}): FileRelationshipInput[] {
  const relationships: FileRelationshipInput[] = []
  const seen = new Set<string>()

  for (const imported of extractImportsForFile({ path: input.path, content: input.content })) {
    const targetPath = resolveImportPath(input.path, imported.source, input.activePaths)
    if (!targetPath) continue
    pushUnique(relationships, seen, {
      repoKey: input.repoKey,
      sourcePath: input.path,
      targetPath,
      kind: 'imports',
      confidence: 1,
      metadata: imported,
    })
  }

  for (const counterpart of findSourceTestCounterparts([input.path], input.config)) {
    if (!input.activePaths.has(counterpart)) continue
    pushUnique(relationships, seen, {
      repoKey: input.repoKey,
      sourcePath: input.path,
      targetPath: counterpart,
      kind: 'test_counterpart',
      confidence: 0.8,
    })
  }

  addRouteScreenRelationship(input, relationships, seen)
  addSameFeatureRelationships(input, relationships, seen)
  return relationships
}

export function resolveImportPath(sourcePath: string, specifier: string, activePaths: Set<string>): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const base = normalize(join(dirname(sourcePath), specifier)).replace(/\\/g, '/')
  const candidates = buildImportCandidates(base)
  return candidates.find((candidate) => activePaths.has(candidate))
}

function buildImportCandidates(base: string): string[] {
  const ext = extname(base)
  const candidates: string[] = []
  if (ext) candidates.push(base)
  else {
    for (const candidateExt of RESOLVABLE_EXTENSIONS) candidates.push(`${base}${candidateExt}`)
    for (const candidateExt of RESOLVABLE_EXTENSIONS) candidates.push(`${base}/index${candidateExt}`)
  }
  return candidates.map((candidate) => candidate.replace(/^\.\//, ''))
}

function addRouteScreenRelationship(
  input: { repoKey: string; path: string; content: string; activePaths: Set<string> },
  relationships: FileRelationshipInput[],
  seen: Set<string>
): void {
  if (!/(^|\/)app\//.test(input.path) && !/(^|\/)pages\//.test(input.path)) return
  for (const imported of extractImportsForFile({ path: input.path, content: input.content })) {
    const targetPath = resolveImportPath(input.path, imported.source, input.activePaths)
    if (!targetPath) continue
    if (!/(Screen|screens\/|features\/)/.test(targetPath)) continue
    pushUnique(relationships, seen, {
      repoKey: input.repoKey,
      sourcePath: input.path,
      targetPath,
      kind: 'route_screen',
      confidence: 0.8,
      metadata: { importSource: imported.source },
    })
  }
}

function addSameFeatureRelationships(
  input: { repoKey: string; path: string; activePaths: Set<string> },
  relationships: FileRelationshipInput[],
  seen: Set<string>
): void {
  const featureRoot = featureRootForPath(input.path)
  if (!featureRoot) return
  let added = 0
  for (const candidate of input.activePaths) {
    if (candidate === input.path) continue
    if (!candidate.startsWith(`${featureRoot}/`)) continue
    pushUnique(relationships, seen, {
      repoKey: input.repoKey,
      sourcePath: input.path,
      targetPath: candidate,
      kind: 'same_feature',
      confidence: 0.5,
    })
    added += 1
    if (added >= 10) break
  }
}

function featureRootForPath(path: string): string | undefined {
  const parts = path.split('/')
  const featureIndex = parts.findIndex((part) => part === 'features')
  if (featureIndex >= 0 && parts[featureIndex + 1]) return parts.slice(0, featureIndex + 2).join('/')
  return undefined
}

function pushUnique(items: FileRelationshipInput[], seen: Set<string>, item: FileRelationshipInput): void {
  const key = `${item.sourcePath}|${item.targetPath}|${item.kind}`
  if (seen.has(key)) return
  seen.add(key)
  items.push(item)
}
