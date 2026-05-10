import { and, eq, sql } from 'drizzle-orm'
import type { CodeIntelligenceDb } from '../connection.ts'
import { codeEntities, codeRelationships } from '../schema.ts'

export type CodeEntityInput = {
  repoKey: string
  fileId: number
  path: string
  packageKey?: string
  name: string
  qualifiedName?: string
  kind: string
  symbolKind?: string
  exported?: boolean
  defaultExport?: boolean
  startLine?: number
  endLine?: number
  signature?: string
  metadata?: unknown
}

export type CodeEntityRow = {
  id: number
  repo_key: string
  file_id: number
  path: string
  package_key: string | null
  name: string
  qualified_name: string | null
  kind: string
  symbol_kind: string | null
  exported: number
  default_export: number
  start_line: number | null
  end_line: number | null
  signature: string | null
  metadata_json: string | null
}

export function replaceEntitiesForFile(db: CodeIntelligenceDb, repoKey: string, path: string, entities: CodeEntityInput[]): CodeEntityRow[] {
  const now = new Date().toISOString()
  db.transaction((tx) => {
    tx.delete(codeRelationships).where(and(eq(codeRelationships.repoKey, repoKey), sql`(${codeRelationships.sourcePath} = ${path} OR ${codeRelationships.targetPath} = ${path})`)).run()
    tx.delete(codeEntities).where(and(eq(codeEntities.repoKey, repoKey), eq(codeEntities.path, path))).run()
    for (const entity of entities) {
      tx.insert(codeEntities).values({
        repoKey,
        fileId: entity.fileId,
        path,
        packageKey: entity.packageKey ?? null,
        name: entity.name,
        qualifiedName: entity.qualifiedName ?? null,
        kind: entity.kind,
        symbolKind: entity.symbolKind ?? null,
        exported: entity.exported ? 1 : 0,
        defaultExport: entity.defaultExport ? 1 : 0,
        startLine: entity.startLine ?? null,
        endLine: entity.endLine ?? null,
        signature: entity.signature ?? null,
        metadataJson: entity.metadata === undefined ? null : JSON.stringify(entity.metadata),
        createdAt: now,
        updatedAt: now,
      }).run()
    }
  })
  return listEntitiesForPath(db, repoKey, path)
}

export function deleteEntitiesForFilePaths(db: CodeIntelligenceDb, repoKey: string, paths: string[]): number {
  if (paths.length === 0) return 0
  let deleted = 0
  db.transaction((tx) => {
    for (const path of paths) deleted += tx.delete(codeEntities).where(and(eq(codeEntities.repoKey, repoKey), eq(codeEntities.path, path))).run().changes
  })
  return deleted
}

export function listEntitiesForPath(db: CodeIntelligenceDb, repoKey: string, path: string): CodeEntityRow[] {
  return db.select().from(codeEntities).where(and(eq(codeEntities.repoKey, repoKey), eq(codeEntities.path, path))).all().map(entityToRow)
}

export function findEntitiesByName(db: CodeIntelligenceDb, repoKey: string, names: string[], limit = 25): CodeEntityRow[] {
  if (names.length === 0) return []
  const unique = [...new Set(names)].slice(0, 20)
  const rows: CodeEntityRow[] = []
  for (const name of unique) {
    rows.push(...db.select().from(codeEntities).where(and(eq(codeEntities.repoKey, repoKey), eq(codeEntities.name, name))).limit(limit).all().map(entityToRow))
    if (rows.length >= limit) break
  }
  return rows.slice(0, limit)
}

export function findEntityPathsByQuery(db: CodeIntelligenceDb, repoKey: string, query: string, limit = 25): string[] {
  const tokens = extractQueryTokens(query)
  if (tokens.length === 0) return []
  const paths = new Set<string>()
  for (const token of tokens) {
    const like = `%${token}%`
    const rows = db.all(sql`SELECT DISTINCT path FROM code_entities WHERE repo_key = ${repoKey} AND (name LIKE ${like} OR qualified_name LIKE ${like} OR path LIKE ${like}) LIMIT ${limit}`) as Array<{ path: string }>
    for (const row of rows) paths.add(row.path)
    if (paths.size >= limit) break
  }
  return [...paths].slice(0, limit)
}

export function getEntityStats(db: CodeIntelligenceDb, repoKey: string): { totalEntities: number; byKind: Record<string, number> } {
  const rows = db.all(sql`SELECT kind, COUNT(*) AS count FROM code_entities WHERE repo_key = ${repoKey} GROUP BY kind`) as Array<{ kind: string; count: number }>
  return { totalEntities: rows.reduce((sum, row) => sum + row.count, 0), byKind: Object.fromEntries(rows.map((row) => [row.kind, row.count])) }
}

function extractQueryTokens(query: string): string[] {
  return query.split(/[^A-Za-z0-9_./-]+/).map((token) => token.trim()).filter((token) => token.length >= 2).slice(0, 20)
}

function entityToRow(row: typeof codeEntities.$inferSelect): CodeEntityRow {
  return {
    id: row.id,
    repo_key: row.repoKey,
    file_id: row.fileId,
    path: row.path,
    package_key: row.packageKey,
    name: row.name,
    qualified_name: row.qualifiedName,
    kind: row.kind,
    symbol_kind: row.symbolKind,
    exported: row.exported,
    default_export: row.defaultExport,
    start_line: row.startLine,
    end_line: row.endLine,
    signature: row.signature,
    metadata_json: row.metadataJson,
  }
}
