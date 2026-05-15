# @moe/claude-plugin

A Claude Code plugin for [Moe](https://github.com/yaront1111/Moe-s-Tavern) — the AI workforce command center. Adds slash commands for inspecting Moe state directly from Claude Code, plus a `PostToolUse` hook that lets the Moe daemon observe agent tool calls without scraping stdout.

## Install

Once published to a marketplace:

```bash
claude plugin install @moe/claude-plugin
```

For local development, point Claude Code at this directory directly (see Claude Code's plugin docs for the current local-install command).

## Quick start

1. Start the Moe daemon: `node packages/moe-daemon/dist/index.js start --project <path>`
2. Open Claude Code in the same project directory.
3. Try `/moe-status` — you should see in-flight tasks and connected workers.
4. Try `/moe-claim worker` to claim the next worker task.

## Commands

| Command | What it does |
|---|---|
| `/moe-status` | List `WORKING` tasks (one line each) and connected workers |
| `/moe-claim <role>` | Claim the next task for `architect`, `worker`, `qa`, or `governor` |
| `/moe-board` | Compact ASCII board: 5 columns x top 5 tasks |
| `/moe-chat` | Last 10 messages from `#general` |

## PostToolUse hook

Every time the agent calls a Moe MCP tool (`mcp__moe__*`), the plugin forwards a small event to the local Moe daemon at `<projectPath>/.moe/daemon.json`. The daemon's `/ws` clients (JetBrains plugin, VS Code extension) see agent activity in real time without parsing stdout.

The hook is **fail-open**: if the daemon is unreachable, the tool call still succeeds. Errors go to stderr only.

Opt out per session:

```bash
export MOE_DISABLE_TOOL_HOOK=1
```

### Event shape

```json
{
  "type": "AGENT_TOOL_EVENT",
  "payload": {
    "workerId": "worker-a1b2c3",
    "tool": "moe.start_step",
    "args": { "taskId": "...", "stepId": "..." },
    "result": { "success": true },
    "durationMs": 42,
    "sessionId": "<claude-session>",
    "timestamp": "2026-05-15T11:22:33.000Z"
  }
}
```

The daemon does not (yet) act on these events — they're for observability and future activity-log enrichment.

## Worker ID resolution

The hook needs to label events with a worker id. Resolution order:

1. `MOE_WORKER_ID` environment variable.
2. SHA1 of Claude's `session_id` → `claude-<hash>`.

If neither is available, the hook silently skips the event.

## Troubleshooting

**"Moe daemon not running"** — Make sure the daemon was started for *this project* (`moe-daemon start --project <path>`). The plugin walks up from your cwd looking for `.moe/daemon.json`. It also checks `~/.moe/projects.json` as a last-resort fallback.

**Port mismatch** — `.moe/daemon.json` records the port the daemon picked. If you see `CONNECT_FAILED`, the daemon probably crashed without cleaning up the file. Stop it (`moe-daemon stop --project <path>`) and start again.

**Hook is silent** — Set `MOE_DISABLE_TOOL_HOOK=0` and verify `MOE_WORKER_ID` is set, then re-run an MCP tool. The hook logs failures to stderr (visible in Claude Code's logs).

**Wrong project picked up** — Set `MOE_PROJECT_PATH=<absolute path>` to force the plugin to use a specific project. This overrides cwd-walk and the registry fallback.

## Plugin manifest

This package uses the standard Claude Code plugin layout:

- `.claude-plugin/plugin.json` — metadata (name, version, author)
- `commands/*.md` — slash-command markdown files with frontmatter
- `hooks/hooks.json` — wires the `PostToolUse` event to `hooks/post-tool-use.mjs`
- `agents/` — reserved for future Moe-specific agents

The `hooks/post-tool-use.mjs` shim is stdlib-only and loads the compiled `dist/postToolUse.js` at runtime.

## Development

```bash
cd packages/moe-claude-plugin
npm install
npm run build
npm test
```

By yaront1111 — part of Moe.
