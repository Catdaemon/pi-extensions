# pi-subagents

Persistent subagent tools and UI for Pi.

## Why

Some tasks are easier when independent pieces of work can be delegated to smaller agent sessions. A single agent context can become crowded when it needs to inspect many files, compare alternatives, or run several independent investigations.

`pi-subagents` gives Pi a persistent subagent layer. The main agent can launch child Pi sessions with bounded context, explicit tool allowlists, optional model overrides, and resumable state. This makes parallel or delegated investigation possible without overloading the parent conversation.

This is especially useful for:

- Reviewing or researching independent files in parallel
- Running focused investigations with smaller context windows
- Keeping subagent work resumable across turns
- Disposing subagent state when it is no longer needed

## What it does

This Pi package adds persistent subagent tools and UI:

- **`subagent_run`**: starts one or more subagents, optionally in parallel.
- **`subagent_resume`**: continues a known persisted subagent session.
- **`subagent_dispose`**: deletes persisted subagent state when it is no longer needed.
- **`subagent_list`**: lists known subagents and their latest status.
- **Context controls**: supports task-only or full-conversation context.
- **Tool controls**: supports inherited or explicit per-task tool allowlists.
- **Session controls**: supports optional working directories, model overrides, and persistence.
- **Slash commands**: `/subagents` and `/subagent-dispose` expose subagent state in the UI.

## Install from npm

```bash
pi install npm:@catdaemon/pi-subagents
```

Then reload Pi:

```text
/reload
/subagents
```

## Runtime dependencies

This package is self-contained. It stores state under Pi's subagent data directory and does not require the todo package.

When todo state exists in subagent sessions, it can summarize that progress in the parent UI.
