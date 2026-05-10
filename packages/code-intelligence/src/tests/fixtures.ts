import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function writeTsImportFixture(root: string): Promise<void> {
  await mkdir(join(root, 'src', 'lib'), { recursive: true })
  await writeFile(join(root, 'src', 'app.ts'), "import { helper } from './lib/helper'\nexport function app() { return helper() }\n")
  await writeFile(join(root, 'src', 'app.test.ts'), "import { app } from './app'\ntest('app', () => app())\n")
  await writeFile(join(root, 'src', 'lib', 'helper.ts'), 'export function helper() { return 1 }\n')
}

export async function writeReactExpoFixture(root: string): Promise<void> {
  await mkdir(join(root, 'app', '(tabs)'), { recursive: true })
  await mkdir(join(root, 'src', 'components'), { recursive: true })
  await mkdir(join(root, 'src', 'hooks'), { recursive: true })
  await writeFile(join(root, 'app', '(tabs)', 'home.tsx'), [
    "import { Card } from '../../src/components/Card'",
    "import { useThing } from '../../src/hooks/useThing'",
    'export default function HomeScreen() {',
    '  const thing = useThing()',
    '  return <Card title={thing} />',
    '}',
  ].join('\n'))
  await writeFile(join(root, 'src', 'components', 'Card.tsx'), 'export function Card(props: { title: string }) { return <Text>{props.title}</Text> }\n')
  await writeFile(join(root, 'src', 'hooks', 'useThing.ts'), "export function useThing() { return 'thing' }\n")
}

export async function writeSchemaAndSimilarityFixture(root: string): Promise<void> {
  await mkdir(join(root, 'src', 'billing'), { recursive: true })
  await writeFile(join(root, 'src', 'billing', 'invoice.ts'), [
    'export const InvoiceSchema = { total: "number" }',
    'export function formatInvoiceTotal(total: number) {',
    '  return `Invoice total: ${total}`',
    '}',
  ].join('\n'))
  await writeFile(join(root, 'src', 'billing', 'receipt.ts'), [
    'export const ReceiptSchema = { total: "number" }',
    'export function formatReceiptTotal(total: number) {',
    '  return `Invoice total: ${total}`',
    '}',
  ].join('\n'))
}

export async function writeBuggyChangeFixture(root: string): Promise<void> {
  await mkdir(join(root, 'src', 'api', '__tests__'), { recursive: true })
  await writeFile(join(root, 'src', 'api', 'users.ts'), [
    'export async function loadUser(id: string) {',
    '  if (!id) return null',
    '  return fetch(`/api/users/${id}`).then((res) => res.json())',
    '}',
  ].join('\n'))
  await writeFile(join(root, 'src', 'api', '__tests__', 'users.test.ts'), "import { loadUser } from '../users'\ntest('empty user', () => loadUser(''))\n")
}
