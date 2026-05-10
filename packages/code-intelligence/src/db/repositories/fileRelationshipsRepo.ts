import { and, eq, or, sql } from 'drizzle-orm'
import type { CodeIntelligenceDb } from '../connection.ts'
import { fileRelationships } from '../schema.ts'

export type FileRelationshipInput = {
  repoKey: string
  sourcePath: string
  targetPath: string
  kind: string
  confidence: number
  metadata?: unknown
}

export function replaceFileRelationshipsForFile(db: CodeIntelligenceDb, repoKey: string, path: string, relationships: FileRelationshipInput[]): number {
  const now = new Date().toISOString()
  db.transaction((tx) => {
    tx.delete(fileRelationships).where(and(eq(fileRelationships.repoKey, repoKey), eq(fileRelationships.sourcePath, path))).run()
    for (const rel of relationships) {
      tx.insert(fileRelationships).values({
        repoKey,
        sourcePath: rel.sourcePath,
        targetPath: rel.targetPath,
        kind: rel.kind,
        confidence: rel.confidence,
        metadataJson: rel.metadata === undefined ? null : JSON.stringify(rel.metadata),
        createdAt: now,
        updatedAt: now,
      }).run()
    }
  })
  return relationships.length
}

export function deleteFileRelationshipsForFilePaths(db: CodeIntelligenceDb, repoKey: string, paths: string[]): number {
  if (paths.length === 0) return 0
  let deleted = 0
  db.transaction((tx) => {
    for (const path of paths) {
      deleted += tx.delete(fileRelationships).where(and(eq(fileRelationships.repoKey, repoKey), or(eq(fileRelationships.sourcePath, path), eq(fileRelationships.targetPath, path)))).run().changes
    }
  })
  return deleted
}

export function listFileRelationshipsForPath(db: CodeIntelligenceDb, repoKey: string, path: string) {
  return db.select().from(fileRelationships).where(and(eq(fileRelationships.repoKey, repoKey), eq(fileRelationships.sourcePath, path))).all()
}

export function listIncomingFileRelationshipsForPath(db: CodeIntelligenceDb, repoKey: string, path: string) {
  return db.select().from(fileRelationships).where(and(eq(fileRelationships.repoKey, repoKey), eq(fileRelationships.targetPath, path))).all()
}

export function getFileRelationshipStats(db: CodeIntelligenceDb, repoKey: string): { totalRelationships: number; byKind: Record<string, number> } {
  const rows = db.all(sql`SELECT kind, COUNT(*) AS count FROM file_relationships WHERE repo_key = ${repoKey} GROUP BY kind`) as Array<{ kind: string; count: number }>
  return { totalRelationships: rows.reduce((sum, row) => sum + row.count, 0), byKind: Object.fromEntries(rows.map((row) => [row.kind, row.count])) }
}
