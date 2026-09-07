# Changelog

All notable changes to the Moe VS Code extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.0] - 2026-09-07

### Added
- Grok Build (xAI) as an agent CLI, alongside Claude Code, Codex and Gemini CLI.
- Task dependencies with automatic unblock when prerequisites finish; shared resources (daemon-managed exclusive leases).

### Changed
- Marketplace name is now "Moe's Tavern"; the extension id stays `yaront1111.moe-vscode`.
- Launchers land a task-linked commit on every exit (completion or `wip` checkpoint) with rescue refs when landing fails.

### Fixed
- Headless Codex launch for codex-cli 0.147 and later (`--full-auto` removed upstream); the launcher now probes its argv before launching instead of relaunch-looping.

## [0.6.0] - 2026-04-21

### Added

- 8-phase skill system: 13 curated skills (`.moe/skills/<name>/SKILL.md`) shipped
  inside the .vsix and scaffolded into every Moe project on init.
  - 5 Moe-native: `moe-planning`, `explore-before-assume`,
    `adversarial-self-review`, `regression-check`, `moe-qa-loop`.
  - 8 vendored from `obra/superpowers` (MIT, attributed): TDD,
    verification-before-completion, systematic-debugging, brainstorming,
    writing-plans, receiving-code-review, using-git-worktrees,
    dispatching-parallel-agents.
- Daemon `nextAction.recommendedSkill` populated per phase (planning, test step,
  final step, blocked, reopened, REVIEW, before-complete-task).
- Agent wrapper injects an "Available Skills" index into the system prompt.

### Fixed

- `AntigravityIntegration.ts` proxy lookup path corrected
  (`bundled/proxy/index.js` is the real path; `bundled/proxy/dist/index.js`
  was a dead reference).

## [0.1.0] - 2026-02-05

### Added

- Initial release
- Kanban board sidebar panel with 6 status columns
- Drag-and-drop task status changes
- Task detail view with approve/reject/reopen actions
- WebSocket connection to moe-daemon
- Status bar item showing connection status
- Auto-connect when workspace contains .moe folder
- Extension settings for daemon host/port configuration
