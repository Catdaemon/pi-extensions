import { asc, eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { CodeIntelligenceDb } from '../connection.ts'
import { learningEvents } from '../schema.ts'

export function appendLearningEvent(
  db: CodeIntelligenceDb,
  input: {
    repoKey: string
    learningId?: string
    eventKind: string
    payload: unknown
  }
): string {
  const id = randomUUID()
  db.insert(learningEvents).values({
    id,
    learningId: input.learningId ?? null,
    repoKey: input.repoKey,
    eventKind: input.eventKind,
    payloadJson: JSON.stringify(input.payload),
    createdAt: new Date().toISOString(),
  }).run()
  return id
}

export function listLearningEvents(db: CodeIntelligenceDb, repoKey: string) {
  return db
    .select()
    .from(learningEvents)
    .where(eq(learningEvents.repoKey, repoKey))
    .orderBy(asc(learningEvents.createdAt))
    .all()
    .map((row) => ({
      id: row.id,
      learning_id: row.learningId,
      repo_key: row.repoKey,
      event_kind: row.eventKind,
      payload_json: row.payloadJson,
      created_at: row.createdAt,
    }))
}
