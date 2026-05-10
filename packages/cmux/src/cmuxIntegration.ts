import { join } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import {
  clearCmuxStatus,
  getCmuxSurface,
  getCmuxWorkspace,
  isCmuxEnvironment,
  notifyCmuxDone,
  setCmuxStatus,
} from './cmux.ts'

const DEFAULT_STATUS_KEY = 'pi-agent'
const SUBAGENT_SESSION_DIR = join(getAgentDir(), 'subagents', 'sessions')

export type CmuxIntegrationConfig = {
  statusKey: string
  notifyDone: boolean
  includePromptPreviewInStatus: boolean
  includeSubagents: boolean
}

type ActiveTurn = {
  prompt: string
  startedAt: number
}

type FinishedTurn = ActiveTurn & {
  remainingActiveTurns: number
}

export type CmuxTurnTracker = {
  start(input: { key: string; prompt: string; ignored: boolean; now: number }): void
  finish(key: string): FinishedTurn | undefined
  activeCount(): number
}

function createTurnTracker(): CmuxTurnTracker {
  const activeTurns = new Map<string, ActiveTurn>()
  const ignoredTurns = new Set<string>()

  return {
    start(input) {
      activeTurns.delete(input.key)
      ignoredTurns.delete(input.key)
      if (input.ignored) {
        ignoredTurns.add(input.key)
        return
      }
      activeTurns.set(input.key, { prompt: input.prompt, startedAt: input.now })
    },
    finish(key) {
      if (ignoredTurns.delete(key)) return undefined
      const turn = activeTurns.get(key)
      activeTurns.delete(key)
      if (!turn) return undefined
      return { ...turn, remainingActiveTurns: activeTurns.size }
    },
    activeCount() {
      return activeTurns.size
    },
  }
}

export function createCmuxTurnTrackerForTest(): CmuxTurnTracker {
  return createTurnTracker()
}

function readConfig(env: NodeJS.ProcessEnv = process.env): CmuxIntegrationConfig {
  return {
    statusKey: env.PI_CMUX_STATUS_KEY || DEFAULT_STATUS_KEY,
    notifyDone: env.PI_CMUX_NOTIFY_DONE !== '0',
    includePromptPreviewInStatus: env.PI_CMUX_STATUS_PREVIEW === '1',
    includeSubagents: env.PI_CMUX_INCLUDE_SUBAGENTS === '1',
  }
}

function truncatePreview(text: string, limit = 140) {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit - 3)}...`
}

function isSubagentSession(ctx: ExtensionContext) {
  const file = ctx.sessionManager.getSessionFile()
  return Boolean(file && file.startsWith(SUBAGENT_SESSION_DIR))
}

function isSubagentPrompt(prompt: string) {
  return prompt.trimStart().startsWith('You are a subagent helping another pi agent.')
}

function shouldIgnoreTurn(ctx: ExtensionContext, prompt: string, config: CmuxIntegrationConfig) {
  return !config.includeSubagents && (isSubagentSession(ctx) || isSubagentPrompt(prompt))
}

function sessionKey(ctx: ExtensionContext) {
  return ctx.sessionManager.getSessionFile() ?? ctx.cwd
}

export default function cmuxIntegration(pi: ExtensionAPI) {
  const turnTracker = createTurnTracker()
  const config = readConfig()

  pi.on('before_agent_start', async (event, ctx) => {
    const key = sessionKey(ctx)
    if (!isCmuxEnvironment()) {
      turnTracker.finish(key)
      return undefined
    }

    const ignored = shouldIgnoreTurn(ctx, event.prompt, config)
    const preview = truncatePreview(event.prompt)
    turnTracker.start({ key, prompt: preview, ignored, now: Date.now() })
    if (ignored) return undefined
    const status = config.includePromptPreviewInStatus ? `Running: ${truncatePreview(event.prompt, 48)}` : 'Running'
    void setCmuxStatus(pi, config.statusKey, status, { icon: 'sparkles', color: '#3b82f6', signal: ctx.signal })
    return undefined
  })

  pi.on('agent_end', async (_event, ctx) => {
    const key = sessionKey(ctx)
    const finished = turnTracker.finish(key)
    if (!isCmuxEnvironment() || !finished) return

    const elapsed = Math.max(1, Math.round((Date.now() - finished.startedAt) / 1000))
    if (finished.remainingActiveTurns === 0) {
      void setCmuxStatus(pi, config.statusKey, `Idle (${elapsed}s)`, { icon: 'check', color: '#34c759', signal: ctx.signal })
    }

    if (config.notifyDone) {
      const body = finished.prompt ? `Finished: ${finished.prompt}` : 'Agent finished and is ready for your next message.'
      void notifyCmuxDone(pi, elapsed ? `${body}\nElapsed: ${elapsed}s` : body, {
        title: 'Pi',
        subtitle: 'Done',
        signal: ctx.signal,
      })
    }
  })

  pi.on('session_shutdown', async () => {
    if (!isCmuxEnvironment()) return
    void clearCmuxStatus(pi, config.statusKey)
  })

  pi.registerCommand('cmux-status', {
    description: 'Show cmux integration status and environment wiring.',
    handler: async (_args, ctx) => {
      const message = [
        `cmux: ${isCmuxEnvironment() ? 'enabled' : 'not detected'}`,
        `workspace: ${getCmuxWorkspace() ?? '(none)'}`,
        `surface: ${getCmuxSurface() ?? '(none)'}`,
        `status key: ${config.statusKey}`,
        `done notifications: ${config.notifyDone ? 'on' : 'off'}`,
        `subagent turns: ${config.includeSubagents ? 'included' : 'ignored'}`,
      ].join('\n')
      if (ctx.hasUI) ctx.ui.notify(message, 'info')
      else console.log(message)
    },
  })
}
