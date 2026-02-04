# Moe - Product Requirements Document

> "What'll it be, Homer?"

Status note: This PRD is a forward-looking product vision. The current implementation is an MVP; see `PROJECT.md`, `docs/DEVELOPMENT.md`, and `docs/ARCHITECTURE.md` for what is built today.

## Executive Summary

**Moe** is an AI Workforce Command Center—a project management system purpose-built for AI-assisted coding ("vibe coding"). It bridges the gap between human project planning and AI code execution by providing:

1. A **JetBrains IDE Plugin** (PyCharm, IntelliJ, WebStorm) with a Jira-like project board
2. A **Moe daemon** that gives AI CLI tools (Claude Code, Codex, Gemini) direct access to project state via a proxy
3. A **Handshake Protocol** that enforces "plan before code" discipline

---

## Problem Statement

### Current State of Vibe Coding

Today, developers using AI CLI tools (Claude Code, Codex CLI, Gemini) face these problems:

| Problem | Impact |
|---------|--------|
| **No persistent context** | AI forgets everything between sessions |
| **No task tracking** | No visibility into what AI is doing or should do |
| **No guardrails** | AI can go off-script, break patterns, ignore conventions |
| **No project memory** | Can't plan a 20-task epic and have AI execute sequentially |
| **Manual coordination** | Copy-pasting prompts, manually syncing state |

### The Gap

```
┌─────────────────┐         ??? GAP ???         ┌─────────────────┐
│                 │                             │                 │
│  Human Brain    │  ──────────────────────▶   │  AI CLI Tool    │
│  (has the plan) │                             │  (no memory)    │
│                 │                             │                 │
└─────────────────┘                             └─────────────────┘
```

### Moe Fills the Gap

```
┌─────────────────┐       ┌─────────────┐       ┌─────────────────┐
│                 │       │             │       │                 │
│  Human Brain    │ ────▶ │    MOE      │ ◀──── │  AI CLI Tool    │
│  (has the plan) │       │  (the PM)   │       │  (MCP tools)    │
│                 │       │             │       │                 │
└─────────────────┘       └─────────────┘       └─────────────────┘
                                │
                                ▼
                         .moe/ folder
                         (source of truth)
```

---

## Target Users

### Primary: Solo Developer Vibing

- Uses Claude Code / Codex CLI daily
- Works on multiple side projects
- Wants to plan ahead, have AI execute
- Frustrated by context loss between sessions

### Secondary: Small Team

- 2-5 developers sharing a codebase
- Want to assign different epics to different AI workers
- Need visibility into what each worker is doing

---

## Product Vision

### The Dream Workflow

```
Morning:
1. Open PyCharm with Moe panel
2. See your project board: 3 epics, 12 tasks planned
3. Drag "Implement auth" to In Progress
4. Open terminal, run: claude
5. Claude auto-connects via MCP, sees the task
6. Claude creates a plan, shows in Moe panel
7. You click "Approve"
8. Claude executes, progress bar updates in real-time
9. Task done → auto-PR → moves to Review column
10. You review, merge, next task auto-starts

Lunch:
- Check phone, see 4 tasks completed
- One task blocked, AI is waiting for your input

Evening:
- 8 tasks done, epic complete
- Start next epic tomorrow
```

---

## Core Concepts

### 1. The .moe Folder (Source of Truth)

Every project has a `.moe/` folder containing all state:

```
project/
└── .moe/
    ├── project.json          # Project config + global rails
    ├── epics/
    │   └── {epic-id}.json    # Epic definitions
    ├── tasks/
    │   └── {task-id}.json    # Task definitions + AI plans
    ├── workers/
    │   └── {worker-id}.json  # Active worker state
    ├── proposals/
    │   └── {id}.json         # AI-suggested rail changes
    └── activity.log          # Audit trail
```

### 2. Rails (Constraints)

Three-tier constraint system:

| Tier | Scope | Example |
|------|-------|---------|
| **Global Rails** | Entire project | "Use TypeScript", "No any types" |
| **Epic Rails** | One feature | "Use JWT not sessions", "Follow REST conventions" |
| **Task Rails** | One task | "Use the existing Button component" |

### 3. The Handshake Protocol

AI cannot write code until it submits a plan and gets approval:

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ BACKLOG  │───▶│ PLANNING │───▶│ AWAITING │───▶│ WORKING  │
│          │    │          │    │ APPROVAL │    │          │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
                     │               │               │
                     ▼               ▼               ▼
               AI creates      Human reviews    AI executes
               plan            and approves     step by step
```

### 4. Workers (AI Sessions)

Each AI CLI session is a "worker":

- One worker = one epic = one git branch
- Workers are isolated (can't see other epics)
- Multiple workers can run in parallel on different epics
- Worker state tracked in `.moe/workers/`

### 5. MCP Tools (The Bridge)

AI CLI tools don't read files and hope—they have direct API access:

```typescript
moe.get_context()           // Get project + epic + task + rails
moe.submit_plan(steps)      // Submit implementation plan
moe.check_approval()        // Check if approved to proceed
moe.complete_step(stepId)   // Mark step done
moe.complete_task(prLink)   // Mark task done with PR
moe.report_blocked(reason)  // Signal blocked state
```

**Source of Truth Rule:** AI CLIs must fetch tasks from Moe (via MCP) and must write all status/progress updates back to Moe. Markdown task lists are not a task source.

---

## Feature Requirements

### P0: Must Have (MVP)

| Feature | Description |
|---------|-------------|
| **Project Init** | Create .moe folder with templates |
| **Project Board UI** | Webview panel showing epics/tasks |
| **Task CRUD** | Create, edit, delete tasks in UI |
| **Drag & Drop** | Move tasks between status columns |
| **Moe Daemon** | Expose tools for AI CLI |
| **Handshake Flow** | Plan → Approve → Execute |
| **File Watcher** | Sync .moe changes to UI in real-time |
| **Status Bar** | Show active workers |

### P1: Should Have

| Feature | Description |
|---------|-------------|
| **Multi-project** | Switch between projects |
| **Activity Log View** | See what happened |
| **Plan Diff View** | Visual plan review |
| **Worker Logs** | Stream worker output |
| **Keyboard Shortcuts** | Quick approve, etc. |

### P2: Nice to Have

| Feature | Description |
|---------|-------------|
| **Auto-approve Mode** | Trust mode for experienced users |
| **Conflict Detection** | Warn when workers touch same files |
| **Analytics** | Tasks/day, time to complete |
| **Templates** | Reusable task templates |
| **Team Sync** | Share state across machines |

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Tasks completed per session | 5+ |
| Context switches avoided | 90% |
| Time to first working code | < 5 min |
| Plan approval rate | > 80% first try |
| User retention (weekly) | > 60% |

---

## Non-Goals (V1)

- Real-time collaboration (Google Docs style)
- Cloud sync / account system
- Mobile app
- Integration with actual Jira/Linear
- Support for non-JetBrains IDEs (yet)

---

## Competitive Landscape

| Product | Gap Moe Fills |
|---------|---------------|
| **Cursor** | No project management, no persistent task state |
| **GitHub Copilot** | Autocomplete only, no planning |
| **Jira/Linear** | Not connected to AI tools |
| **Claude Code** | Great CLI, but no persistent memory |

Moe is the **missing layer** between PM tools and AI coding tools.

---

## Open Questions

1. **Monetization**: Free forever? Freemium? Per-seat?
2. **Cloud features**: Sync across machines? Team features?
3. **Other IDEs**: VS Code version? Standalone?
4. **AI Providers**: Just Claude? Support all?

---

## Timeline

| Phase | Duration | Deliverable |
|-------|----------|-------------|
| Phase 1 | 2 weeks | Working plugin + daemon |
| Phase 2 | 2 weeks | Polish, multi-project, activity log |
| Phase 3 | 2 weeks | Public beta, feedback |
| Phase 4 | Ongoing | Iterate based on usage |

---

## Appendix

- [Technical Architecture](./ARCHITECTURE.md)
- [Data Schema](./SCHEMA.md)
- [Moe Daemon MCP Spec](./MCP_SERVER.md)
- [Plugin Spec](./PLUGIN_SPEC.md)
- [UI/UX Spec](./UI_SPEC.md)
- [Development Guide](./DEVELOPMENT.md)
