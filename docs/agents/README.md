# Moe Agents

This directory contains the **Claude Code subagent definitions** (`moe-*.md`) that are bundled into new projects: `generate-init-files.ts` vendors them into the daemon, `init` writes them to `.moe/agents/`, and the agent launchers mirror them to `.claude/agents/` (gated by `settings.enableAgentTeams`).

Per-role workflow guides live in [`docs/roles/`](../roles/) — those are the docs agents actually load at launch.

## Overview

Moe uses a multi-agent workflow where specialized AI agents handle different phases of task completion. Each agent has specific responsibilities and uses dedicated MCP tools.

```mermaid
graph LR
    H[Human] -->|creates tasks| B[BACKLOG]
    B -->|human moves| P[PLANNING]
    P -->|claims| A[Architect]
    A -->|submits plan| AA[AWAITING_APPROVAL]
    AA -->|human approves| W[WORKING]
    W -->|claims| WK[Worker]
    WK -->|implements| R[REVIEW]
    R -->|claims| RV[Reviewer]
    RV -->|qa_approve| D[DONE]
    RV -->|qa_reject| W
```

Agents claim only PLANNING (architect), WORKING (worker), and REVIEW
(reviewer/QA) — `claim_next_task` rejects every other column. BACKLOG,
AWAITING_APPROVAL, and DONE are human-gated.

## Agent Roles

| Role | Status Focus | Primary Action |
|------|--------------|----------------|
| [Architect](../roles/architect.md) | PLANNING | Creates implementation plans |
| [Worker](../roles/worker.md) | WORKING | Implements approved plans |
| [QA](../roles/qa.md) | REVIEW | QA, testing, approval |
| [Governor](../roles/governor.md) | — | Fleet oversight (never claims tasks) |

## Subagent Definitions

| File | Purpose |
|------|---------|
| `moe-explorer.md` | Read-only codebase exploration during planning |
| `moe-test-runner.md` | Isolated test execution for workers |
| `moe-code-reviewer.md` | Adversarial diff review before `qa_approve` |

## Task Status Flow

```
BACKLOG → PLANNING → AWAITING_APPROVAL → WORKING → REVIEW → DONE
                                            ↑         │
                                            └(qa_reject)┘
```

## Human Oversight

Humans interact with Moe through:
- **JetBrains Plugin**: Visual board, task creation, plan approval/rejection
- **`moe.*` MCP tools / `scripts/moe-call.sh`**: never edit `.moe/` files by hand — the daemon is the sole writer of runtime state

Key human touchpoints:
1. **Task Creation**: Define tasks with clear Definition of Done
2. **Plan Approval**: Review and approve/reject architect plans (AWAITING_APPROVAL)
3. **Final Review**: Optionally review completed work before closing

## Getting Started

1. Start the Moe daemon for your project
2. Configure MCP in your AI CLI (see [MCP_SERVER.md](../MCP_SERVER.md))
3. Run an agent with the appropriate role prompt

See individual role documentation for detailed setup instructions.
