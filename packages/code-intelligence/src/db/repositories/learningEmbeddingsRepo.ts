import { and, eq, sql } from 'drizzle-orm'
import type { CodeIntelligenceDb } from '../connection.ts'
import { learningEmbeddings, learnings } from '../schema.ts'
import { bufferToFloat32Array, float32ArrayToBuffer } from '../../embeddings/vector.ts'

export type LearningEmbeddingRow = {
  learning_id: string
  model: string
  dimensions: number
  embedding_version: string
  embedding_text_hash: string
  embedding: Buffer
  stale: number
  created_at: string
  updated_at: string
}

export function upsertLearningEmbedding(
  db: CodeIntelligenceDb,
  input: {
    learningId: string
    model: string
    dimensions: number
    embeddingVersion: string
    embeddingTextHash: string
    embedding: number[]
    stale?: boolean
  }
): void {
  const now = new Date().toISOString()
  const values = {
    learningId: input.learningId,
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
    .insert(learningEmbeddings)
    .values(values)
    .onConflictDoUpdate({
      target: learningEmbeddings.learningId,
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

export function getLearningEmbedding(db: CodeIntelligenceDb, learningId: string): LearningEmbeddingRow | undefined {
  const row = db.select().from(learningEmbeddings).where(eq(learningEmbeddings.learningId, learningId)).get()
  return row ? embeddingToRow(row) : undefined
}

export function listLearningEmbeddingsForRepo(db: CodeIntelligenceDb, repoKey: string): Array<{
  learningId: string
  embedding: number[]
  model: string
  dimensions: number
}> {
  return db
    .select({ embedding: learningEmbeddings })
    .from(learningEmbeddings)
    .innerJoin(learnings, eq(learnings.id, learningEmbeddings.learningId))
    .where(and(eq(learnings.repoKey, repoKey), eq(learnings.status, 'active'), sql`${learnings.confidence} >= 0.5`, eq(learningEmbeddings.stale, 0)))
    .all()
    .map((row) => ({
      learningId: row.embedding.learningId,
      embedding: bufferToFloat32Array(row.embedding.embedding),
      model: row.embedding.model,
      dimensions: row.embedding.dimensions,
    }))
}

export function getLearningEmbeddingStats(db: CodeIntelligenceDb, repoKey: string): { embeddedLearnings: number; lastLearningEmbeddedAt: string | null } {
  return db.get(sql`SELECT COUNT(e.learning_id) AS embeddedLearnings, MAX(e.updated_at) AS lastLearningEmbeddedAt
       FROM learnings l
       LEFT JOIN learning_embeddings e ON e.learning_id = l.id
       WHERE l.repo_key = ${repoKey}`) as { embeddedLearnings: number; lastLearningEmbeddedAt: string | null }
}

function embeddingToRow(row: typeof learningEmbeddings.$inferSelect): LearningEmbeddingRow {
  return {
    learning_id: row.learningId,
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
