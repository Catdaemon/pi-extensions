# pi-agent-todos

Conversation todo tools, prompt guidance, and status sidebar for Pi.

## What it does

This Pi package adds:

- `todo_write` for creating or replacing the current conversation todo list.
- `todo_read` for reading the current todo list.
- `/todos` and `/todos-clear` commands.
- `/toggle-sidebar` for showing or hiding the shared status sidebar.
- Automatic prompt guidance that asks agents to maintain a short todo list for non-trivial work.
- A top-right status card that stacks with other packages using the shared status-card registry.

## Install from npm

```bash
pi install npm:@catdaemon/pi-agent-todos
```

Then reload Pi:

```text
/reload
```

## Runtime dependencies

This package is self-contained. It shares status-card overlay state with other packages that use the same `pi.agent.statusCards.state` global registry key.
