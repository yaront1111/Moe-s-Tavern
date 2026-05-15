---
description: Show the last 10 messages from #general
allowed-tools: [mcp__moe__moe_chat_read]
---

# /moe-chat

Read the most recent chat activity from the `#general` channel.

## Steps

1. Call `moe.chat_read` with:

   ```json
   { "channel": "general", "limit": 10, "maxContentChars": 400 }
   ```

2. Print each message oldest-first as:

   ```
   HH:MM:SS  <sender>: <content>
   ```

   - Use a relative-time tag (`Just now`, `2m ago`, ...) when the timestamp is within the last hour, otherwise `HH:MM`.
   - If `contentTruncated` is true on a message, append `…` and a `(truncated)` hint.
   - Highlight @mentions of the current user (`$MOE_WORKER_ID`) by prefixing the line with `>`.

3. If `messages` is empty, print `#general is quiet.` and stop.

4. If the daemon is unreachable, print the daemon error verbatim.

## Notes

- Read-only. Do NOT call `moe.chat_send` from this command — the user can use `/moe-send` or invoke the MCP tool directly.
- Defaults to `#general`; pass a different channel via `$ARGUMENTS` if provided (and the channel exists).
