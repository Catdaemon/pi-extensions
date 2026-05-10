import type { CodeEntityInput } from '../../db/repositories/entitiesRepo.ts'

export type ExtractInput = {
  repoKey: string
  fileId: number
  path: string
  packageKey?: string
  language?: string
  content: string
}

export type RawEntity = Omit<CodeEntityInput, 'repoKey' | 'fileId' | 'path' | 'packageKey'>

export type ExtractedImport = {
  source: string
  specifiers: string[]
  defaultImport?: string
  namespaceImport?: string
  typeOnly?: boolean
}
