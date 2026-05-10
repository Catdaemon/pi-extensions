import { and, eq, or, sql } from 'drizzle-orm'
import type { CodeIntelligenceDb } from '../connection.ts'
import { codeRelationships } from '../schema.ts'

export type CodeRelationshipInput = {
  repoKey: string
  sourceEntityId?: number
  targetEntityId?: number
  sourcePath: string
  targetPath?: string
  sourceName?: string
  targetName?: string
  kind: string
  confidence: number
  metadata?: unknown
}

export function replaceCodeRelationshipsForFile(db: CodeIntelligenceDb, repoKey: string, path: string, relationships: CodeRelationshipInput[]): number {
  const now = new Date().toISOString()
  db.transaction((tx) => {
    tx.delete(codeRelationships).where(and(eq(codeRelationships.repoKey, repoKey), eq(codeRelationships.sourcePath, path))).run()
    for (const rel of relationships) {
      tx.insert(codeRelationships).values({
        repoKey,
        sourceEntityId: rel.sourceEntityId ?? null,
        targetEntityId: rel.targetEntityId ?? null,
        sourcePath: rel.sourcePath,
        targetPath: rel.targetPath ?? null,
        sourceName: rel.sourceName ?? null,
        targetName: rel.targetName ?? null,
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

export function deleteCodeRelationshipsForFilePaths(db: CodeIntelligenceDb, repoKey: string, paths: string[]): number {
  if (paths.length === 0) return 0
  let deleted = 0
  db.transaction((tx) => {
    for (const path of paths) {
      deleted += tx.delete(codeRelationships).where(and(eq(codeRelationships.repoKey, repoKey), or(eq(codeRelationships.sourcePath, path), eq(codeRelationships.targetPath, path)))).run().changes
    }
  })
  return deleted
}

export function listCodeRelationshipsForPath(db: CodeIntelligenceDb, repoKey: string, path: string) {
  return db.select().from(codeRelationships).where(and(eq(codeRelationships.repoKey, repoKey), eq(codeRelationships.sourcePath, path))).all()
}

export function listIncomingCodeRelationshipsForPath(db: CodeIntelligenceDb, repoKey: string, path: string) {
  return db.select().from(codeRelationships).where(and(eq(codeRelationships.repoKey, repoKey), eq(codeRelationships.targetPath, path))).all()
}

export function replaceSimilarRelationshipsForRepo(db: CodeIntelligenceDb, repoKey: string, relationships: CodeRelationshipInput[]): number {
  const now = new Date().toISOString()
  db.transaction((tx) => {
    tx.delete(codeRelationships).where(and(eq(codeRelationships.repoKey, repoKey), eq(codeRelationships.kind, 'similar_to'))).run()
    for (const rel of relationships) {
      tx.insert(codeRelationships).values({
        repoKey,
        sourceEntityId: rel.sourceEntityId ?? null,
        targetEntityId: rel.targetEntityId ?? null,
        sourcePath: rel.sourcePath,
        targetPath: rel.targetPath ?? null,
        sourceName: rel.sourceName ?? null,
        targetName: rel.targetName ?? null,
        kind: 'similar_to',
        confidence: rel.confidence,
        metadataJson: rel.metadata === undefined ? null : JSON.stringify(rel.metadata),
        createdAt: now,
        updatedAt: now,
      }).run()
    }
  })
  return relationships.length
}

export function getRelationshipStats(db: CodeIntelligenceDb, repoKey: string): { totalRelationships: number; byKind: Record<string, number> } {
  const rows = db.all(sql`SELECT kind, COUNT(*) AS count FROM code_relationships WHERE repo_key = ${repoKey} GROUP BY kind`) as Array<{ kind: string; count: number }>
  return { totalRelationships: rows.reduce((sum, row) => sum + row.count, 0), byKind: Object.fromEntries(rows.map((row) => [row.kind, row.count])) }
}
