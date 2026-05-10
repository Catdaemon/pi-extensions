import type { CodeEntityRow } from '../db/repositories/entitiesRepo.ts'
import type { CodeRelationshipInput } from '../db/repositories/relationshipsRepo.ts'
import { extractImportsForFile } from './entityExtractor.ts'

const RESERVED_CALLS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'await', 'new'])
const BUILTIN_CALLS = new Set(['console', 'Math', 'String', 'Number', 'Boolean', 'Object', 'Array', 'JSON', 'Promise', 'Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'])

export function extractReferencedNamesForFile(input: { content: string; entities?: CodeEntityRow[] }): string[] {
  const names = new Set<string>()
  for (const match of input.content.matchAll(/<([A-Z][A-Za-z0-9_$]*(?:\.[A-Z][A-Za-z0-9_$]*)?)(?=[\s/>])/g)) names.add(match[1]!.split('.')[0]!)
  for (const match of input.content.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1]!
    if (!RESERVED_CALLS.has(name) && !BUILTIN_CALLS.has(name)) names.add(name)
  }
  for (const match of input.content.matchAll(/\bnew\s+([A-Za-z_$][\w$]*)\s*\(/g)) names.add(match[1]!)
  for (const entity of input.entities ?? []) names.delete(entity.name)
  return [...names].slice(0, 100)
}

export function extractCodeRelationshipsForFile(input: {
  repoKey: string
  path: string
  content: string
  entities: CodeEntityRow[]
  candidateEntities?: CodeEntityRow[]
}): CodeRelationshipInput[] {
  const lines = splitLines(input.content)
  const byName = buildEntityLookup(input.entities, input.candidateEntities ?? [])
  const importedNames = new Set<string>()
  for (const imported of extractImportsForFile({ path: input.path, content: input.content })) {
    for (const specifier of imported.specifiers) importedNames.add(specifier)
    if (imported.defaultImport) importedNames.add(imported.defaultImport)
    if (imported.namespaceImport) importedNames.add(imported.namespaceImport)
  }

  const relationships: CodeRelationshipInput[] = []
  const seen = new Set<string>()
  for (const source of input.entities) {
    if (source.kind === 'module' || !source.start_line || !source.end_line) continue
    const snippet = lines.slice(source.start_line - 1, source.end_line).join('\n')
    addJsxRelationships(input.repoKey, input.path, source, snippet, byName, importedNames, relationships, seen)
    addCallRelationships(input.repoKey, input.path, source, snippet, byName, importedNames, relationships, seen)
    addConstructRelationships(input.repoKey, input.path, source, snippet, byName, importedNames, relationships, seen)
  }
  return relationships.slice(0, 200)
}

function addJsxRelationships(repoKey: string, path: string, source: CodeEntityRow, snippet: string, byName: Map<string, CodeEntityRow>, importedNames: Set<string>, relationships: CodeRelationshipInput[], seen: Set<string>): void {
  for (const match of snippet.matchAll(/<([A-Z][A-Za-z0-9_$]*(?:\.[A-Z][A-Za-z0-9_$]*)?)(?=[\s/>])/g)) {
    const rawName = match[1]!
    const name = rawName.split('.')[0]!
    pushRelationship(repoKey, path, source, name, 'renders', byName, importedNames, relationships, seen, rawName)
  }
}

function addCallRelationships(repoKey: string, path: string, source: CodeEntityRow, snippet: string, byName: Map<string, CodeEntityRow>, importedNames: Set<string>, relationships: CodeRelationshipInput[], seen: Set<string>): void {
  for (const match of snippet.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1]!
    if (RESERVED_CALLS.has(name) || BUILTIN_CALLS.has(name) || name === source.name) continue
    pushRelationship(repoKey, path, source, name, /^use[A-Z0-9]/.test(name) ? 'uses_hook' : 'calls', byName, importedNames, relationships, seen)
  }
}

function addConstructRelationships(repoKey: string, path: string, source: CodeEntityRow, snippet: string, byName: Map<string, CodeEntityRow>, importedNames: Set<string>, relationships: CodeRelationshipInput[], seen: Set<string>): void {
  for (const match of snippet.matchAll(/\bnew\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1]!
    pushRelationship(repoKey, path, source, name, 'constructs', byName, importedNames, relationships, seen)
  }
}

function buildEntityLookup(localEntities: CodeEntityRow[], candidateEntities: CodeEntityRow[]): Map<string, CodeEntityRow> {
  const byName = new Map<string, CodeEntityRow>()
  for (const entity of candidateEntities) {
    if (entity.kind === 'module') continue
    if (entity.exported !== 1 && entity.default_export !== 1) continue
    if (!byName.has(entity.name)) byName.set(entity.name, entity)
  }
  for (const entity of localEntities) byName.set(entity.name, entity)
  return byName
}

function pushRelationship(
  repoKey: string,
  path: string,
  source: CodeEntityRow,
  targetName: string,
  kind: string,
  byName: Map<string, CodeEntityRow>,
  importedNames: Set<string>,
  relationships: CodeRelationshipInput[],
  seen: Set<string>,
  rawTargetName = targetName
): void {
  const target = byName.get(targetName)
  if (target?.id === source.id) return
  const confidence = target ? 0.8 : importedNames.has(targetName) ? 0.6 : 0.4
  const key = `${source.id}|${kind}|${rawTargetName}|${target?.id ?? ''}`
  if (seen.has(key)) return
  seen.add(key)
  relationships.push({
    repoKey,
    sourceEntityId: source.id,
    targetEntityId: target?.id,
    sourcePath: path,
    targetPath: target?.path,
    sourceName: source.name,
    targetName: rawTargetName,
    kind,
    confidence,
  })
}

function splitLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, '\n')
  if (normalized.length === 0) return []
  const lines = normalized.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}
