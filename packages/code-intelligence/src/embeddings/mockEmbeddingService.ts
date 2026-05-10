import { sha256Text } from '../indexing/hash.ts'
import { normalizeVector } from './vector.ts'
import type { EmbeddingService, EmbeddingStatusValue } from './EmbeddingService.ts'

export class MockEmbeddingService implements EmbeddingService {
  readonly provider = 'transformers' as const
  readonly modelId = 'mock-local-hash-embedding'
  readonly dimensions: number
  status: EmbeddingStatusValue = 'ready'

  constructor(dimensions = 64) {
    this.dimensions = dimensions
  }

  async ensureReady(): Promise<void> {}

  async embedTexts(texts: string[]): Promise<number[][]> {
    return texts.map((text) => deterministicEmbedding(text, this.dimensions))
  }
}

export function deterministicEmbedding(text: string, dimensions = 64): number[] {
  const vector = new Array<number>(dimensions).fill(0)
  const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) ?? []
  for (const token of tokens) {
    const hash = sha256Text(token)
    const index = Number.parseInt(hash.slice(0, 8), 16) % dimensions
    const sign = Number.parseInt(hash.slice(8, 10), 16) % 2 === 0 ? 1 : -1
    vector[index] += sign
  }
  return normalizeVector(vector)
}
