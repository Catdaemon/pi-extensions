import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DEFAULT_CONFIG } from '../config.ts'
import { openCodeIntelligenceDb } from '../db/connection.ts'
import { CodeIntelligenceProgressWidget, formatEmbeddingDeviceLine, formatEmbeddingDownloadLine, formatEmbeddingStatusLine, formatEmbeddingThroughputLine, formatFileProgress, isEmbeddingWorkVisible, isFileWorkVisible } from '../pi/progressWidget.ts'

describe('code intelligence progress widget', () => {
  it('does not show incremental changed-file progress as a fraction of the whole repo', () => {
    assert.equal(formatFileProgress('changedFilesIndex', 2, 2000), 'Changed files 2')
  })

  it('shows full repo indexing as processed over total files', () => {
    assert.equal(formatFileProgress('fullRepoIndex', 2, 2000), 'Files 2/2000')
  })

  it('does not show active repo total when job kind is unavailable', () => {
    assert.equal(formatFileProgress(undefined, 2, 159), 'Files 2')
  })

  it('shows file and embedding progress as separate conditional lines', () => {
    assert.equal(isFileWorkVisible('fullRepoIndex', true, 0), true)
    assert.equal(isFileWorkVisible('embeddingBackfill', true, 0), false)
    assert.equal(isFileWorkVisible(undefined, false, 0), false)
    assert.equal(isEmbeddingWorkVisible('ready', 3), true)
    assert.equal(isEmbeddingWorkVisible('warming', 0), true)
    assert.equal(isEmbeddingWorkVisible('ready', 0), false)
  })

  it('does not show a ready status line while embeddings are still missing', () => {
    assert.equal(formatEmbeddingStatusLine('ready', 4), undefined)
    assert.equal(formatEmbeddingStatusLine('ready', 0), undefined)
    assert.equal(formatEmbeddingStatusLine('warming', 0), 'Status warming')
  })

  it('shows active or requested embedding device and model', () => {
    assert.equal(formatEmbeddingDeviceLine('coreml', 'cpu', 'jinaai/jina-embeddings-v2-base-code'), 'Device coreml • jina-embeddings-v2-base-code')
    assert.equal(formatEmbeddingDeviceLine(undefined, 'coreml', 'Xenova/all-MiniLM-L6-v2'), 'Device coreml requested • all-MiniLM-L6-v2')
    assert.equal(formatEmbeddingDeviceLine(undefined, undefined), undefined)
  })

  it('shows embedding download progress with size', () => {
    assert.equal(formatEmbeddingDownloadLine({ status: 'download', file: 'onnx/model.onnx', loadedBytes: 512 * 1024, totalBytes: 1024 * 1024, progress: 50 }), 'Downloading model.onnx 50% • 512.0 KB/1.0 MB')
    assert.equal(formatEmbeddingDownloadLine({ status: 'download', loadedBytes: 0, totalBytes: 1024, progress: 0 }), 'Downloading 0% • 0 B/1.0 KB')
    assert.equal(formatEmbeddingDownloadLine({}), undefined)
  })

  it('does not reuse hidden idle output when work becomes visible', async () => {
    const storage = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-progress-widget-'))
    const db = await openCodeIntelligenceDb(storage)
    let queuedJobs = 0
    const layouts: Array<{ visible: boolean; height: number }> = []
    try {
      const widget = new CodeIntelligenceProgressWidget(() => ({
        db,
        identity: { repoKey: 'progress-widget-repo', gitRoot: storage, identitySource: 'path' },
        config: DEFAULT_CONFIG,
        indexScheduler: {
          getStatus: () => ({
            running: false,
            queuedJobs,
            stats: { activeFiles: 0, totalFiles: 0 },
          }),
        },
        services: { get: () => ({ status: 'ready' }) },
      }) as never, undefined, (layout) => layouts.push(layout))

      assert.deepEqual(widget.render(80), [])
      queuedJobs = 1
      assert(widget.render(80).length > 0)
      assert.deepEqual(layouts.at(-1)?.visible, true)
    } finally {
      db.close()
      await rm(storage, { recursive: true, force: true })
    }
  })

  it('shows embedding throughput and ETA', () => {
    assert.equal(formatEmbeddingThroughputLine(12.4, 125), 'Rate 12/s • ETA 2m 5s')
    assert.equal(formatEmbeddingThroughputLine(3.25, 42), 'Rate 3.3/s • ETA 42s')
    assert.equal(formatEmbeddingThroughputLine(0, 42), undefined)
  })
})
