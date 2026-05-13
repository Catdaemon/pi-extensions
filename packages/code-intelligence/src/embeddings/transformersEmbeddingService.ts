import { mkdir } from 'node:fs/promises'
import type { CodeIntelligenceConfig } from '../config.ts'
import type { CodeIntelligenceLogger } from '../logger.ts'
import { resolveModelCacheDir } from '../repo/storage.ts'
import type { EmbeddingService, EmbeddingStatusValue } from './EmbeddingService.ts'
import { normalizeVector } from './vector.ts'

type Extractor = (texts: string[] | string, options?: Record<string, unknown>) => Promise<unknown>

const MODEL_DIMENSIONS: Record<string, number> = {
  'onnx-community/bge-small-en-v1.5-ONNX': 384,
  'Xenova/bge-small-en-v1.5': 384,
  'jinaai/jina-embeddings-v2-base-code': 768,
  'onnx-community/granite-embedding-small-english-r2-ONNX': 384,
  'onnx-community/all-MiniLM-L6-v2-ONNX': 384,
  'Xenova/all-MiniLM-L6-v2': 384,
}

export class TransformersEmbeddingService implements EmbeddingService {
  readonly provider = 'transformers' as const
  modelId: string
  dimensions: number
  status: EmbeddingStatusValue = 'not_started'
  lastError: string | undefined
  activeDevice: string | undefined
  downloadStatus: string | undefined
  downloadFile: string | undefined
  downloadLoadedBytes: number | undefined
  downloadTotalBytes: number | undefined
  downloadProgress: number | undefined

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
    this.modelId = this.modelIds[0] ?? 'onnx-community/bge-small-en-v1.5-ONNX'
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

    const output = await this.extractor(texts, { pooling: poolingForModel(this.modelId), normalize: true })
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
          const pipelineOptions = buildTransformersPipelineOptions({
            cacheDir: this.cacheDir,
            device,
            dtype: this.config.embedding.dtype,
            progressCallback: (progress: unknown) => this.updateDownloadProgress(progress),
          })
          this.extractor = (await transformers.pipeline('feature-extraction', modelId, pipelineOptions)) as Extractor

          this.clearDownloadProgress()
          this.setStatus(index === 0 ? 'ready' : 'fallback_active')
          this.lastError = undefined
          this.logger.info('embedding model ready', { modelId, dimensions: this.dimensions, cacheDir: this.cacheDir, device: this.activeDevice })
          return
        } catch (error) {
          lastError = error
          this.lastError = (error as Error).message
          this.logger.warn('embedding model/device failed; trying fallback if available', { modelId, device, error: this.lastError })
          this.extractor = undefined
          this.activeDevice = undefined
          this.clearDownloadProgress()
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

  private updateDownloadProgress(progress: unknown): void {
    if (!progress || typeof progress !== 'object') return
    const event = progress as { status?: unknown; name?: unknown; file?: unknown; progress?: unknown; loaded?: unknown; total?: unknown }
    this.downloadStatus = typeof event.status === 'string' ? event.status : this.downloadStatus
    this.downloadFile = typeof event.file === 'string' ? event.file : typeof event.name === 'string' ? event.name : this.downloadFile
    this.downloadLoadedBytes = finiteNumber(event.loaded) ?? this.downloadLoadedBytes
    this.downloadTotalBytes = finiteNumber(event.total) ?? this.downloadTotalBytes
    this.downloadProgress = finiteNumber(event.progress) ?? deriveProgress(this.downloadLoadedBytes, this.downloadTotalBytes) ?? this.downloadProgress
    if (this.downloadStatus === 'download' || this.downloadStatus === 'progress') this.status = 'downloading'
    this.onStatusChange?.(this)
  }

  private clearDownloadProgress(): void {
    this.downloadStatus = undefined
    this.downloadFile = undefined
    this.downloadLoadedBytes = undefined
    this.downloadTotalBytes = undefined
    this.downloadProgress = undefined
  }
}

export function buildTransformersPipelineOptions(input: {
  cacheDir: string
  device: string
  dtype: CodeIntelligenceConfig['embedding']['dtype']
  progressCallback: (progress: unknown) => void
}): Record<string, unknown> {
  const options: Record<string, unknown> = {
    cache_dir: input.cacheDir,
    progress_callback: input.progressCallback,
  }
  if (input.device !== 'auto') options.device = input.device
  if (input.dtype !== 'auto') options.dtype = input.dtype
  return options
}

export function resolveEmbeddingDeviceCandidates(device: CodeIntelligenceConfig['embedding']['device']): string[] {
  const envOverride = process.env.PI_CODE_INTELLIGENCE_EMBEDDING_DEVICE?.trim().toLowerCase()
  const requested = envOverride || device || 'auto'
  if (requested === 'cpu') return ['cpu']
  if (requested === 'auto') return resolveAutoEmbeddingDeviceCandidates()
  if (requested === 'gpu') return uniqueDevices(['gpu', ...resolveAutoEmbeddingDeviceCandidates(), 'cpu'])
  if (requested === 'coreml') return isCoreMlSystemCompatible() ? ['coreml', 'cpu'] : ['cpu']
  return uniqueDevices([requested, 'cpu'])
}

export function resolveAutoEmbeddingDeviceCandidates(): string[] {
  return uniqueDevices([
    ...(isCoreMlSystemCompatible() ? ['coreml'] : []),
    'auto',
    'cpu',
  ])
}

function uniqueDevices(devices: string[]): string[] {
  return devices.filter((device, index, array) => Boolean(device) && array.indexOf(device) === index)
}

export function isCoreMlSystemCompatible(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PI_CODE_INTELLIGENCE_DISABLE_COREML === '1') return false
  if (env.PI_CODE_INTELLIGENCE_FORCE_COREML === '1') return true
  return process.platform === 'darwin' && process.arch === 'arm64'
}

export function poolingForModel(modelId: string): 'mean' | 'cls' {
  return /(?:^|\/)bge-/i.test(modelId) ? 'cls' : 'mean'
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function deriveProgress(loaded: number | undefined, total: number | undefined): number | undefined {
  if (!loaded || !total || total <= 0) return undefined
  return Math.max(0, Math.min(100, (loaded / total) * 100))
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
