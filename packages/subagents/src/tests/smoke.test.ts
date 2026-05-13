import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import extension from '../../index.ts'
import { extractAssistantError, extractAssistantText, formatRunResultText } from '../piSubagents.ts'

describe('pi-subagents package', () => {
  it('exports a Pi extension factory', () => {
    assert.equal(typeof extension, 'function')
  })

  it('extracts assistant text from string and part-based content', () => {
    assert.equal(extractAssistantText({ role: 'assistant', content: '{"ok":true}' } as any), '{"ok":true}')
    assert.equal(extractAssistantText({ role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] } as any), 'hello')
  })

  it('surfaces assistant stopReason errors', () => {
    assert.equal(
      extractAssistantError({ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'model unavailable' } as any),
      'model unavailable'
    )
  })

  it('labels ephemeral JSON outputs as not resumable', () => {
    const text = formatRunResultText([
      {
        id: 'sg_test',
        sessionId: 's1',
        sessionFile: '',
        title: 'JSON task',
        task: 'Return JSON',
        persist: false,
        contextMode: 'task_only',
        status: 'completed',
        lastActivity: 'completed',
        lastResponse: '{"ok":true}',
        outputJson: { ok: true },
        thinking: false,
        todoSummary: { total: 0, completed: 0, inProgress: 0, lastCompleted: [] },
        createdAt: 1,
        updatedAt: 1,
      } as any,
    ])
    assert.match(text, /ephemeral \(not resumable\)/)
    assert.match(text, /outputJson: \{"ok":true\}/)
  })
})
