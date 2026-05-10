import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AgentSessionEvent, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import {
  AuthStorage,
  buildSessionContext,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  convertToLlm,
  createAgentSession,
  getAgentDir,
  getMarkdownTheme,
  serializeConversation,
  withFileMutationQueue,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { Message, Model } from '@earendil-works/pi-ai'
import { StringEnum } from '@earendil-works/pi-ai'
import { Container, Markdown, Spacer, Text, truncateToWidth } from '@earendil-works/pi-tui'

const SAVE_TYPE = 'pi-subagent-state'
const SUBAGENT_ROOT_DIR = join(getAgentDir(), 'subagents')
const SUBAGENT_SESSION_DIR = join(SUBAGENT_ROOT_DIR, 'sessions')
const SUBAGENT_INDEX_FILE = join(SUBAGENT_ROOT_DIR, 'index.json')
const MAX_TASKS = 8
const MAX_CONCURRENCY = 4
const PREVIEW_LIMIT = 220
const RESPONSE_PREVIEW_LIMIT = 160
const TOOL_UPDATE_THROTTLE_MS = 150

type ContextMode = 'task_only' | 'full_conversation'
type SubagentStatus = 'running' | 'completed' | 'error' | 'aborted'

type TodoItem = {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

type TodoSummary = {
  total: number
  completed: number
  inProgress: number
  lastCompleted: string[]
}

type StoredSubagent = {
  id: string
  sessionId: string
  sessionFile: string
  title: string
  task: string
  model?: string
  tools?: string[]
  persist?: boolean
  disposedAt?: number
  contextMode: ContextMode
  status: SubagentStatus
  lastActivity: string
  lastResponse: string
  thinking: boolean
  todoSummary: TodoSummary
  createdAt: number
  updatedAt: number
  lastError?: string
}

type RunTaskInput = {
  task: string
  title?: string
  model?: string
  instructions?: string
  contextMode?: ContextMode
  cwd?: string
  tools?: string[]
  persist?: boolean
}

type RunResultDetails = {
  source: 'subagent_run' | 'subagent_resume' | 'subagent_list' | 'subagent_dispose'
  subagents: StoredSubagent[]
}

type SessionIndex = Record<string, StoredSubagent>

const defaultTodoSummary = (): TodoSummary => ({
  total: 0,
  completed: 0,
  inProgress: 0,
  lastCompleted: [],
})

const contextModeSchema = StringEnum(['task_only', 'full_conversation'] as const, {
  description: 'How much parent-agent context to include for the subagent.',
})

const toolsAllowlistSchema = Type.Array(Type.String(), {
  description:
    'Optional allowlist of tool names to enable for the subagent session. When omitted, the subagent inherits the parent agent\'s currently active tools (excluding subagent tools). When provided, only the listed tools are enabled.',
})

const persistSchema = Type.Boolean({
  description:
    'Whether to persist the subagent session for later resume. Defaults to true. Set false when the subagent is fire-and-forget and should be cleaned up automatically.',
})

const runTaskSchema = Type.Object({
  task: Type.String({ description: 'The delegated task for the subagent.' }),
  title: Type.Optional(
    Type.String({ description: 'Short label for UI display. Defaults to a preview of the task.' })
  ),
  model: Type.Optional(
    Type.String({
      description:
        'Optional model for the subagent, preferably in provider/model form. If omitted, uses the current model.',
    })
  ),
  instructions: Type.Optional(
    Type.String({
      description:
        'Optional extra prompt/instructions for the subagent. Use this when you want a custom role or prompt.',
    })
  ),
  contextMode: Type.Optional(contextModeSchema),
  cwd: Type.Optional(
    Type.String({ description: 'Optional working directory for the subagent. Defaults to the current cwd.' })
  ),
  tools: Type.Optional(toolsAllowlistSchema),
  persist: Type.Optional(persistSchema),
})

const subagentRunSchema = Type.Object({
  tasks: Type.Array(runTaskSchema, {
    description:
      'One or more subagent tasks. Multiple tasks run concurrently up to the configured limit.',
    minItems: 1,
    maxItems: MAX_TASKS,
  }),
})

const subagentResumeSchema = Type.Object({
  id: Type.String({ description: 'The id returned by subagent_run or subagent_resume.' }),
  task: Type.String({ description: 'Follow-up task for the existing subagent session.' }),
  model: Type.Optional(
    Type.String({
      description:
        'Optional model override for the resumed subagent, preferably in provider/model form.',
    })
  ),
  instructions: Type.Optional(
    Type.String({ description: 'Optional new instructions/custom prompt for this follow-up.' })
  ),
  tools: Type.Optional(toolsAllowlistSchema),
  persist: Type.Optional(persistSchema),
})

const subagentDisposeSchema = Type.Object({
  id: Type.String({ description: 'The subagent id to dispose and delete.' }),
})

function truncatePreview(text: string, limit = PREVIEW_LIMIT) {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= limit) {
    return trimmed
  }
  return `${trimmed.slice(0, limit - 3)}...`
}

function makeTitle(task: string, explicit?: string) {
  if (explicit && explicit.trim().length > 0) {
    return truncatePreview(explicit.trim(), 60)
  }
  return truncatePreview(task, 60) || 'Subagent task'
}

function extractAssistantText(message: Message | AgentMessage) {
  if (message.role !== 'assistant') {
    return ''
  }

  const parts = Array.isArray(message.content) ? message.content : []
  return parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim()
}

function getTodoSummary(todos: TodoItem[], previous?: TodoSummary): TodoSummary {
  const completedItems = todos.filter((todo) => todo.status === 'completed').map((todo) => todo.content)
  const previousCompleted = new Set(previous?.lastCompleted ?? [])
  const newlyCompleted = completedItems.filter((item) => !previousCompleted.has(item))

  return {
    total: todos.length,
    completed: completedItems.length,
    inProgress: todos.filter((todo) => todo.status === 'in_progress').length,
    lastCompleted: newlyCompleted.length > 0 ? newlyCompleted.slice(-3) : (previous?.lastCompleted ?? []).slice(-3),
  }
}

async function ensureSubagentStorage() {
  await mkdir(SUBAGENT_SESSION_DIR, { recursive: true })
  await mkdir(dirname(SUBAGENT_INDEX_FILE), { recursive: true })
}

async function readGlobalIndex(): Promise<SessionIndex> {
  try {
    await ensureSubagentStorage()
    const raw = await readFile(SUBAGENT_INDEX_FILE, 'utf8')
    const parsed = JSON.parse(raw) as SessionIndex
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function writeGlobalRecord(record: StoredSubagent) {
  await ensureSubagentStorage()
  await withFileMutationQueue(SUBAGENT_INDEX_FILE, async () => {
    const current = await readGlobalIndex()
    current[record.id] = record
    await writeFile(SUBAGENT_INDEX_FILE, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
    return {
      content: [{ type: 'text', text: 'Saved subagent state' }],
      details: {},
    }
  })
}

function mergeLatestById(records: StoredSubagent[]) {
  const merged = new Map<string, StoredSubagent>()

  for (const record of records) {
    const previous = merged.get(record.id)
    if (!previous || previous.updatedAt <= record.updatedAt) {
      merged.set(record.id, record)
    }
  }

  return Array.from(merged.values())
    .filter((record) => !record.disposedAt)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

async function removeGlobalRecord(id: string) {
  await ensureSubagentStorage()
  await withFileMutationQueue(SUBAGENT_INDEX_FILE, async () => {
    const current = await readGlobalIndex()
    delete current[id]
    await writeFile(SUBAGENT_INDEX_FILE, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
    return {
      content: [{ type: 'text', text: 'Removed subagent state' }],
      details: {},
    }
  })
}

async function deleteSessionFile(sessionFile: string) {
  if (!sessionFile) {
    return
  }

  try {
    await unlink(sessionFile)
  } catch {
    // ignore missing files
  }
}

function extractStoredSubagents(ctx: ExtensionContext) {
  const records: StoredSubagent[] = []

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== 'custom') {
      continue
    }

    if (entry.customType !== SAVE_TYPE) {
      continue
    }

    const data = entry.data as StoredSubagent | undefined
    if (!data || typeof data.id !== 'string') {
      continue
    }

    records.push(data)
  }

  return mergeLatestById(records)
}

async function lookupStoredSubagent(id: string, known: StoredSubagent[]) {
  const direct = known.find((item) => item.id === id)
  if (direct) {
    return direct
  }

  const index = await readGlobalIndex()
  return index[id]
}

function createMergedSignal(parentSignal: AbortSignal | undefined) {
  const controller = new AbortController()

  const abort = () => controller.abort(parentSignal?.reason)

  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort(parentSignal.reason)
    } else {
      parentSignal.addEventListener('abort', abort, { once: true })
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (parentSignal) {
        parentSignal.removeEventListener('abort', abort)
      }
    },
  }
}

function formatSubagentRecord(record: StoredSubagent) {
  const todoText =
    record.todoSummary.total > 0
      ? `${record.todoSummary.completed}/${record.todoSummary.total} todos`
      : 'no todos'

  const persistence = record.persist === false || record.disposedAt ? 'ephemeral' : 'persistent'
  const lines = [
    `${record.id} • ${record.status} • ${record.title}`,
    `model: ${record.model ?? 'default'} • ${todoText} • ${persistence}`,
  ]

  if (record.lastActivity) {
    lines.push(`last: ${record.lastActivity}`)
  }

  if (record.lastResponse) {
    lines.push(`response: ${truncatePreview(record.lastResponse, RESPONSE_PREVIEW_LIMIT)}`)
  }

  if (record.lastError) {
    lines.push(`error: ${truncatePreview(record.lastError, RESPONSE_PREVIEW_LIMIT)}`)
  }

  return lines.join('\n')
}

function formatRunResultText(records: StoredSubagent[]) {
  if (records.length === 0) {
    return 'No subagent results.'
  }

  return records
    .map((record) => {
      const persistence = record.persist === false || record.disposedAt ? 'ephemeral' : 'persistent'
      const header = `- id: ${record.id} • status: ${record.status} • ${persistence} • title: ${record.title}`
      const output = record.lastResponse ? truncatePreview(record.lastResponse, RESPONSE_PREVIEW_LIMIT) : '(no response)'
      return `${header}\n  output: ${output}`
    })
    .join('\n\n')
}

function sanitizeToolAllowlist(tools: string[] | undefined) {
  if (!Array.isArray(tools)) {
    return undefined
  }

  const seen = new Set<string>()
  const result: string[] = []

  for (const tool of tools) {
    const name = tool.trim()
    if (!name || seen.has(name)) {
      continue
    }

    seen.add(name)
    result.push(name)
  }

  return result
}

function getInheritedToolAllowlist(api: ExtensionAPI, explicitTools: string[] | undefined) {
  const requested = sanitizeToolAllowlist(explicitTools)
  if (requested) {
    return requested
  }

  const parentTools = sanitizeToolAllowlist(api.getActiveTools()) ?? []
  return parentTools.filter(
    (tool) =>
      tool !== 'subagent_run' &&
      tool !== 'subagent_resume' &&
      tool !== 'subagent_list' &&
      tool !== 'subagent_dispose'
  )
}

function buildDelegatedPrompt(input: {
  task: string
  instructions?: string
  contextMode: ContextMode
  serializedConversation?: string
}) {
  const blocks = [
    'You are a subagent helping another pi agent.',
    '- Work directly on the delegated task.',
    '- Be concise and return only the most useful result for the parent agent.',
    '- Do not spawn further subagents unless the delegated task explicitly requires it.',
  ]

  if (input.instructions && input.instructions.trim().length > 0) {
    blocks.push(`<custom-prompt>\n${input.instructions.trim()}\n</custom-prompt>`)
  }

  if (input.contextMode === 'full_conversation' && input.serializedConversation) {
    blocks.push(`<parent-conversation>\n${input.serializedConversation}\n</parent-conversation>`)
  }

  blocks.push(`<delegated-task>\n${input.task.trim()}\n</delegated-task>`)

  return blocks.join('\n\n')
}

async function resolveModelRef(
  ref: string | undefined,
  fallback: Model<any> | undefined,
  modelRegistry: ModelRegistry
) {
  if (!ref || ref.trim().length === 0) {
    return fallback
  }

  const trimmed = ref.trim()
  if (trimmed.includes('/')) {
    const [provider, ...rest] = trimmed.split('/')
    const modelId = rest.join('/')
    return modelRegistry.find(provider, modelId)
  }

  if (fallback) {
    const sameProvider = modelRegistry.find(fallback.provider, trimmed)
    if (sameProvider) {
      return sameProvider
    }
  }

  const matches = modelRegistry
    .getAvailable()
    .filter((model) => model.id === trimmed || `${model.provider}/${model.id}` === trimmed)

  if (matches.length === 1) {
    return matches[0]
  }

  return undefined
}

async function mapWithConcurrencyLimit<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  run: (item: TInput, index: number) => Promise<TOutput>
) {
  if (items.length === 0) {
    return [] as TOutput[]
  }

  const results = new Array<TOutput>(items.length)
  let nextIndex = 0
  const workerCount = Math.max(1, Math.min(concurrency, items.length))

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const current = nextIndex++
        if (current >= items.length) {
          return
        }

        results[current] = await run(items[current], current)
      }
    })
  )

  return results
}

export default function piSubagents(pi: ExtensionAPI) {
  const authStorage = AuthStorage.create()
  const modelRegistry = ModelRegistry.create(authStorage)
  const agentDir = getAgentDir()

  let knownSubagents: StoredSubagent[] = []
  let activeSubagents = new Map<string, StoredSubagent>()
  let latestUiContext: ExtensionContext | null = null
  let lastToolUpdateAt = 0

  function syncKnownSubagents(ctx: ExtensionContext) {
    knownSubagents = extractStoredSubagents(ctx)
  }

  function updateKnownSubagent(record: StoredSubagent) {
    knownSubagents = mergeLatestById([...knownSubagents.filter((item) => item.id !== record.id), record])
  }

  function shouldPersistSubagent(explicitPersist: boolean | undefined, fallbackPersist: boolean | undefined = true) {
    return explicitPersist ?? fallbackPersist ?? true
  }

  async function disposeSubagentRecord(
    record: StoredSubagent,
    ctx?: ExtensionContext | null,
    options?: { allowActive?: boolean }
  ) {
    if (!options?.allowActive && activeSubagents.has(record.id)) {
      throw new Error(`Subagent ${record.id} is still running and cannot be disposed yet.`)
    }

    await deleteSessionFile(record.sessionFile)
    await removeGlobalRecord(record.id)

    const disposedRecord: StoredSubagent = {
      ...record,
      disposedAt: Date.now(),
      lastActivity: 'disposed',
      updatedAt: Date.now(),
      persist: false,
    }

    pi.appendEntry(SAVE_TYPE, disposedRecord)
    updateKnownSubagent(disposedRecord)
    refreshUi(ctx)
    return disposedRecord
  }

  function getVisibleSubagents() {
    if (activeSubagents.size > 0) {
      return Array.from(activeSubagents.values()).sort((a, b) => a.createdAt - b.createdAt)
    }
    return []
  }

  function refreshUi(ctx?: ExtensionContext | null) {
    const uiCtx = ctx ?? latestUiContext
    if (!uiCtx?.hasUI) {
      return
    }

    latestUiContext = uiCtx
    const active = getVisibleSubagents()

    if (active.length === 0) {
      uiCtx.ui.setStatus('pi-subagents', undefined)
      uiCtx.ui.setWidget('pi-subagents', undefined)
      return
    }

    const thinkingCount = active.filter((item) => item.thinking).length
    uiCtx.ui.setStatus(
      'pi-subagents',
      uiCtx.ui.theme.fg(
        'accent',
        `⇆ ${active.length} subagent${active.length === 1 ? '' : 's'}${thinkingCount > 0 ? ` • ${thinkingCount} thinking` : ''}`
      )
    )

    uiCtx.ui.setWidget(
      'pi-subagents',
      (_tui, theme) => ({
        render(width: number) {
          const lines: string[] = []
          lines.push(truncateToWidth(theme.fg('accent', theme.bold('Subagents')), width))

          for (const record of active) {
            const statusIcon =
              record.status === 'completed'
                ? theme.fg('success', '✓')
                : record.status === 'error'
                  ? theme.fg('error', '✗')
                  : record.status === 'aborted'
                    ? theme.fg('warning', '⏹')
                    : record.thinking
                      ? theme.fg('warning', '…')
                      : theme.fg('accent', '↻')

            lines.push(
              truncateToWidth(
                `${statusIcon} ${theme.fg('text', record.title)} ${theme.fg('dim', `(${record.id})`)}`,
                width
              )
            )
            lines.push(truncateToWidth(theme.fg('muted', `  task: ${truncatePreview(record.task, 80)}`), width))

            if (record.lastActivity) {
              const thinkingLabel = record.thinking ? ' • thinking' : ''
              lines.push(
                truncateToWidth(
                  theme.fg('dim', `  last: ${truncatePreview(record.lastActivity, 80)}${thinkingLabel}`),
                  width
                )
              )
            }

            if (record.lastResponse) {
              lines.push(
                truncateToWidth(
                  theme.fg('text', `  resp: ${truncatePreview(record.lastResponse, 90)}`),
                  width
                )
              )
            }

            if (record.todoSummary.total > 0) {
              const todoText = `  todos: ${record.todoSummary.completed}/${record.todoSummary.total}`
              const completed =
                record.todoSummary.lastCompleted.length > 0
                  ? ` • +${truncatePreview(record.todoSummary.lastCompleted.join(', '), 60)}`
                  : ''
              lines.push(truncateToWidth(theme.fg('muted', `${todoText}${completed}`), width))
            }

            if (record.lastError) {
              lines.push(truncateToWidth(theme.fg('error', `  error: ${truncatePreview(record.lastError, 80)}`), width))
            }

            lines.push('')
          }

          while (lines.length > 0 && lines[lines.length - 1] === '') {
            lines.pop()
          }

          return lines
        },
        invalidate() {},
      }),
      { placement: 'belowEditor' }
    )
  }

  function setActiveSubagent(record: StoredSubagent, ctx?: ExtensionContext | null) {
    activeSubagents.set(record.id, record)
    refreshUi(ctx)
  }

  function clearActiveSubagent(id: string, ctx?: ExtensionContext | null) {
    activeSubagents.delete(id)
    refreshUi(ctx)
  }

  function buildUpdateDetails(source: RunResultDetails['source'], records: StoredSubagent[]): RunResultDetails {
    return {
      source,
      subagents: records.map((record) => ({ ...record })),
    }
  }

  function maybeEmitToolUpdate(
    source: RunResultDetails['source'],
    onUpdate: ((partial: { content: Array<{ type: 'text'; text: string }>; details: RunResultDetails }) => void) | undefined
  ) {
    if (!onUpdate) {
      return
    }

    const now = Date.now()
    if (now - lastToolUpdateAt < TOOL_UPDATE_THROTTLE_MS) {
      return
    }

    lastToolUpdateAt = now
    const visible = getVisibleSubagents()
    onUpdate({
      content: [
        {
          type: 'text',
          text: visible.length === 0 ? 'No active subagents.' : formatRunResultText(visible),
        },
      ],
      details: buildUpdateDetails(source, visible),
    })
  }

  async function createSubagentSession(input: {
    ctx: ExtensionContext
    sessionFile?: string
    model?: Model<any>
    tools?: string[]
    persist?: boolean
  }) {
    const settingsManager = SettingsManager.create(input.ctx.cwd, agentDir)
    const resourceLoader = new DefaultResourceLoader({
      cwd: input.ctx.cwd,
      agentDir,
      settingsManager,
    })
    await resourceLoader.reload()

    const sessionManager = input.sessionFile
      ? SessionManager.open(input.sessionFile, SUBAGENT_SESSION_DIR, input.ctx.cwd)
      : input.persist === false
        ? SessionManager.inMemory(input.ctx.cwd)
        : SessionManager.create(input.ctx.cwd, SUBAGENT_SESSION_DIR)

    const toolAllowlist = getInheritedToolAllowlist(pi, input.tools)

    const { session } = await createAgentSession({
      cwd: input.ctx.cwd,
      agentDir,
      sessionManager,
      settingsManager,
      resourceLoader,
      authStorage,
      modelRegistry,
      model: input.model,
      thinkingLevel: pi.getThinkingLevel(),
      tools: toolAllowlist,
      noTools: toolAllowlist && toolAllowlist.length === 0 ? 'all' : undefined,
    })

    await session.bindExtensions({})
    return session
  }

  async function runSingleSubagent(input: {
    record: StoredSubagent
    task: string
    instructions?: string
    contextMode: ContextMode
    serializedConversation?: string
    modelRef?: string
    tools?: string[]
    persist?: boolean
    source: RunResultDetails['source']
    ctx: ExtensionContext
    signal?: AbortSignal
    onUpdate?: (partial: { content: Array<{ type: 'text'; text: string }>; details: RunResultDetails }) => void
  }) {
    const resolvedModel = await resolveModelRef(input.modelRef, input.ctx.model ?? undefined, modelRegistry)

    if (input.modelRef && !resolvedModel) {
      throw new Error(`Unknown or unavailable model: ${input.modelRef}`)
    }

    const toolAllowlist = getInheritedToolAllowlist(pi, input.tools ?? input.record.tools)
    const persist = shouldPersistSubagent(input.persist, input.record.persist)
    const hadPersistentState = Boolean(input.record.sessionFile) || knownSubagents.some((item) => item.id === input.record.id)

    const session = await createSubagentSession({
      ctx: input.ctx,
      sessionFile: input.record.sessionFile,
      model: resolvedModel ?? input.ctx.model ?? undefined,
      tools: toolAllowlist,
      persist,
    })

    const merged = createMergedSignal(input.signal)
    const prompt = buildDelegatedPrompt({
      task: input.task,
      instructions: input.instructions,
      contextMode: input.contextMode,
      serializedConversation: input.serializedConversation,
    })

    const record = {
      ...input.record,
      model: resolvedModel ? `${resolvedModel.provider}/${resolvedModel.id}` : input.record.model,
      tools: toolAllowlist,
      persist,
      disposedAt: undefined,
      lastActivity: 'starting',
      thinking: false,
      updatedAt: Date.now(),
    }

    record.sessionId = session.sessionId
    record.sessionFile = session.sessionFile ?? record.sessionFile
    setActiveSubagent(record, input.ctx)
    maybeEmitToolUpdate(input.source, input.onUpdate)

    let currentAssistantText = ''

    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      switch (event.type) {
        case 'message_update': {
          const assistantEvent = event.assistantMessageEvent
          if (assistantEvent.type === 'thinking_delta') {
            record.thinking = true
            record.lastActivity = 'thinking'
          }
          if (assistantEvent.type === 'text_delta') {
            record.thinking = false
            currentAssistantText += assistantEvent.delta
            record.lastResponse = truncatePreview(currentAssistantText, RESPONSE_PREVIEW_LIMIT)
            record.lastActivity = 'responding'
          }
          break
        }
        case 'message_end': {
          const message = event.message as Message
          if (message.role === 'assistant') {
            record.thinking = false
            currentAssistantText = ''
            const text = extractAssistantText(message)
            if (text) {
              record.lastResponse = truncatePreview(text, RESPONSE_PREVIEW_LIMIT)
              record.lastActivity = 'assistant message complete'
            }
          }
          if (message.role === 'toolResult') {
            record.thinking = false
            record.lastActivity = `tool ${message.toolName}`
            if (message.toolName === 'todo_write') {
              const details = message.details as { todos?: TodoItem[] } | undefined
              if (Array.isArray(details?.todos)) {
                record.todoSummary = getTodoSummary(details.todos, record.todoSummary)
              }
            }
          }
          break
        }
        case 'tool_execution_start': {
          record.thinking = false
          record.lastActivity = `running ${event.toolName}`
          break
        }
        case 'tool_execution_end': {
          record.lastActivity = `${event.isError ? 'failed' : 'finished'} ${event.toolName}`
          break
        }
        case 'agent_end': {
          record.thinking = false
          break
        }
      }

      record.updatedAt = Date.now()
      setActiveSubagent(record, input.ctx)
      maybeEmitToolUpdate(input.source, input.onUpdate)
    })

    const abortSubagent = () => {
      void session.abort()
    }

    if (merged.signal.aborted) {
      abortSubagent()
    } else {
      merged.signal.addEventListener('abort', abortSubagent, { once: true })
    }

    try {
      await session.prompt(prompt, { source: 'extension' })

      const finalAssistant = [...session.messages].reverse().find((message) => message.role === 'assistant') as
        | Message
        | undefined
      const finalText = finalAssistant ? extractAssistantText(finalAssistant) : ''
      record.lastResponse = truncatePreview(finalText, RESPONSE_PREVIEW_LIMIT)
      record.lastActivity = 'completed'
      record.status = 'completed'
      record.thinking = false
      record.updatedAt = Date.now()

      if (persist) {
        await writeGlobalRecord(record)
        pi.appendEntry(SAVE_TYPE, record)
        updateKnownSubagent(record)
        return record
      }

      if (hadPersistentState) {
        return disposeSubagentRecord(record, input.ctx, { allowActive: true })
      }

      return record
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      record.status = merged.signal.aborted ? 'aborted' : 'error'
      record.lastError = message
      record.lastActivity = record.status === 'aborted' ? 'aborted' : 'error'
      record.thinking = false
      record.updatedAt = Date.now()

      if (persist) {
        await writeGlobalRecord(record)
        pi.appendEntry(SAVE_TYPE, record)
        updateKnownSubagent(record)
        return record
      }

      if (hadPersistentState) {
        return disposeSubagentRecord(record, input.ctx, { allowActive: true })
      }

      return record
    } finally {
      unsubscribe()
      merged.signal.removeEventListener('abort', abortSubagent)
      merged.cleanup()
      clearActiveSubagent(record.id, input.ctx)
      session.dispose()
    }
  }

  async function getSerializedConversation(ctx: ExtensionContext) {
    const conversation = buildSessionContext(ctx.sessionManager.getBranch(), ctx.sessionManager.getLeafId()).messages
    return serializeConversation(convertToLlm(conversation))
  }

  async function runMultipleSubagents(input: {
    tasks: RunTaskInput[]
    ctx: ExtensionContext
    signal?: AbortSignal
    source: RunResultDetails['source']
    onUpdate?: (partial: { content: Array<{ type: 'text'; text: string }>; details: RunResultDetails }) => void
  }) {
    const needsConversation = input.tasks.some((task) => (task.contextMode ?? 'task_only') === 'full_conversation')
    const serializedConversation = needsConversation ? await getSerializedConversation(input.ctx) : undefined

    return mapWithConcurrencyLimit(input.tasks, MAX_CONCURRENCY, async (task) => {
      const now = Date.now()
      const id = `sg_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      const record: StoredSubagent = {
        id,
        sessionId: '',
        sessionFile: '',
        title: makeTitle(task.task, task.title),
        task: task.task,
        model: task.model,
        tools: sanitizeToolAllowlist(task.tools),
        persist: shouldPersistSubagent(task.persist),
        contextMode: task.contextMode ?? 'task_only',
        status: 'running',
        lastActivity: 'queued',
        lastResponse: '',
        thinking: false,
        todoSummary: defaultTodoSummary(),
        createdAt: now,
        updatedAt: now,
      }

      return runSingleSubagent({
        record,
        task: task.task,
        instructions: task.instructions,
        contextMode: task.contextMode ?? 'task_only',
        serializedConversation,
        modelRef: task.model,
        tools: task.tools,
        persist: task.persist,
        source: input.source,
        ctx: task.cwd ? { ...input.ctx, cwd: task.cwd } : input.ctx,
        signal: input.signal,
        onUpdate: input.onUpdate,
      })
    })
  }

  pi.on('session_start', async (_event, ctx) => {
    latestUiContext = ctx
    syncKnownSubagents(ctx)
    refreshUi(ctx)
  })

  pi.on('session_tree', async (_event, ctx) => {
    latestUiContext = ctx
    syncKnownSubagents(ctx)
    refreshUi(ctx)
  })

  pi.on('session_shutdown', async () => {
    activeSubagents = new Map()
    latestUiContext = null
  })

  pi.registerTool({
    name: 'subagent_run',
    label: 'Subagent Run',
    description:
      'Run one or more subagents. Supports concurrent execution, custom instructions, model selection, inherited or explicit tool allowlists, optional persistence, and optional full parent conversation context.',
    promptSnippet:
      'Run one or more subagents, optionally in parallel and with inherited or per-task tool allowlists, optional persistence, and return each subagent id with its latest result.',
    promptGuidelines: [
      'Use subagent_run when work can be delegated and especially when multiple independent subtasks can run in parallel.',
      'Use subagent_run.tasks to launch multiple subagents simultaneously.',
      'By default, subagent_run inherits the parent agent\'s currently active tools (excluding subagent tools).',
      'Set task.tools to a tool-name allowlist when a subagent should use only selected tools instead of the inherited tool set.',
      'Use subagent_run with contextMode full_conversation when the subagent needs the parent conversation context.',
      'Use subagent_resume for follow-up work on a previous subagent id so its history is preserved.',
      'By default, subagent_run persists subagent sessions for later resume.',
      'Set task.persist to false for fire-and-forget work that should be cleaned up automatically after completion.',
      'Use subagent_dispose when a persisted subagent is no longer needed and its session should be deleted.',
      'Use subagent_list if you need to inspect the known subagent ids before resuming one.',
    ],
    parameters: subagentRunSchema,
    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as { tasks: RunTaskInput[] }
      if (!Array.isArray(params.tasks) || params.tasks.length === 0) {
        throw new Error('subagent_run requires at least one task')
      }

      if (params.tasks.length > MAX_TASKS) {
        throw new Error(`Too many subagent tasks (${params.tasks.length}). Max is ${MAX_TASKS}.`)
      }

      const results = await runMultipleSubagents({
        tasks: params.tasks,
        ctx,
        signal,
        source: 'subagent_run',
        onUpdate,
      })

      return {
        content: [{ type: 'text', text: formatRunResultText(results) }],
        details: buildUpdateDetails('subagent_run', results),
      }
    },
    renderCall(args, theme) {
      const tasks = ((args as { tasks?: RunTaskInput[] }).tasks ?? []).map((task) => makeTitle(task.task, task.title))
      return new Text(
        tasks.length <= 1
          ? `${theme.fg('toolTitle', theme.bold('subagent_run '))}${theme.fg('muted', tasks[0] ?? '1 task')}`
          : `${theme.fg('toolTitle', theme.bold('subagent_run '))}${theme.fg('muted', `${tasks.length} tasks in parallel`)}`,
        0,
        0
      )
    },
    renderResult(result, options, theme) {
      const details = result.details as RunResultDetails | undefined
      const records = details?.subagents ?? []
      if (records.length === 0) {
        return new Text('No subagent results.', 0, 0)
      }

      if (!options.expanded) {
        const lines = records.flatMap((record) => {
          const statusIcon =
            record.status === 'completed'
              ? theme.fg('success', '✓')
              : record.status === 'aborted'
                ? theme.fg('warning', '⏹')
                : record.status === 'error'
                  ? theme.fg('error', '✗')
                  : theme.fg('accent', '↻')
          return [
            `${statusIcon} ${theme.fg('accent', record.id)} ${theme.fg('text', record.title)}`,
            theme.fg('muted', `  ${truncatePreview(record.lastResponse || record.lastActivity || '(no output)', 120)}`),
          ]
        })
        return new Text(lines.join('\n'), 0, 0)
      }

      const mdTheme = getMarkdownTheme()
      const container = new Container()
      for (const record of records) {
        const statusColor =
          record.status === 'completed'
            ? 'success'
            : record.status === 'aborted'
              ? 'warning'
              : record.status === 'error'
                ? 'error'
                : 'accent'
        container.addChild(
          new Text(
            theme.fg(statusColor, theme.bold(record.id)) +
              theme.fg('text', ` ${record.title}`) +
              theme.fg('muted', ` • ${record.status} • ${record.model ?? 'default model'}`),
            0,
            0
          )
        )
        container.addChild(new Text(theme.fg('dim', `Task: ${record.task}`), 0, 0))
        if (record.todoSummary.total > 0) {
          const todoLine = `Todos: ${record.todoSummary.completed}/${record.todoSummary.total} completed`
          container.addChild(new Text(theme.fg('muted', todoLine), 0, 0))
        }
        if (record.lastResponse) {
          container.addChild(new Spacer(1))
          container.addChild(new Markdown(record.lastResponse, 0, 0, mdTheme))
        }
        if (record.lastError) {
          container.addChild(new Text(theme.fg('error', `Error: ${record.lastError}`), 0, 0))
        }
        container.addChild(new Spacer(1))
      }
      return container
    },
  })

  pi.registerTool({
    name: 'subagent_resume',
    label: 'Subagent Resume',
    description:
      'Resume a previously created subagent session by id and continue the work with follow-up instructions, optionally using inherited tools or a custom tool allowlist.',
    promptSnippet:
      'Resume a previous subagent by id, optionally with inherited tools or a custom tool allowlist, so its existing context and history are preserved.',
    promptGuidelines: [
      'Use subagent_resume when a previous subagent id already exists and you want to continue from its history.',
      'By default, subagent_resume reuses the subagent\'s stored tool allowlist, or otherwise inherits the parent agent\'s active tools.',
      'By default, subagent_resume keeps the subagent persisted unless persist is set to false.',
      'Set tools to a tool-name allowlist when the resumed subagent should use only selected tools.',
      'Set persist to false when the resumed subagent should be cleaned up automatically after this follow-up finishes.',
      'Use subagent_dispose when a persisted subagent is no longer needed and its session should be deleted.',
      'Use subagent_list if you need to inspect available subagent ids before resuming one.',
    ],
    parameters: subagentResumeSchema,
    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as {
        id: string
        task: string
        model?: string
        instructions?: string
        tools?: string[]
        persist?: boolean
      }
      const existing = await lookupStoredSubagent(params.id, knownSubagents)
      if (!existing) {
        throw new Error(`Unknown subagent id: ${params.id}`)
      }

      const record: StoredSubagent = {
        ...existing,
        task: params.task,
        title: existing.title,
        status: 'running',
        lastActivity: 'queued resume',
        lastError: undefined,
        thinking: false,
        updatedAt: Date.now(),
        disposedAt: undefined,
        persist: shouldPersistSubagent(params.persist, existing.persist),
      }

      const result = await runSingleSubagent({
        record,
        task: params.task,
        instructions: params.instructions,
        contextMode: 'task_only',
        modelRef: params.model,
        tools: params.tools ?? existing.tools,
        persist: params.persist,
        source: 'subagent_resume',
        ctx,
        signal,
        onUpdate,
      })

      return {
        content: [{ type: 'text', text: formatRunResultText([result]) }],
        details: buildUpdateDetails('subagent_resume', [result]),
      }
    },
    renderCall(args, theme) {
      const params = args as { id?: string; task?: string }
      return new Text(
        `${theme.fg('toolTitle', theme.bold('subagent_resume '))}${theme.fg('accent', params.id ?? '?')} ${theme.fg('muted', truncatePreview(params.task ?? '', 60))}`,
        0,
        0
      )
    },
  })

  pi.registerTool({
    name: 'subagent_dispose',
    label: 'Subagent Dispose',
    description: 'Delete a persisted subagent session and remove its saved resume state when it is no longer needed.',
    promptSnippet: 'Dispose a persisted subagent when its session history is no longer needed.',
    promptGuidelines: [
      'Use subagent_dispose after a persisted subagent is no longer needed and you want to delete its saved session/history.',
      'Use subagent_dispose instead of leaving old completed subagent sessions around indefinitely.',
    ],
    parameters: subagentDisposeSchema,
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      syncKnownSubagents(ctx)
      const params = rawParams as { id: string }
      const existing = await lookupStoredSubagent(params.id, knownSubagents)
      if (!existing) {
        throw new Error(`Unknown subagent id: ${params.id}`)
      }

      const disposed = await disposeSubagentRecord(existing, ctx)
      return {
        content: [{ type: 'text', text: `Disposed subagent ${disposed.id}.` }],
        details: buildUpdateDetails('subagent_dispose', []),
      }
    },
  })

  pi.registerTool({
    name: 'subagent_list',
    label: 'Subagent List',
    description: 'List known subagent ids and their latest saved state for the current session branch.',
    promptSnippet: 'List known subagent ids and statuses before choosing one to resume.',
    promptGuidelines: ['Use subagent_list when you need to inspect which subagent ids are available to resume.'],
    parameters: Type.Object({}),
    async execute(_toolCallId, _rawParams, _signal, _onUpdate, ctx) {
      syncKnownSubagents(ctx)
      const records = knownSubagents
      return {
        content: [{ type: 'text', text: records.length === 0 ? 'No known subagents.' : formatRunResultText(records) }],
        details: buildUpdateDetails('subagent_list', records),
      }
    },
  })

  pi.registerCommand('subagents', {
    description: 'Show the known subagents for the current session branch',
    handler: async (_args, ctx) => {
      syncKnownSubagents(ctx)
      const text =
        knownSubagents.length === 0
          ? 'No known subagents.'
          : knownSubagents.map((record) => formatSubagentRecord(record)).join('\n\n')
      ctx.ui.notify(text, 'info')
    },
  })

  pi.registerCommand('subagent-dispose', {
    description: 'Dispose a persisted subagent by id and delete its saved session state',
    getArgumentCompletions(prefix) {
      const items = knownSubagents
        .filter((record) => record.id.startsWith(prefix))
        .map((record) => ({ value: record.id, label: `${record.id} • ${record.title}` }))
      return items.length > 0 ? items : null
    },
    handler: async (args, ctx) => {
      syncKnownSubagents(ctx)
      const id = args.trim()
      if (!id) {
        ctx.ui.notify('Usage: /subagent-dispose <id>', 'warning')
        return
      }

      const existing = await lookupStoredSubagent(id, knownSubagents)
      if (!existing) {
        ctx.ui.notify(`Unknown subagent id: ${id}`, 'error')
        return
      }

      await disposeSubagentRecord(existing, ctx)
      ctx.ui.notify(`Disposed subagent ${id}.`, 'info')
    },
  })
}
