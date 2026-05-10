import type { ExtractedImport, RawEntity } from './types.ts'

export function extractTypeScriptEntities(path: string, content: string): RawEntity[] {
  const lines = splitLines(content)
  const entities: RawEntity[] = []
  const imports = extractTypeScriptImports(content)
  entities.push({
    name: path,
    qualifiedName: path,
    kind: 'module',
    symbolKind: 'module',
    startLine: 1,
    endLine: Math.max(1, lines.length),
    metadata: imports.length > 0 ? { imports } : undefined,
  })

  let braceDepth = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    const depthBefore = braceDepth
    if (depthBefore === 0 || /^export\s+default\s+/.test(trimmed) || /^(describe|it|test)\s*\(/.test(trimmed)) {
      const parsed = parseTsDeclaration(trimmed, lines, index)
      if (parsed) entities.push(parsed)
    }
    braceDepth = updateBraceDepth(line, braceDepth)
  }

  return dedupeEntities(entities)
}

export function extractTypeScriptImports(content: string): ExtractedImport[] {
  const imports: ExtractedImport[] = []
  const importRegex = /import\s+(type\s+)?([^'";]+?)\s+from\s+['"]([^'"]+)['"]/g
  for (const match of content.matchAll(importRegex)) {
    const clause = (match[2] ?? '').trim()
    const named = /\{([^}]+)\}/.exec(clause)?.[1]
    const namespaceImport = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause)?.[1]
    const defaultImport = clause.split(',')[0]?.trim().match(/^[A-Za-z_$][\w$]*$/)?.[0]
    imports.push({
      source: match[3]!,
      specifiers: named ? named.split(',').map((item) => item.trim().split(/\s+as\s+/)[0]!).filter(Boolean) : [],
      defaultImport,
      namespaceImport,
      typeOnly: Boolean(match[1]),
    })
  }
  for (const match of content.matchAll(/export\s+[^'";]*\s+from\s+['"]([^'"]+)['"]/g)) imports.push({ source: match[1]!, specifiers: [], typeOnly: false })
  return imports
}

function parseTsDeclaration(trimmed: string, lines: string[], index: number): RawEntity | undefined {
  const exported = /^export\b/.test(trimmed)
  const defaultExport = /^export\s+default\b/.test(trimmed)
  const stripped = trimmed.replace(/^export\s+default\s+/, '').replace(/^export\s+/, '')
  const lineNumber = index + 1
  const endLine = findEntityEndLine(lines, index)

  const functionMatch = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(stripped)
  if (functionMatch) return declaration(functionMatch[1]!, classifyFunction(functionMatch[1]!, lines, index), 'function', exported, defaultExport, lineNumber, endLine, trimmed)

  const classMatch = /^class\s+([A-Za-z_$][\w$]*)/.exec(stripped)
  if (classMatch) return declaration(classMatch[1]!, 'class', 'class', exported, defaultExport, lineNumber, endLine, trimmed)

  const interfaceMatch = /^interface\s+([A-Za-z_$][\w$]*)/.exec(stripped)
  if (interfaceMatch) return declaration(interfaceMatch[1]!, 'interface', 'interface', exported, defaultExport, lineNumber, endLine, trimmed)

  const typeMatch = /^type\s+([A-Za-z_$][\w$]*)/.exec(stripped)
  if (typeMatch) return declaration(typeMatch[1]!, 'type', 'type', exported, defaultExport, lineNumber, endLine, trimmed)

  const enumMatch = /^enum\s+([A-Za-z_$][\w$]*)/.exec(stripped)
  if (enumMatch) return declaration(enumMatch[1]!, 'type', 'enum', exported, defaultExport, lineNumber, endLine, trimmed)

  const variableMatch = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/.exec(stripped)
  if (variableMatch) {
    const name = variableMatch[1]!
    const isArrow = /=>/.test(stripped)
    const kind = isArrow ? classifyFunction(name, lines, index) : classifyConstant(name)
    return declaration(name, kind, isArrow ? 'function' : 'constant', exported, defaultExport, lineNumber, endLine, trimmed)
  }

  const testMatch = /^(describe|it|test)\s*\(\s*(['"`])(.+?)\2/.exec(stripped)
  if (testMatch) {
    const isSuite = testMatch[1] === 'describe'
    return declaration(testMatch[3]!, isSuite ? 'test_suite' : 'test_case', testMatch[1]!, exported, defaultExport, lineNumber, endLine, trimmed)
  }

  if (defaultExport) return declaration('default export', 'module', 'export', exported, defaultExport, lineNumber, endLine, trimmed)
  return undefined
}

function declaration(name: string, kind: string, symbolKind: string, exported: boolean, defaultExport: boolean, startLine: number, endLine: number, signature: string): RawEntity {
  return { name, kind, symbolKind, exported, defaultExport, startLine, endLine, signature: signature.slice(0, 500) }
}

function classifyFunction(name: string, lines: string[], index: number): string {
  if (/^use[A-Z0-9]/.test(name)) return 'hook'
  if (/^[A-Z]/.test(name) && (name.endsWith('Screen') || nearbyContainsJsx(lines, index))) return name.endsWith('Screen') ? 'screen' : 'component'
  return 'function'
}

function classifyConstant(name: string): string {
  if (/Schema$/.test(name)) return 'schema'
  return 'constant'
}

function nearbyContainsJsx(lines: string[], index: number): boolean {
  const end = Math.min(lines.length, index + 25)
  return lines.slice(index, end).some((line) => /return\s*\(?\s*</.test(line) || /<[A-Z][A-Za-z0-9.]*[\s/>]/.test(line))
}

function findEntityEndLine(lines: string[], startIndex: number): number {
  let depth = 0
  let sawBrace = false
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    for (const char of stripStrings(line)) {
      if (char === '{') {
        depth += 1
        sawBrace = true
      } else if (char === '}') {
        depth = Math.max(0, depth - 1)
      }
    }
    if (sawBrace && depth === 0) return index + 1
    if (!sawBrace && index > startIndex && line.trim() === '') return index
  }
  return startIndex + 1
}

function updateBraceDepth(line: string, current: number): number {
  let next = current
  for (const char of stripStrings(line)) {
    if (char === '{') next += 1
    else if (char === '}') next = Math.max(0, next - 1)
  }
  return next
}

function stripStrings(line: string): string {
  return line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '')
}

function splitLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, '\n')
  if (normalized.length === 0) return []
  const lines = normalized.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function dedupeEntities(entities: RawEntity[]): RawEntity[] {
  const seen = new Set<string>()
  return entities.filter((entity) => {
    const key = `${entity.name}|${entity.kind}|${entity.startLine ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
