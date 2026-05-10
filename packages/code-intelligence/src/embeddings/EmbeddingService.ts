export type EmbeddingStatusValue =
  | 'not_started'
  | 'downloading'
  | 'warming'
  | 'ready'
  | 'fallback_active'
  | 'fts_only'
  | 'failed'

export interface EmbeddingService {
  readonly provider: 'transformers'
  readonly modelId: string
  readonly dimensions: number
  readonly status: EmbeddingStatusValue
  readonly lastError?: string
  readonly activeDevice?: string

  ensureReady(): Promise<void>
  embedTexts(texts: string[]): Promise<number[][]>
}

export const EMBEDDING_VERSION = 'code-intelligence-v1'

export function buildChunkEmbeddingText(input: {
  path: string
  language?: string
  symbolName?: string
  symbolKind?: string
  chunkKind: string
  content: string
}): string {
  const lines = [`Path: ${input.path}`]
  if (input.language) lines.push(`Language: ${input.language}`)
  if (input.symbolName) lines.push(`Symbol: ${input.symbolName}`)
  if (input.symbolKind) lines.push(`Kind: ${input.symbolKind}`)
  lines.push(`Chunk kind: ${input.chunkKind}`)
  lines.push('', 'Code:', input.content)
  return lines.join('\n')
}
