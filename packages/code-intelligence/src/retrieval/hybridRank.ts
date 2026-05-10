import type { RetrievedCodeChunk } from './retrieveCode.ts'

export function mergeHybridResults(input: {
  fts: RetrievedCodeChunk[]
  vector: RetrievedCodeChunk[]
  limit: number
}): RetrievedCodeChunk[] {
  const byId = new Map<number, RetrievedCodeChunk>()

  for (const chunk of input.fts) {
    byId.set(chunk.id, { ...chunk, score: chunk.score * 0.45 })
  }

  for (const chunk of input.vector) {
    const existing = byId.get(chunk.id)
    if (existing) {
      byId.set(chunk.id, {
        ...existing,
        score: existing.score + chunk.score * 0.55,
        reasons: [...new Set([...existing.reasons, ...chunk.reasons])],
      })
    } else {
      byId.set(chunk.id, { ...chunk, score: chunk.score * 0.55 })
    }
  }

  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, input.limit)
}
