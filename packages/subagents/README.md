# pi-subagents

Persistent subagent tools and UI for Pi.

## What it does

This Pi package adds tools for delegating work to child Pi agent sessions:

- `subagent_run` starts one or more subagents with bounded concurrency.
- `subagent_resume` continues a known persisted subagent.
- `subagent_dispose` deletes persisted subagent state when it is no longer needed.
- `subagent_list` lists known subagents for the current session branch.

Subagents can run with task-only or full-conversation context, optional model overrides, explicit tool allowlists, optional working directories, and optional persistence. State is stored under Pi's subagent data directory.

## Install from npm

```bash
pi install npm:@catdaemon/pi-subagents
```

Then reload Pi:

```text
/reload
```

## Runtime dependencies

This package is self-contained. It does not require the todo package, but it can summarize todo progress from subagent sessions when todo state exists there.
