import { extname } from 'node:path'
import type { CodeEntityInput } from '../db/repositories/entitiesRepo.ts'
import { extractFallbackEntities } from './languages/fallback.ts'
import { extractJavaScriptEntities, extractJavaScriptImports } from './languages/javascript.ts'
import { extractTypeScriptEntities, extractTypeScriptImports } from './languages/typescript.ts'
import type { ExtractedImport, ExtractInput, RawEntity } from './languages/types.ts'

const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.tsx'])
const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs'])

export function extractEntitiesForFile(input: ExtractInput): CodeEntityInput[] {
  const raw = extractRawEntities(input)
  return raw.map((entity) => ({
    ...entity,
    repoKey: input.repoKey,
    fileId: input.fileId,
    path: input.path,
    packageKey: input.packageKey,
    qualifiedName: entity.qualifiedName ?? `${input.path}#${entity.name}`,
  }))
}

export function extractImportsForFile(input: { path: string; language?: string; content: string }): ExtractedImport[] {
  if (isTypeScript(input.path, input.language)) return extractTypeScriptImports(input.content)
  if (isJavaScript(input.path, input.language)) return extractJavaScriptImports(input.content)
  return []
}

function extractRawEntities(input: ExtractInput): RawEntity[] {
  if (isTypeScript(input.path, input.language)) return extractTypeScriptEntities(input.path, input.content)
  if (isJavaScript(input.path, input.language)) return extractJavaScriptEntities(input.path, input.content)
  return extractFallbackEntities(input.path, input.content, input.language)
}

function isTypeScript(path: string, language?: string): boolean {
  return language === 'typescript' || language === 'typescriptreact' || TYPESCRIPT_EXTENSIONS.has(extname(path).toLowerCase())
}

function isJavaScript(path: string, language?: string): boolean {
  return language === 'javascript' || language === 'javascriptreact' || JAVASCRIPT_EXTENSIONS.has(extname(path).toLowerCase())
}

export type { ExtractedImport, ExtractInput, RawEntity }
