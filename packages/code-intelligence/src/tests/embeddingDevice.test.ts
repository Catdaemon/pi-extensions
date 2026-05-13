import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildTransformersPipelineOptions, isCoreMlSystemCompatible, poolingForModel, resolveAutoEmbeddingDeviceCandidates, resolveEmbeddingDeviceCandidates } from '../embeddings/transformersEmbeddingService.ts'

describe('embedding device selection', () => {
  it('tries accelerated devices safely and always falls back to cpu', () => {
    const auto = resolveAutoEmbeddingDeviceCandidates()
    assert.deepEqual(resolveEmbeddingDeviceCandidates('auto'), auto)
    assert.deepEqual(resolveEmbeddingDeviceCandidates('gpu'), ['gpu', ...auto.filter((device) => device !== 'gpu')])
    assert.deepEqual(resolveEmbeddingDeviceCandidates('webgpu'), ['webgpu', 'cpu'])
    assert.deepEqual(resolveEmbeddingDeviceCandidates('coreml'), isCoreMlSystemCompatible() ? ['coreml', 'cpu'] : ['cpu'])
    assert.deepEqual(resolveEmbeddingDeviceCandidates('cpu'), ['cpu'])
  })

  it('does not pass auto as a concrete transformers device', () => {
    const progressCallback = () => {}
    assert.deepEqual(buildTransformersPipelineOptions({ cacheDir: '/tmp/cache', device: 'auto', dtype: 'auto', progressCallback }), {
      cache_dir: '/tmp/cache',
      progress_callback: progressCallback,
    })
    assert.deepEqual(buildTransformersPipelineOptions({ cacheDir: '/tmp/cache', device: 'cpu', dtype: 'fp32', progressCallback }), {
      cache_dir: '/tmp/cache',
      progress_callback: progressCallback,
      device: 'cpu',
      dtype: 'fp32',
    })
  })

  it('uses model-recommended pooling defaults', () => {
    assert.equal(poolingForModel('onnx-community/bge-small-en-v1.5-ONNX'), 'cls')
    assert.equal(poolingForModel('jinaai/jina-embeddings-v2-base-code'), 'mean')
  })
})
