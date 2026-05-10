import type { ExtractedImport, RawEntity } from './types.ts'
import { extractTypeScriptEntities, extractTypeScriptImports } from './typescript.ts'

// JavaScript and TypeScript share the same practical extractor for now. Keeping this
// adapter separate gives us a language-specific seam for CommonJS, JSDoc, or a parser-backed
// JavaScript implementation without changing the indexing dispatcher.
export function extractJavaScriptEntities(path: string, content: string): RawEntity[] {
  const imports = extractJavaScriptImports(content)
  return extractTypeScriptEntities(path, content)
    .filter((entity) => entity.symbolKind !== 'interface' && entity.symbolKind !== 'type' && entity.symbolKind !== 'enum')
    .map((entity) => entity.kind === 'module' ? { ...entity, metadata: imports.length > 0 ? { imports } : undefined } : entity)
}

export function extractJavaScriptImports(content: string): ExtractedImport[] {
  const imports = extractTypeScriptImports(content)
  for (const match of content.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    imports.push({ source: match[1]!, specifiers: [] })
  }
  return imports
}
