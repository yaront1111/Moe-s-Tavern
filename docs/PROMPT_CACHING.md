# Prompt caching for Claude and Codex

Moe's shared PowerShell and Bash launchers preserve prompt prefixes for **both Claude Code and Codex**, across every project using these launchers. The default policy is `strict`. This is CLI integration: Moe does not currently own an Anthropic Messages or OpenAI Responses API client. Each provider CLI owns API cache controls, retention, model eligibility and billing.

## What the launchers enforce

- Stable role instructions stay in the system instructions. Task ids, worker identity, task context, inbox messages, known issues and team context travel separately.
- Codex receives private stable `model_instructions_file` instructions. Its user message points to a private task-context file. The shared project fallback is role-neutral so another role cannot replace the current seat's role or task context.
- Claude keeps `--exclude-dynamic-system-prompt-sections` enabled. On Windows, quoted or large user prompts use a private context file instead of overflowing into the system prompt. Bash sends the user prompt directly.
- Claude preflight rejects known cache-disable environment variables, including model-specific `DISABLE_PROMPT_CACHING_*`, and `MOE_NO_DYNAMIC_PROMPT_EXCLUDE`. It checks user, project, local, local managed settings and command-line `--settings`. Unreadable or malformed settings fail the preflight without printing their contents. Remote managed policy and gateways remain outside this local check.
- Explicit `MOE_PROMPT_CACHE_MODE=inherit` lets the operator use provider controls without this refusal. Prompt separation and usage reporting remain enabled. Invalid mode values fail; there is no automatic fallback from strict to inherit.

These guarantees concern prompt construction and known local controls. They do **not** require a cache hit on a cold request, force unsupported OpenAI configuration fields, or assert that a custom provider/gateway forwards cache controls correctly. A missing helper fails startup rather than silently dropping the policy.

## Measuring cache reuse

Claude headless runs report cumulative result usage; Codex `-CodexExec` / `--codex-exec` runs report each completed turn through `--json`. Example:

```text
[prompt-cache] provider=claude input=2000 read=900 write=1000 uncached=100 hit=45.0%
[prompt-cache] provider=codex input=1000 read=900 write=unknown uncached=100 hit=90.0%
```

`hit` is the fraction of input tokens served from cache, not a percentage bill saving. Anthropic's input, cache-read and cache-write counters are disjoint; Codex cached input is included in its input total. Missing or invalid counters produce `usage=unknown`, never a fabricated zero or successful hit. Codex does not expose a separate write counter in this event. Interactive runs keep the native CLI's usage displays; Moe does not infer cache hits from prompt size or file reads.

Cache entries can expire, models have minimum cacheable lengths, changes to early instructions/tool definitions invalidate later prefixes, and a cache write can cost more than ordinary input. No fixed dollar saving is assumed. Keep model, effort, tools and reusable context stable within a session. Repository files are cached as part of the conversation after the CLI reads them, not as an independent repository cache; changed files still need to be read normally.

## Retention and API migration

Moe preserves the provider's retention defaults. For Claude Code versions that support them, `CLAUDE_CODE_PROMPT_CACHE_TTL` and `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` accept `5m` or `1h`. Choose based on pauses and cache-write costs. There is no documented Codex CLI `prompt_cache_key` configuration in the checked reference, so Moe does not invent one.

A future direct API transport must add provider-specific request construction and usage tests at that transport boundary. Anthropic `cache_control` and OpenAI caching fields are API request fields, not interchangeable CLI flags. This implementation does not migrate authentication or billing to the API.

References checked 2026-09-19: [Claude Code caching](https://code.claude.com/docs/en/prompt-caching), [Anthropic API caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [OpenAI API caching](https://developers.openai.com/api/docs/guides/prompt-caching), [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference), [Codex non-interactive output](https://learn.chatgpt.com/docs/non-interactive-mode).

## Distribution and checks

JetBrains and VS Code package all three `scripts/prompt-cache*.mjs` helpers alongside both agent wrappers. A plugin update and new launcher process are required for projects using an older installed copy. Updating this checkout alone does not establish activation in existing IDE sessions. Source launches use the updated scripts directly. No per-project `.moe/project.json` migration is needed.

```powershell
node --test scripts/tests/prompt-cache.test.mjs scripts/tests/prompt-cache-launcher.test.mjs scripts/tests/taskless-handoff.test.mjs
```

Tests execute real launcher sections in Bash, Windows PowerShell 5.1 and PowerShell 7, exercise usage streams with local subprocesses, and verify provider exit codes and exact context bytes. They do not make billable model requests or establish live cache hit rates.
