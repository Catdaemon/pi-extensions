import { and, eq, isNull, or, sql } from 'drizzle-orm'
import type { CodeIntelligenceDb } from '../connection.ts'
import { chunkEmbeddings, chunks, files } from '../schema.ts'
import { bufferToFloat32Array, float32ArrayToBuffer } from '../../embeddings/vector.ts'

export type ChunkEmbeddingInput = {
  chunkId: number
  model: string
  dimensions: number
  embeddingVersion: string
  embeddingTextHash: string
  embedding: number[]
  stale?: boolean
}

export type ChunkEmbeddingRow = {
  chunk_id: number
  model: string
  dimensions: number
  embedding_version: string
  embedding_text_hash: string
  embedding: Buffer
  stale: number
  created_at: string
  updated_at: string
}

export function upsertChunkEmbedding(db: CodeIntelligenceDb, input: ChunkEmbeddingInput): void {
  const now = new Date().toISOString()
  const values = {
    chunkId: input.chunkId,
    model: input.model,
    dimensions: input.dimensions,
    embeddingVersion: input.embeddingVersion,
    embeddingTextHash: input.embeddingTextHash,
    embedding: float32ArrayToBuffer(input.embedding),
    stale: input.stale ? 1 : 0,
    createdAt: now,
    updatedAt: now,
  }
  db
    .insert(chunkEmbeddings)
    .values(values)
    .onConflictDoUpdate({
      target: chunkEmbeddings.chunkId,
      set: {
        model: values.model,
        dimensions: values.dimensions,
        embeddingVersion: values.embeddingVersion,
        embeddingTextHash: values.embeddingTextHash,
        embedding: values.embedding,
        stale: values.stale,
        updatedAt: now,
      },
    })
    .run()
}

export function getChunkEmbedding(db: CodeIntelligenceDb, chunkId: number): ChunkEmbeddingRow | undefined {
  const row = db.select().from(chunkEmbeddings).where(eq(chunkEmbeddings.chunkId, chunkId)).get()
  return row ? embeddingToRow(row) : undefined
}

export function listChunkEmbeddingsForRepo(db: CodeIntelligenceDb, repoKey: string): Array<{
  chunkId: number
  path: string
  embedding: number[]
  model: string
  dimensions: number
  stale: boolean
}> {
  return db
    .select({ embedding: chunkEmbeddings, path: chunks.path })
    .from(chunkEmbeddings)
    .innerJoin(chunks, eq(chunks.id, chunkEmbeddings.chunkId))
    .innerJoin(files, eq(files.id, chunks.fileId))
    .where(and(eq(chunks.repoKey, repoKey), isNull(files.deletedAt), eq(chunkEmbeddings.stale, 0)))
    .all()
    .map((row) => ({
      chunkId: row.embedding.chunkId,
      path: row.path,
      embedding: bufferToFloat32Array(row.embedding.embedding),
      model: row.embedding.model,
      dimensions: row.embedding.dimensions,
      stale: Boolean(row.embedding.stale),
    }))
}

export function markEmbeddingsStaleForModelChange(db: CodeIntelligenceDb, model: string, dimensions: number, embeddingVersion: string): number {
  return db
    .update(chunkEmbeddings)
    .set({ stale: 1, updatedAt: new Date().toISOString() })
    .where(or(sql`${chunkEmbeddings.model} != ${model}`, sql`${chunkEmbeddings.dimensions} != ${dimensions}`, sql`${chunkEmbeddings.embeddingVersion} != ${embeddingVersion}`))
    .run().changes
}

export function getEmbeddingStats(db: CodeIntelligenceDb, repoKey: string): {
  embeddedChunks: number
  staleEmbeddings: number | null
  missingEmbeddings: number
  totalEmbeddableChunks: number
  lastEmbeddedAt: string | null
} {
  return db.get(sql`SELECT
        SUM(CASE WHEN e.chunk_id IS NOT NULL THEN 1 ELSE 0 END) AS embeddedChunks,
        SUM(CASE WHEN e.stale = 1 THEN 1 ELSE 0 END) AS staleEmbeddings,
        SUM(CASE WHEN e.chunk_id IS NULL OR e.stale = 1 THEN 1 ELSE 0 END) AS missingEmbeddings,
        COUNT(c.id) AS totalEmbeddableChunks,
        MAX(e.updated_at) AS lastEmbeddedAt
       FROM chunks c
       LEFT JOIN chunk_embeddings e ON e.chunk_id = c.id
       JOIN files f ON f.id = c.file_id
       WHERE c.repo_key = ${repoKey} AND f.deleted_at IS NULL`) as {
    embeddedChunks: number
    staleEmbeddings: number | null
    missingEmbeddings: number
    totalEmbeddableChunks: number
    lastEmbeddedAt: string | null
  }
}

function embeddingToRow(row: typeof chunkEmbeddings.$inferSelect): ChunkEmbeddingRow {
  return {
    chunk_id: row.chunkId,
    model: row.model,
    dimensions: row.dimensions,
    embedding_version: row.embeddingVersion,
    embedding_text_hash: row.embeddingTextHash,
    embedding: row.embedding,
    stale: row.stale,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}
