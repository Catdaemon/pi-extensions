# pi-agent-todos

Conversation todo tools, prompt guidance, and status sidebar for Pi.

## Why

Longer agent tasks are easier to follow when the agent keeps a small visible plan and updates it as work progresses. Without explicit todo state, multi-step work can drift, finished work may not be marked, and the user has less visibility into what the agent is doing next.

`pi-agent-todos` gives Pi persistent per-session todo tools plus a compact status card. It encourages the agent to create short, actionable todo lists for non-trivial requests and keep them current throughout the turn.

This is especially useful for:

- Making multi-step agent work visible
- Tracking progress across tool calls and edits
- Keeping at most one current task in progress
- Showing todo progress in the shared status sidebar

## What it does

This Pi package adds todo state management to Pi:

- **`todo_write`**: creates or replaces the current conversation todo list.
- **`todo_read`**: reads the current conversation todo list.
- **Prompt guidance**: reminds agents to maintain todos for non-trivial work.
- **Session restoration**: reconstructs todo state from the active session branch.
- **Status card**: shows compact todo progress in the shared sidebar.
- **Slash commands**: `/todos`, `/todos-clear`, and `/toggle-sidebar` expose todo and sidebar controls.

## Install from npm

```bash
pi install npm:@catdaemon/pi-agent-todos
```

Then reload Pi:

```text
/reload
/todos
```

## Runtime dependencies

This package is self-contained. Its published package vendors the shared sidebar helper so users do not need to install `@catdaemon/pi-sidebar` separately.

It shares status-card overlay state with other packages that use the same `pi.agent.statusCards.state` global registry key.
