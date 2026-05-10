import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveEmbeddingDeviceCandidates } from '../embeddings/transformersEmbeddingService.ts'

describe('embedding device selection', () => {
  it('tries accelerated devices safely and always falls back to cpu', () => {
    assert.deepEqual(resolveEmbeddingDeviceCandidates('auto'), ['auto', 'cpu'])
    assert.deepEqual(resolveEmbeddingDeviceCandidates('gpu'), ['gpu', 'auto', 'cpu'])
    assert.deepEqual(resolveEmbeddingDeviceCandidates('webgpu'), ['webgpu', 'cpu'])
    assert.deepEqual(resolveEmbeddingDeviceCandidates('coreml'), ['coreml', 'cpu'])
    assert.deepEqual(resolveEmbeddingDeviceCandidates('cpu'), ['cpu'])
  })
})
