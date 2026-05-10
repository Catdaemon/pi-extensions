import { mkdir } from 'node:fs/promises'
import type { CodeIntelligenceConfig } from '../config.ts'
import type { CodeIntelligenceLogger } from '../logger.ts'
import { resolveModelCacheDir } from '../repo/storage.ts'
import type { EmbeddingService, EmbeddingStatusValue } from './EmbeddingService.ts'
import { normalizeVector } from './vector.ts'

type Extractor = (texts: string[] | string, options?: Record<string, unknown>) => Promise<unknown>

const MODEL_DIMENSIONS: Record<string, number> = {
  'jinaai/jina-embeddings-v2-base-code': 768,
  'onnx-community/granite-embedding-small-english-r2-ONNX': 384,
  'Xenova/all-MiniLM-L6-v2': 384,
}

export class TransformersEmbeddingService implements EmbeddingService {
  readonly provider = 'transformers' as const
  modelId: string
  dimensions: number
  status: EmbeddingStatusValue = 'not_started'
  lastError: string | undefined
  activeDevice: string | undefined

  private extractor: Extractor | undefined
  private readyPromise: Promise<void> | undefined
  private readonly modelIds: string[]
  private readonly cacheDir: string

  constructor(
    private readonly config: CodeIntelligenceConfig,
    private readonly logger: CodeIntelligenceLogger,
    private readonly onStatusChange?: (service: TransformersEmbeddingService) => void
  ) {
    this.modelIds = [
      config.embedding.model,
      config.embedding.fallbackModel,
      config.embedding.emergencyFallbackModel,
    ].filter((value, index, array) => Boolean(value) && array.indexOf(value) === index)
    this.modelId = this.modelIds[0] ?? 'jinaai/jina-embeddings-v2-base-code'
    this.dimensions = MODEL_DIMENSIONS[this.modelId] ?? 384
    this.cacheDir = resolveModelCacheDir()
  }

  warmInBackground(): void {
    if (!this.config.embedding.autoDownload) {
      this.setStatus('fts_only')
      return
    }
    this.readyPromise = this.ensureReady().catch((error) => {
      this.readyPromise = undefined
      this.setStatus('fts_only')
      this.lastError = (error as Error).message
      this.logger.warn('embedding warmup failed; continuing FTS-only', { error: this.lastError })
    })
  }

  async ensureReady(): Promise<void> {
    if (this.extractor) return
    if (this.readyPromise) return this.readyPromise

    this.readyPromise = this.initialize()
    return this.readyPromise
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    await this.ensureReady()
    if (!this.extractor) throw new Error('Embedding model is not ready')

    const output = await this.extractor(texts, { pooling: 'mean', normalize: true })
    return normalizeExtractorOutput(output)
  }

  private async initialize(): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true })

    let lastError: unknown
    const deviceCandidates = resolveEmbeddingDeviceCandidates(this.config.embedding.device)
    for (const [index, modelId] of this.modelIds.entries()) {
      for (const device of deviceCandidates) {
        try {
          this.modelId = modelId
          this.dimensions = MODEL_DIMENSIONS[modelId] ?? this.dimensions
          this.activeDevice = device
          this.setStatus(index === 0 ? 'downloading' : 'fallback_active')

          const transformers = await import('@huggingface/transformers')
          const env = transformers.env as { cacheDir?: string; allowLocalModels?: boolean }
          env.cacheDir = this.cacheDir

          this.setStatus('warming')
          const pipelineOptions: Record<string, unknown> = {
            cache_dir: this.cacheDir,
            device,
          }
          if (this.config.embedding.dtype !== 'auto') pipelineOptions.dtype = this.config.embedding.dtype
          this.extractor = (await transformers.pipeline('feature-extraction', modelId, pipelineOptions)) as Extractor

          this.setStatus(index === 0 ? 'ready' : 'fallback_active')
          this.lastError = undefined
          this.logger.info('embedding model ready', { modelId, dimensions: this.dimensions, cacheDir: this.cacheDir, device })
          return
        } catch (error) {
          lastError = error
          this.lastError = (error as Error).message
          this.logger.warn('embedding model/device failed; trying fallback if available', { modelId, device, error: this.lastError })
          this.extractor = undefined
          this.activeDevice = undefined
        }
      }
    }

    this.setStatus('fts_only')
    throw new Error(`All local embedding models failed: ${(lastError as Error | undefined)?.message ?? 'unknown error'}`)
  }

  private setStatus(status: EmbeddingStatusValue): void {
    this.status = status
    this.onStatusChange?.(this)
  }
}

export function resolveEmbeddingDeviceCandidates(device: CodeIntelligenceConfig['embedding']['device']): string[] {
  const envOverride = process.env.PI_CODE_INTELLIGENCE_EMBEDDING_DEVICE?.trim().toLowerCase()
  const requested = envOverride || device || 'auto'
  if (requested === 'cpu') return ['cpu']
  if (requested === 'auto') return ['auto', 'cpu']
  if (requested === 'gpu') return ['gpu', 'auto', 'cpu']
  return [requested, 'cpu']
}

function normalizeExtractorOutput(output: unknown): number[][] {
  const data = extractData(output)
  if (!Array.isArray(data)) throw new Error('Unexpected embedding output')

  if (data.length > 0 && typeof data[0] === 'number') {
    return [normalizeVector(data as number[])]
  }

  return (data as unknown[]).map((item) => {
    if (Array.isArray(item) && item.length > 0 && typeof item[0] === 'number') {
      return normalizeVector(item as number[])
    }
    const nested = extractData(item)
    if (Array.isArray(nested) && nested.length > 0 && typeof nested[0] === 'number') {
      return normalizeVector(nested as number[])
    }
    throw new Error('Unexpected nested embedding output')
  })
}

function extractData(value: unknown): unknown {
  if (value && typeof value === 'object' && 'tolist' in value && typeof (value as { tolist: unknown }).tolist === 'function') {
    return (value as { tolist: () => unknown }).tolist()
  }
  if (value && typeof value === 'object' && 'data' in value) return (value as { data: unknown }).data
  return value
}
