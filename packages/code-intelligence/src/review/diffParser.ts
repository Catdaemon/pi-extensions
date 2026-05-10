export type ParsedDiff = {
  files: ParsedDiffFile[]
  addedImports: Array<{ path: string; source: string; line: string }>
  addedDependencies: Array<{ path: string; name: string; kind: 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies' }>
}

export type ParsedDiffFile = {
  path: string
  oldPath?: string
  addedLines: string[]
  deletedLines: string[]
}

export function parseUnifiedDiff(diff: string): ParsedDiff {
  const files: ParsedDiffFile[] = []
  let current: ParsedDiffFile | undefined

  for (const line of diff.split('\n')) {
    const fileMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (fileMatch) {
      current = { oldPath: fileMatch[1], path: fileMatch[2] ?? fileMatch[1] ?? '', addedLines: [], deletedLines: [] }
      files.push(current)
      continue
    }

    if (!current) continue
    if (line.startsWith('+++ b/')) {
      current.path = line.slice('+++ b/'.length)
      continue
    }
    if (line.startsWith('--- a/')) {
      current.oldPath = line.slice('--- a/'.length)
      continue
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) current.addedLines.push(line.slice(1))
    else if (line.startsWith('-')) current.deletedLines.push(line.slice(1))
  }

  return {
    files,
    addedImports: extractAddedImports(files),
    addedDependencies: extractAddedDependencies(files),
  }
}

function extractAddedImports(files: ParsedDiffFile[]): ParsedDiff['addedImports'] {
  const imports: ParsedDiff['addedImports'] = []
  for (const file of files) {
    for (const line of file.addedLines) {
      const source = parseImportSource(line)
      if (source) imports.push({ path: file.path, source, line })
    }
  }
  return imports
}

function parseImportSource(line: string): string | undefined {
  const trimmed = line.trim()
  const importMatch = /^(?:import|export)\s+(?:type\s+)?(?:.+?\s+from\s+)?['"]([^'"]+)['"]/.exec(trimmed)
  if (importMatch?.[1]) return importMatch[1]
  const requireMatch = /require\(\s*['"]([^'"]+)['"]\s*\)/.exec(trimmed)
  return requireMatch?.[1]
}

function extractAddedDependencies(files: ParsedDiffFile[]): ParsedDiff['addedDependencies'] {
  const deps: ParsedDiff['addedDependencies'] = []
  const depSectionPattern = /^\s*"(dependencies|devDependencies|peerDependencies|optionalDependencies)"\s*:/
  const depLinePattern = /^\s*"([^"@][^"]*|@[^"]+)"\s*:/

  for (const file of files) {
    if (!/(^|\/)package\.json$/.test(file.path)) continue
    let section: ParsedDiff['addedDependencies'][number]['kind'] | undefined
    for (const line of file.addedLines) {
      const sectionMatch = depSectionPattern.exec(line)
      if (sectionMatch?.[1]) {
        section = sectionMatch[1] as ParsedDiff['addedDependencies'][number]['kind']
        continue
      }
      if (/^\s*}/.test(line)) {
        section = undefined
        continue
      }
      const depMatch = depLinePattern.exec(line)
      if (depMatch?.[1]) deps.push({ path: file.path, name: depMatch[1], kind: section ?? 'dependencies' })
    }
  }
  return deps
}
