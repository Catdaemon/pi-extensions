import type { Theme } from '@earendil-works/pi-coding-agent'
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

type CardEntry = {
  order: number
  height: number
  visible: boolean
  onChange?: () => void
}

type StatusCardState = {
  entries: Map<string, CardEntry>
  sidebarVisible: boolean
}

export const STATUS_CARD_OVERLAY_WIDTH = 44
export const STATUS_CARD_GAP = 1

const STATUS_CARD_STATE_KEY = Symbol.for('pi.agent.statusCards.state')

const statusCardState = ((globalThis as typeof globalThis & { [STATUS_CARD_STATE_KEY]?: StatusCardState })[STATUS_CARD_STATE_KEY] ??= {
  entries: new Map<string, CardEntry>(),
  sidebarVisible: true,
})

const cardEntries = statusCardState.entries

export function isStatusCardSidebarEnabled(): boolean {
  return statusCardState.sidebarVisible
}

export function isStatusCardSidebarVisible(termWidth: number): boolean {
  return statusCardState.sidebarVisible && termWidth >= 110
}

export function setStatusCardSidebarVisible(visible: boolean): boolean {
  if (statusCardState.sidebarVisible === visible) return visible
  statusCardState.sidebarVisible = visible
  notifyStatusCards()
  return visible
}

export function toggleStatusCardSidebar(): boolean {
  return setStatusCardSidebarVisible(!statusCardState.sidebarVisible)
}

export function renderStatusCard(theme: Pick<Theme, 'fg' | 'bold'>, title: string, bodyLines: string[], width: number): string[] {
  const innerWidth = Math.max(1, width - 2)
  const border = (text: string) => theme.fg('border', text)
  const pad = (text: string) => {
    const truncated = truncateToWidth(text, innerWidth, '...', true)
    return truncated + ' '.repeat(Math.max(0, innerWidth - visibleWidth(truncated)))
  }

  return [
    border(`╭${'─'.repeat(innerWidth)}╮`),
    border('│') + pad(theme.fg('accent', theme.bold(` ${title}`))) + border('│'),
    border('├') + border('─'.repeat(innerWidth)) + border('┤'),
    ...bodyLines.map((line) => border('│') + pad(line) + border('│')),
    border('╰') + border('─'.repeat(innerWidth)) + border('╯'),
  ]
}

export function registerStatusCard(id: string, order: number, onChange?: () => void): void {
  const existing = cardEntries.get(id)
  cardEntries.set(id, {
    order,
    height: existing?.height ?? 0,
    visible: existing?.visible ?? false,
    onChange,
  })
  notifyStatusCards()
}

export function unregisterStatusCard(id: string): void {
  if (!cardEntries.delete(id)) return
  notifyStatusCards()
}

export function updateStatusCardLayout(id: string, input: { height: number; visible: boolean }): void {
  const entry = cardEntries.get(id)
  if (!entry) return
  const height = Math.max(0, input.height)
  if (entry.height === height && entry.visible === input.visible) return
  entry.height = height
  entry.visible = input.visible
  notifyStatusCards()
}

export function getStatusCardTop(id: string, baseTop = 0, gap = STATUS_CARD_GAP): number {
  const entries = [...cardEntries.entries()]
    .filter(([, entry]) => entry.visible)
    .sort((a, b) => a[1].order - b[1].order)

  let top = baseTop
  for (const [entryId, entry] of entries) {
    if (entryId === id) return top
    top += entry.height + gap
  }
  return top
}

function notifyStatusCards(): void {
  for (const entry of cardEntries.values()) entry.onChange?.()
}
