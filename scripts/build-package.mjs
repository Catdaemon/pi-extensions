import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const packageDir = process.cwd()
const rootDir = path.resolve(packageDir, '../..')
const distDir = path.join(packageDir, 'dist')
const sidebarSource = path.join(rootDir, 'packages/sidebar/src/index.ts')

async function copyIfExists(from, to) {
  if (!existsSync(from)) return
  await cp(from, to, { recursive: true })
}

async function rewriteFile(filePath, replacements) {
  if (!existsSync(filePath)) return
  let text = await readFile(filePath, 'utf8')
  for (const [from, to] of replacements) text = text.replaceAll(from, to)
  await writeFile(filePath, text)
}

await rm(distDir, { recursive: true, force: true })
await mkdir(distDir, { recursive: true })
await copyIfExists(path.join(packageDir, 'index.ts'), path.join(distDir, 'index.ts'))
await copyIfExists(path.join(packageDir, 'src'), path.join(distDir, 'src'))

const packageName = path.basename(packageDir)
if (packageName === 'todos') {
  await mkdir(path.join(distDir, 'src/vendor'), { recursive: true })
  await cp(sidebarSource, path.join(distDir, 'src/vendor/pi-sidebar.ts'))
  await rewriteFile(path.join(distDir, 'src/agentTodos.ts'), [["from '@catdaemon/pi-sidebar'", "from './vendor/pi-sidebar.ts'"]])
}

if (packageName === 'code-intelligence') {
  await mkdir(path.join(distDir, 'src/vendor'), { recursive: true })
  await cp(sidebarSource, path.join(distDir, 'src/vendor/pi-sidebar.ts'))
  await rewriteFile(path.join(distDir, 'src/extension.ts'), [["from '@catdaemon/pi-sidebar'", "from './vendor/pi-sidebar.ts'"]])
  await rewriteFile(path.join(distDir, 'src/pi/progressWidget.ts'), [["from '@catdaemon/pi-sidebar'", "from '../vendor/pi-sidebar.ts'"]])
}
