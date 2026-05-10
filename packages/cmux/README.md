# pi-cmux

cmux status and notification integration for Pi.

## Why

When Pi runs inside cmux, it is useful for the surrounding workspace to know whether the agent is busy, idle, or waiting for attention. Without an integration, the user has to keep checking the Pi surface manually to see whether a turn has finished or whether an approval prompt needs feedback.

`pi-cmux` bridges Pi and cmux with lightweight status updates and notifications. It keeps the cmux surface informed while avoiding noise from subagent sessions by default.

This is especially useful for:

- Seeing at a glance whether Pi is currently working
- Getting notified when an agent turn finishes
- Surfacing approval prompts from guard extensions
- Sharing cmux notification helpers with other Pi extensions

## What it does

This Pi package adds cmux integration to Pi:

- **Agent status updates**: sets a cmux status while the main agent is running and returns it to idle when the turn ends.
- **Done notifications**: sends a cmux notification when a main agent turn completes.
- **Feedback notifications**: exports helpers that other extensions can use to notify cmux when user feedback is needed.
- **Subagent filtering**: suppresses subagent turn noise by default.
- **Runtime status command**: `/cmux-status` shows whether cmux environment variables are detected and how the integration is configured.
- **Environment configuration**: supports `PI_CMUX_STATUS_KEY`, `PI_CMUX_NOTIFY_DONE`, `PI_CMUX_STATUS_PREVIEW`, and `PI_CMUX_INCLUDE_SUBAGENTS`.

## Install from npm

```bash
pi install npm:@catdaemon/pi-cmux
```

Then reload Pi:

```text
/reload
/cmux-status
```

## Runtime dependencies

This package expects the `cmux` CLI to be available when Pi is running inside cmux. Outside cmux, it safely no-ops.

Other Pi extensions can import its notification helpers when they need to signal cmux feedback or completion events.
