import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from '@earendil-works/pi-coding-agent'
import { StringEnum } from '@earendil-works/pi-ai'
import type { Component, OverlayHandle, TUI } from '@earendil-works/pi-tui'
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { Type } from 'typebox'
import {
  STATUS_CARD_OVERLAY_WIDTH,
  getStatusCardTop,
  isStatusCardSidebarVisible,
  registerStatusCard,
  renderStatusCard,
  toggleStatusCardSidebar,
  unregisterStatusCard,
  updateStatusCardLayout,
} from '@catdaemon/pi-sidebar'

type TodoStatus = 'pending' | 'in_progress' | 'completed'

type TodoItem = {
  content: string
  status: TodoStatus
  group?: string
}

type TodoGroup = {
  id: string
  label: string
}

type TodoState = {
  groups: TodoGroup[]
  todos: TodoItem[]
  updatedAt: number
}

type TodoDetails = TodoState & {
  source: 'todo_write' | 'todo_read'
}

const DEFAULT_STATE: TodoState = {
  groups: [],
  todos: [],
  updatedAt: 0,
}

const todoItemSchema = Type.Object({
  content: Type.String({
    description: 'Short task description for the todo item.',
  }),
  status: StringEnum(['pending', 'in_progress', 'completed'] as const, {
    description: 'Todo item status.',
  }),
  group: Type.Optional(
    Type.String({
      description:
        'Optional group id this todo belongs to. Prefer grouping related tasks under a group when useful, such as a milestone or phase.',
    })
  ),
})

const todoGroupSchema = Type.Object({
  id: Type.String({ description: 'Stable group id used by todo items, for example "milestone-1".' }),
  label: Type.String({ description: 'Group label, for example a milestone, phase, or workstream name.' }),
})

const todoWriteSchema = Type.Object({
  groups: Type.Optional(
    Type.Array(todoGroupSchema, {
      description:
        'Optional groups for organizing todos, such as milestones or phases. Tasks may be grouped by setting their group id, or left ungrouped.',
    })
  ),
  todos: Type.Array(todoItemSchema, {
    description:
      'The complete current todo list. Always send the full list in its latest state, not just the changed items.',
  }),
})

class EmptyComponent implements Component {
  render(_width: number): string[] {
    return []
  }

  invalidate(): void {}

  dispose(): void {}
}

const TODO_CARD_ID = 'agent-todos'

class TodoSidebarComponent implements Component {
  constructor(
    private getState: () => TodoState,
    private theme: Theme
  ) {}

  render(width: number): string[] {
    const lines = buildTodoCardLines(this.theme, this.getState(), width)
    updateStatusCardLayout(TODO_CARD_ID, { visible: true, height: lines.length })
    return lines
  }

  invalidate(): void {}

  dispose(): void {}
}

function buildTodoCardLines(theme: Theme, state: TodoState, width: number): string[] {
  const summary = getSummary(state.todos)
  const bodyLines: string[] = []
  const bodyWidth = Math.max(1, width - 2)

  if (state.todos.length === 0) {
    bodyLines.push(theme.fg('dim', ' No active todo list'))
    bodyLines.push(theme.fg('dim', ' Agent can create one with'))
    bodyLines.push(theme.fg('dim', ' todo_write on multi-step work'))
  } else {
    bodyLines.push(theme.fg('muted', ` ${summary.completed}/${summary.total} completed • ${summary.inProgress} in progress`))
    bodyLines.push('')

    const groupedIds = new Set<string>()
    for (const group of state.groups) {
      const groupTodos = state.todos.filter((todo) => todo.group === group.id)
      if (groupTodos.length === 0) continue
      groupedIds.add(group.id)
      bodyLines.push(...wrapStyledLine(' ', group.label, (text) => theme.fg('accent', theme.bold(text)), bodyWidth))
      for (const todo of groupTodos) bodyLines.push(...formatTodoCardItem(theme, todo, bodyWidth, '  '))
    }

    const ungroupedTodos = state.todos.filter((todo) => !todo.group || !groupedIds.has(todo.group))
    if (ungroupedTodos.length > 0) {
      if (state.groups.length > 0 && groupedIds.size > 0) {
        bodyLines.push(...wrapStyledLine(' ', 'Ungrouped', (text) => theme.fg('muted', theme.bold(text)), bodyWidth))
      }
      for (const todo of ungroupedTodos) bodyLines.push(...formatTodoCardItem(theme, todo, bodyWidth, state.groups.length > 0 ? '  ' : ''))
    }
  }

  return renderStatusCard(theme, 'Todo Progress', bodyLines, width)
}

function formatTodoCardItem(theme: Theme, todo: TodoItem, width: number, indent = ''): string[] {
  const icon =
    todo.status === 'completed'
      ? theme.fg('success', '✓')
      : todo.status === 'in_progress'
        ? theme.fg('accent', '→')
        : theme.fg('dim', '○')
  const prefix = ` ${indent}${icon} `
  const style = (text: string) =>
    todo.status === 'completed'
      ? theme.fg('muted', theme.strikethrough(text))
      : todo.status === 'in_progress'
        ? theme.fg('text', text)
        : theme.fg('muted', text)
  return wrapStyledLine(prefix, todo.content, style, width)
}

function wrapStyledLine(prefix: string, text: string, style: (text: string) => string, width: number): string[] {
  const prefixWidth = visibleWidth(prefix)
  const contentWidth = Math.max(1, width - prefixWidth)
  const chunks = wrapWords(text, contentWidth)
  return chunks.map((chunk, index) => `${index === 0 ? prefix : ' '.repeat(prefixWidth)}${style(chunk)}`)
}

function wrapWords(text: string, width: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['']
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (visibleWidth(candidate) <= width) {
      current = candidate
      continue
    }
    if (current) lines.push(current)
    current = word
    while (visibleWidth(current) > width) {
      lines.push(current.slice(0, width))
      current = current.slice(width)
    }
  }
  if (current) lines.push(current)
  return lines
}

function wrapPlainLine(line: string, width: number): string[] {
  const prefix = line.match(/^\s*(?:\[[x> ]\]|#)?\s*/)?.[0] ?? ''
  const content = line.slice(prefix.length)
  const prefixWidth = visibleWidth(prefix)
  if (!content || visibleWidth(line) <= width) return [line]
  return wrapWords(content, Math.max(1, width - prefixWidth)).map(
    (chunk, index) => `${index === 0 ? prefix : ' '.repeat(prefixWidth)}${chunk}`
  )
}

function sanitizeGroups(groups: TodoGroup[] = []): TodoGroup[] {
  const seen = new Set<string>()
  return groups
    .map((group) => ({ id: group.id.trim(), label: group.label.trim() }))
    .filter((group) => {
      if (!group.id || !group.label || seen.has(group.id)) return false
      seen.add(group.id)
      return true
    })
}

function sanitizeTodos(todos: TodoItem[], groups: TodoGroup[] = []): TodoItem[] {
  const groupIds = new Set(groups.map((group) => group.id))
  return todos
    .map((todo) => {
      const group = todo.group?.trim()
      return {
        content: todo.content.trim(),
        status: todo.status,
        ...(group && groupIds.has(group) ? { group } : {}),
      }
    })
    .filter((todo) => todo.content.length > 0)
}

function getSummary(todos: TodoItem[]) {
  return {
    total: todos.length,
    completed: todos.filter((todo) => todo.status === 'completed').length,
    inProgress: todos.filter((todo) => todo.status === 'in_progress').length,
    pending: todos.filter((todo) => todo.status === 'pending').length,
  }
}

function formatTodoList(todos: TodoItem[], groups: TodoGroup[] = []) {
  if (todos.length === 0) {
    return 'No active todo list'
  }

  const lines: string[] = []
  const emitTodo = (todo: TodoItem, indent = '') => {
    const icon = todo.status === 'completed' ? '[x]' : todo.status === 'in_progress' ? '[>]' : '[ ]'
    lines.push(`${indent}${icon} ${todo.content}`)
  }

  const groupedIds = new Set<string>()
  for (const group of groups) {
    const groupTodos = todos.filter((todo) => todo.group === group.id)
    if (groupTodos.length === 0) continue
    groupedIds.add(group.id)
    lines.push(`# ${group.label}`)
    for (const todo of groupTodos) emitTodo(todo, '  ')
  }

  const ungroupedTodos = todos.filter((todo) => !todo.group || !groupedIds.has(todo.group))
  if (ungroupedTodos.length > 0) {
    if (lines.length > 0) lines.push('# Ungrouped')
    for (const todo of ungroupedTodos) emitTodo(todo, lines.length > 0 && groups.length > 0 ? '  ' : '')
  }

  return lines.join('\n')
}

function extractStateFromBranch(ctx: ExtensionContext): TodoState {
  let state = DEFAULT_STATE

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== 'message') continue

    const message = entry.message
    if (message.role !== 'toolResult') continue
    if (message.toolName !== 'todo_write' && message.toolName !== 'todo_read') continue

    const details = message.details as TodoDetails | undefined
    if (!details || !Array.isArray(details.todos)) continue
    if (details.source !== 'todo_write') continue

    const groups = sanitizeGroups(details.groups ?? [])
    state = {
      groups,
      todos: sanitizeTodos(details.todos, groups),
      updatedAt: details.updatedAt ?? 0,
    }
  }

  return state
}

export default function agentTodosExtension(pi: ExtensionAPI) {
  let todoState: TodoState = DEFAULT_STATE
  let hasShownTodoProgress = false
  let sidebarHandle: OverlayHandle | null = null
  let sidebarTui: TUI | null = null
  let sidebarComponent: TodoSidebarComponent | null = null
  let sidebarTop: number | null = null
  let sidebarInitializing = false

  function requestSidebarRender() {
    sidebarTui?.requestRender()
  }

  function hideSidebar() {
    sidebarHandle?.hide()
    sidebarHandle = null
    sidebarTui = null
    sidebarComponent = null
    sidebarTop = null
    sidebarInitializing = false
  }

  function syncSidebarOverlay() {
    if (!sidebarTui || !sidebarComponent) return
    const nextTop = getStatusCardTop(TODO_CARD_ID)
    if (sidebarHandle && sidebarTop === nextTop) {
      requestSidebarRender()
      return
    }
    sidebarHandle?.hide()
    sidebarHandle = sidebarTui.showOverlay(sidebarComponent, {
      nonCapturing: true,
      anchor: 'top-right',
      width: STATUS_CARD_OVERLAY_WIDTH,
      margin: { right: 0, top: nextTop },
      visible: isStatusCardSidebarVisible,
    })
    sidebarTop = nextTop
    requestSidebarRender()
  }

  function updateUi(ctx: ExtensionContext) {
    if (!ctx.hasUI) return

    const summary = getSummary(todoState.todos)

    if (!hasShownTodoProgress) {
      ctx.ui.setStatus('agent-todos', undefined)
      updateStatusCardLayout(TODO_CARD_ID, { visible: false, height: 0 })
      hideSidebar()
      return
    }

    if (summary.total === 0) {
      ctx.ui.setStatus('agent-todos', ctx.ui.theme.fg('dim', '☑ no active todos'))
    } else {
      ctx.ui.setStatus(
        'agent-todos',
        ctx.ui.theme.fg('accent', `☑ ${summary.completed}/${summary.total}`)
      )
    }

    const lines = buildTodoCardLines(ctx.ui.theme, todoState, STATUS_CARD_OVERLAY_WIDTH)
    updateStatusCardLayout(TODO_CARD_ID, { visible: true, height: lines.length })
    ensureSidebar(ctx)
    requestSidebarRender()
  }

  function setState(state: TodoState, ctx?: ExtensionContext) {
    const groups = sanitizeGroups(state.groups)
    todoState = {
      groups,
      todos: sanitizeTodos(state.todos, groups),
      updatedAt: state.updatedAt,
    }

    if (todoState.todos.length > 0) {
      hasShownTodoProgress = true
    }

    if (ctx) {
      updateUi(ctx)
    }
  }

  function ensureSidebar(ctx: ExtensionContext) {
    if (!ctx.hasUI || sidebarTui || sidebarInitializing) return
    sidebarInitializing = true

    void ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      const showOverlay = (tui as TUI & { showOverlay?: TUI['showOverlay'] }).showOverlay
      if (!showOverlay) {
        sidebarInitializing = false
        queueMicrotask(() => done())
        return new EmptyComponent()
      }

      sidebarTui = tui
      sidebarComponent = new TodoSidebarComponent(() => todoState, theme)
      sidebarInitializing = false
      syncSidebarOverlay()

      queueMicrotask(() => done())
      return new EmptyComponent()
    })
  }

  registerStatusCard(TODO_CARD_ID, 100, () => syncSidebarOverlay())

  pi.on('session_start', async (_event, ctx) => {
    const restoredState = extractStateFromBranch(ctx)
    hasShownTodoProgress = restoredState.updatedAt > 0
    setState(restoredState, ctx)
  })

  pi.on('session_tree', async (_event, ctx) => {
    setState(extractStateFromBranch(ctx), ctx)
  })

  pi.on('session_shutdown', async () => {
    updateStatusCardLayout(TODO_CARD_ID, { visible: false, height: 0 })
    unregisterStatusCard(TODO_CARD_ID)
    hideSidebar()
  })

  pi.on('before_agent_start', async () => ({
    message: {
      customType: 'agent-todos-guidance',
      content:
        'For non-trivial user requests, create and maintain a todo list with todo_write. Create the list early, keep it short and concrete, use groups for milestones/phases when helpful, keep at most one item in_progress, and update it as you make progress. Use todo_read if you need to inspect the current list before updating it.',
      display: false,
    },
  }))

  pi.registerTool({
    name: 'todo_write',
    label: 'Todo Write',
    description:
      'Create or replace the current conversation todo list. Use it for multi-step work and update statuses as progress changes.',
    promptSnippet:
      'Create and maintain a task todo list for multi-step work. Replace the whole list each time you update it.',
    promptGuidelines: [
      'Use todo_write for non-trivial user requests that involve multiple steps, files, or tool calls.',
      'Call todo_write early with a short actionable list before doing substantial work.',
      'Use todo_write groups for milestones, phases, or workstreams when they clarify the plan; tasks may also remain ungrouped.',
      'Update todo_write whenever progress changes. Always send the full latest list, not just deltas.',
      'Keep at most one todo item in_progress at a time.',
      'Mark every todo completed before your final response when the work is done.',
      'Use todo_read if the current todo state is uncertain before updating it.',
    ],
    parameters: todoWriteSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = params as { groups?: TodoGroup[]; todos: TodoItem[] }
      const groups = sanitizeGroups(input.groups ?? [])
      const nextState: TodoState = {
        groups,
        todos: sanitizeTodos(input.todos, groups),
        updatedAt: Date.now(),
      }

      setState(nextState, ctx)

      const summary = getSummary(nextState.todos)
      return {
        content: [
          {
            type: 'text',
            text:
              summary.total === 0
                ? 'Cleared the todo list.'
                : `Updated todo list: ${summary.completed}/${summary.total} completed, ${summary.inProgress} in progress.`,
          },
        ],
        details: {
          source: 'todo_write',
          groups: nextState.groups,
          todos: nextState.todos,
          updatedAt: nextState.updatedAt,
        } satisfies TodoDetails,
      }
    },
    renderCall(args, theme) {
      const input = args as { groups?: TodoGroup[]; todos?: TodoItem[] }
      const groups = sanitizeGroups(input.groups ?? [])
      const todos = sanitizeTodos(input.todos ?? [], groups)
      const summary = getSummary(todos)
      return {
        render(width: number) {
          const text =
            summary.total === 0
              ? theme.fg('toolTitle', theme.bold('todo_write ')) + theme.fg('muted', 'clear list')
              : theme.fg('toolTitle', theme.bold('todo_write ')) +
                theme.fg('muted', `${summary.completed}/${summary.total} completed`)
          return [truncateToWidth(text, width)]
        },
        invalidate() {},
      }
    },
    renderResult(result, _options, theme) {
      const details = result.details as TodoDetails | undefined
      const groups = sanitizeGroups(details?.groups ?? [])
      const todos = sanitizeTodos(details?.todos ?? [], groups)
      const lines = todos.length === 0 ? [theme.fg('dim', 'No active todo list')] : formatTodoList(todos, groups).split('\n')
      return {
        render(width: number) {
          return lines.flatMap((line) => wrapPlainLine(line, width))
        },
        invalidate() {},
      }
    },
  })

  pi.registerTool({
    name: 'todo_read',
    label: 'Todo Read',
    description: 'Read the current conversation todo list.',
    promptSnippet: 'Read the current todo list before updating it if needed.',
    promptGuidelines: ['Use todo_read when you need to inspect the current todo list before changing it.'],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      return {
        content: [
          {
            type: 'text',
            text: formatTodoList(todoState.todos, todoState.groups),
          },
        ],
        details: {
          source: 'todo_read',
          groups: todoState.groups,
          todos: todoState.todos,
          updatedAt: todoState.updatedAt,
        } satisfies TodoDetails,
      }
    },
  })

  pi.registerCommand('todos', {
    description: 'Show the current todo list',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const text = formatTodoList(todoState.todos, todoState.groups)
      ctx.ui.notify(text, 'info')
    },
  })

  pi.registerCommand('todos-clear', {
    description: 'Clear the current todo list',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      setState({ groups: [], todos: [], updatedAt: Date.now() }, ctx)
      ctx.ui.notify('Cleared the current todo list', 'info')
    },
  })

  pi.registerCommand('toggle-sidebar', {
    description: 'Show or hide the shared status sidebar',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const visible = toggleStatusCardSidebar()
      requestSidebarRender()
      ctx.ui.notify(`Shared sidebar ${visible ? 'shown' : 'hidden'}`, 'info')
    },
  })
}
