import type { CodeIntelligenceDb } from '../db/connection.ts'
import { findEntityPathsByQuery, listEntitiesForPath, type CodeEntityRow } from '../db/repositories/entitiesRepo.ts'
import {
  listFileRelationshipsForPath,
  listIncomingFileRelationshipsForPath,
} from '../db/repositories/fileRelationshipsRepo.ts'
import {
  listCodeRelationshipsForPath,
  listIncomingCodeRelationshipsForPath,
} from '../db/repositories/relationshipsRepo.ts'

export type GraphFileSummary = {
  path: string
  declarations: Array<{ name: string; kind: string; startLine?: number; exported: boolean }>
  imports: string[]
  importedBy: string[]
  tests: string[]
  counterparts: string[]
  routeScreens: string[]
  sameFeature: string[]
  calls: string[]
  calledBy: string[]
  renders: string[]
  hooks: string[]
  similar: string[]
}

export type ImpactContext = {
  changedFiles: string[]
  directlyRelatedFiles: string[]
  impactedFiles: string[]
  testFiles: string[]
  summaries: GraphFileSummary[]
}

export type ReviewContext = ImpactContext & {
  query?: string
  coverage: Array<{
    file: string
    hasGraphContext: boolean
    hasTestsOrCounterparts: boolean
    inspectedRelatedFiles: string[]
  }>
}

export type GraphEdgeDetails = {
  path: string
  declarations: GraphFileSummary['declarations']
  fileEdges: Array<{ kind: string; direction: 'outgoing' | 'incoming'; sourcePath: string; targetPath: string }>
  codeEdges: Array<{ kind: string; direction: 'outgoing' | 'incoming'; sourcePath: string; sourceName?: string; targetPath?: string; targetName?: string }>
}

export function retrieveImpactContextForDiff(
  db: CodeIntelligenceDb,
  repoKey: string,
  changedFiles: string[],
  options: { maxFiles?: number; maxItemsPerSection?: number; maxRelatedFiles?: number } = {}
): ImpactContext {
  const maxRelatedFiles = Math.max(1, options.maxRelatedFiles ?? 40)
  const changed = [...new Set(changedFiles)].filter(Boolean)
  const seedSummaries = retrieveGraphContextForFiles(db, repoKey, changed, options)
  const directlyRelatedFiles = unique([
    ...seedSummaries.flatMap((summary) => [
      ...summary.imports,
      ...summary.importedBy,
      ...summary.tests,
      ...summary.counterparts,
      ...summary.routeScreens,
      ...summary.sameFeature,
      ...summary.similar,
    ]),
  ]).slice(0, maxRelatedFiles)
  const summaries = retrieveGraphContextForFiles(db, repoKey, unique([...changed, ...directlyRelatedFiles]), options)
  const summaryByPath = new Map(summaries.map((summary) => [summary.path, summary]))
  const impactedFiles = unique([
    ...directlyRelatedFiles,
    ...summaries.flatMap((summary) => [...summary.importedBy, ...summary.calledBy.map(endpointPath)]),
  ].filter((path): path is string => typeof path === 'string' && path.length > 0 && !changed.includes(path))).slice(0, maxRelatedFiles)
  const testFiles = unique(summaries.flatMap((summary) => [...summary.tests, ...summary.counterparts]).filter((path): path is string => typeof path === 'string' && path.length > 0))
  return {
    changedFiles: changed,
    directlyRelatedFiles,
    impactedFiles,
    testFiles,
    summaries: unique([...changed, ...directlyRelatedFiles, ...impactedFiles]).map((path) => summaryByPath.get(path)).filter((summary): summary is GraphFileSummary => Boolean(summary)),
  }
}

export function retrieveReviewContext(
  db: CodeIntelligenceDb,
  repoKey: string,
  input: { changedFiles: string[]; query?: string; seedPaths?: string[] },
  options: { maxFiles?: number; maxItemsPerSection?: number; maxRelatedFiles?: number } = {}
): ReviewContext {
  const querySummaries = input.query ? retrieveGraphContextForQuery(db, repoKey, input.query, input.seedPaths ?? [], options) : []
  const impact = retrieveImpactContextForDiff(db, repoKey, unique([...input.changedFiles, ...(input.seedPaths ?? []), ...querySummaries.map((summary) => summary.path)]), options)
  const summaryByPath = new Map(impact.summaries.map((summary) => [summary.path, summary]))
  return {
    ...impact,
    query: input.query,
    coverage: impact.changedFiles.map((file) => {
      const summary = summaryByPath.get(file)
      return {
        file,
        hasGraphContext: Boolean(summary && hasGraphData(summary)),
        hasTestsOrCounterparts: Boolean(summary && (summary.tests.length > 0 || summary.counterparts.length > 0)),
        inspectedRelatedFiles: summary ? unique([...summary.imports, ...summary.importedBy, ...summary.tests, ...summary.counterparts, ...summary.sameFeature, ...summary.similar]) : [],
      }
    }),
  }
}

export function retrieveGraphContextForQuery(
  db: CodeIntelligenceDb,
  repoKey: string,
  query: string,
  seedPaths: string[] = [],
  options: { maxFiles?: number; maxItemsPerSection?: number } = {}
): GraphFileSummary[] {
  const maxFiles = Math.max(1, options.maxFiles ?? 10)
  const queryPaths = findEntityPathsByQuery(db, repoKey, query, maxFiles)
  return retrieveGraphContextForFiles(db, repoKey, [...seedPaths, ...queryPaths], options)
}

export function retrieveGraphContextForFiles(
  db: CodeIntelligenceDb,
  repoKey: string,
  paths: string[],
  options: { maxFiles?: number; maxItemsPerSection?: number } = {}
): GraphFileSummary[] {
  const maxFiles = Math.max(1, options.maxFiles ?? 10)
  const maxItems = Math.max(1, Math.min(options.maxItemsPerSection ?? 8, 25))
  return [...new Set(paths)].slice(0, maxFiles).map((path) => summarizeGraphForFile(db, repoKey, path, maxItems))
}

export function retrieveGraphEdgeDetailsForFiles(
  db: CodeIntelligenceDb,
  repoKey: string,
  paths: string[],
  options: { maxFiles?: number; maxEdgesPerFile?: number } = {}
): GraphEdgeDetails[] {
  const maxFiles = Math.max(1, options.maxFiles ?? 10)
  const maxEdges = Math.max(1, Math.min(options.maxEdgesPerFile ?? 40, 100))
  return [...new Set(paths)].slice(0, maxFiles).map((path) => {
    const outgoing = listFileRelationshipsForPath(db, repoKey, path)
    const incoming = listIncomingFileRelationshipsForPath(db, repoKey, path)
    const outgoingCode = listCodeRelationshipsForPath(db, repoKey, path)
    const incomingCode = listIncomingCodeRelationshipsForPath(db, repoKey, path)
    return {
      path,
      declarations: listEntitiesForPath(db, repoKey, path).filter(isDeclarationEntity).map((entity) => ({
        name: entity.name,
        kind: entity.kind,
        startLine: entity.start_line ?? undefined,
        exported: entity.exported === 1,
      })),
      fileEdges: [
        ...outgoing.map((rel) => ({ kind: rel.kind, direction: 'outgoing' as const, sourcePath: rel.sourcePath, targetPath: rel.targetPath })),
        ...incoming.map((rel) => ({ kind: rel.kind, direction: 'incoming' as const, sourcePath: rel.sourcePath, targetPath: rel.targetPath })),
      ].slice(0, maxEdges),
      codeEdges: [
        ...outgoingCode.map((rel) => ({ kind: rel.kind, direction: 'outgoing' as const, sourcePath: rel.sourcePath, sourceName: rel.sourceName ?? undefined, targetPath: rel.targetPath ?? undefined, targetName: rel.targetName ?? undefined })),
        ...incomingCode.map((rel) => ({ kind: rel.kind, direction: 'incoming' as const, sourcePath: rel.sourcePath, sourceName: rel.sourceName ?? undefined, targetPath: rel.targetPath ?? undefined, targetName: rel.targetName ?? undefined })),
      ].slice(0, maxEdges),
    }
  })
}

export function summarizeGraphForFile(db: CodeIntelligenceDb, repoKey: string, path: string, maxItems = 8): GraphFileSummary {
  const entities = listEntitiesForPath(db, repoKey, path)
  const outgoing = listFileRelationshipsForPath(db, repoKey, path)
  const incoming = listIncomingFileRelationshipsForPath(db, repoKey, path)
  const outgoingCode = listCodeRelationshipsForPath(db, repoKey, path)
  const incomingCode = listIncomingCodeRelationshipsForPath(db, repoKey, path)
  return {
    path,
    declarations: entities.filter(isDeclarationEntity).slice(0, maxItems).map((entity) => ({
      name: entity.name,
      kind: entity.kind,
      startLine: entity.start_line ?? undefined,
      exported: entity.exported === 1,
    })),
    imports: outgoing.filter((rel) => rel.kind === 'imports').map((rel) => rel.targetPath).slice(0, maxItems),
    importedBy: incoming.filter((rel) => rel.kind === 'imports').map((rel) => rel.sourcePath).slice(0, maxItems),
    tests: relatedPaths(outgoing, incoming, 'test_counterpart', path, maxItems),
    counterparts: relatedPaths(outgoing, incoming, 'test_counterpart', path, maxItems),
    routeScreens: relatedPaths(outgoing, incoming, 'route_screen', path, maxItems),
    sameFeature: relatedPaths(outgoing, incoming, 'same_feature', path, maxItems),
    calls: codeTargets(outgoingCode, ['calls', 'constructs'], maxItems),
    calledBy: codeSources(incomingCode, ['calls', 'constructs'], maxItems),
    renders: codeTargets(outgoingCode, ['renders'], maxItems),
    hooks: codeTargets(outgoingCode, ['uses_hook'], maxItems),
    similar: relatedCodePaths(outgoingCode, incomingCode, 'similar_to', path, maxItems),
  }
}

export function formatGraphEdgeDetails(details: GraphEdgeDetails[]): string {
  const useful = details.filter((detail) => detail.declarations.length > 0 || detail.fileEdges.length > 0 || detail.codeEdges.length > 0)
  if (useful.length === 0) return ''
  const lines = ['## Graph Edge Details']
  for (const detail of useful) {
    lines.push('', `### ${detail.path}`)
    if (detail.declarations.length > 0) lines.push(`Declarations: ${detail.declarations.map((item) => `${item.exported ? 'export ' : ''}${item.kind} ${item.name}${item.startLine ? `:${item.startLine}` : ''}`).join(', ')}`)
    if (detail.fileEdges.length > 0) {
      lines.push('File edges:')
      for (const edge of detail.fileEdges.slice(0, 20)) lines.push(`- ${edge.direction} ${edge.kind}: ${edge.sourcePath} -> ${edge.targetPath}`)
    }
    if (detail.codeEdges.length > 0) {
      lines.push('Code edges:')
      for (const edge of detail.codeEdges.slice(0, 20)) lines.push(`- ${edge.direction} ${edge.kind}: ${formatCodeEndpoint(edge.sourcePath, edge.sourceName ?? null)} -> ${formatCodeEndpoint(edge.targetPath ?? null, edge.targetName ?? null)}`)
    }
  }
  return lines.join('\n')
}

export function formatGraphContextSummary(summaries: GraphFileSummary[]): string {
  const useful = summaries.filter(hasGraphData)
  if (useful.length === 0) return ''
  const lines = ['## Graph Summary']
  for (const summary of useful) {
    lines.push('', `### ${summary.path}`)
    if (summary.declarations.length > 0) lines.push(`Declarations: ${summary.declarations.map((item) => `${item.exported ? 'export ' : ''}${item.kind} ${item.name}${item.startLine ? `:${item.startLine}` : ''}`).join(', ')}`)
    if (summary.imports.length > 0) lines.push(`Imports: ${summary.imports.join(', ')}`)
    if (summary.importedBy.length > 0) lines.push(`Imported by: ${summary.importedBy.join(', ')}`)
    if (summary.tests.length > 0) lines.push(`Tests/counterparts: ${summary.tests.join(', ')}`)
    if (summary.routeScreens.length > 0) lines.push(`Route/screens: ${summary.routeScreens.join(', ')}`)
    if (summary.sameFeature.length > 0) lines.push(`Same feature: ${summary.sameFeature.join(', ')}`)
    if (summary.calls.length > 0) lines.push(`Calls/constructs: ${summary.calls.join(', ')}`)
    if (summary.calledBy.length > 0) lines.push(`Called by: ${summary.calledBy.join(', ')}`)
    if (summary.renders.length > 0) lines.push(`Renders: ${summary.renders.join(', ')}`)
    if (summary.hooks.length > 0) lines.push(`Hooks: ${summary.hooks.join(', ')}`)
    if (summary.similar.length > 0) lines.push(`Similar patterns: ${summary.similar.join(', ')}`)
  }
  return lines.join('\n')
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function endpointPath(endpoint: string): string | undefined {
  const path = endpoint.split('#')[0]?.trim()
  return path || undefined
}

function relatedPaths(outgoing: Array<{ sourcePath: string; targetPath: string; kind: string }>, incoming: Array<{ sourcePath: string; targetPath: string; kind: string }>, kind: string, path: string, maxItems: number): string[] {
  return [...new Set([
    ...outgoing.filter((rel) => rel.kind === kind).map((rel) => rel.targetPath),
    ...incoming.filter((rel) => rel.kind === kind).map((rel) => rel.sourcePath),
  ].filter((candidate) => candidate !== path))].slice(0, maxItems)
}

function codeTargets(rels: Array<{ targetPath: string | null; targetName: string | null; kind: string }>, kinds: string[], maxItems: number): string[] {
  return [...new Set(rels.filter((rel) => kinds.includes(rel.kind)).map((rel) => formatCodeEndpoint(rel.targetPath, rel.targetName)))].filter(Boolean).slice(0, maxItems)
}

function codeSources(rels: Array<{ sourcePath: string; sourceName: string | null; kind: string }>, kinds: string[], maxItems: number): string[] {
  return [...new Set(rels.filter((rel) => kinds.includes(rel.kind)).map((rel) => formatCodeEndpoint(rel.sourcePath, rel.sourceName)))].filter(Boolean).slice(0, maxItems)
}

function relatedCodePaths(outgoing: Array<{ sourcePath: string; targetPath: string | null; kind: string }>, incoming: Array<{ sourcePath: string; targetPath: string | null; kind: string }>, kind: string, path: string, maxItems: number): string[] {
  return [...new Set([
    ...outgoing.filter((rel) => rel.kind === kind).map((rel) => rel.targetPath),
    ...incoming.filter((rel) => rel.kind === kind).map((rel) => rel.sourcePath),
  ].filter((candidate): candidate is string => Boolean(candidate) && candidate !== path))].slice(0, maxItems)
}

function formatCodeEndpoint(path: string | null, name: string | null): string {
  return [path, name].filter(Boolean).join('#')
}

function isDeclarationEntity(entity: CodeEntityRow): boolean {
  return entity.kind !== 'module'
}

function hasGraphData(summary: GraphFileSummary): boolean {
  return summary.declarations.length + summary.imports.length + summary.importedBy.length + summary.tests.length + summary.routeScreens.length + summary.sameFeature.length + summary.calls.length + summary.calledBy.length + summary.renders.length + summary.hooks.length + summary.similar.length > 0
}
