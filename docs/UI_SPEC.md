# Moe - UI/UX Specification

## Design Philosophy

1. **Minimal but visible** — Don't compete with the editor, but always present
2. **Status at a glance** — Know what's happening in < 2 seconds
3. **Keyboard-first** — Power users shouldn't need the mouse
4. **Non-blocking** — Never interrupt flow with mandatory modals

## Current UI (MVP)

- Tool window titled "Moe" on the right.
- Board with six columns (Backlog → Done).
- Drag/drop changes task status.
- Task card shows title only; double-click opens a detail dialog with status, description, and DoD.
- No worker panel, notifications, settings, or status bar widget yet.

Everything below is the target UX spec for future iterations.

---

## Visual Layout

### IDE Integration

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  File  Edit  View  Navigate  Code  Refactor  Build  Run  Tools  Moe  Help  │
├─────────────┬───────────────────────────────────────┬───────────────────────┤
│             │                                       │                       │
│  PROJECT    │           EDITOR                      │   MOE PANEL           │
│  (native)   │           (native)                    │   (our plugin)        │
│             │                                       │                       │
│  📁 src     │   def login(email, password):        │  ┌─────────────────┐  │
│  📁 tests   │       """Login a user"""             │  │  EPIC: Auth     │  │
│  📁 .moe    │       ...                            │  │                 │  │
│             │                                       │  │  ○ Task 1       │  │
│             │                                       │  │  ● Task 2       │  │
│             │                                       │  │  ○ Task 3       │  │
│             │                                       │  └─────────────────┘  │
│             │                                       │                       │
├─────────────┴───────────────────────────────────────┴───────────────────────┤
│  TERMINAL (native)                                    │ 🍺 1 worker active │
│  $ claude                                             │                     │
│  [MOE:worker-1] CODING step 2/4                       │                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Moe Panel Zones

```
┌─────────────────────────────────────┐
│  🍺 Cordum                    [⚙]  │  ← Header: project name, settings
├─────────────────────────────────────┤
│                                     │
│  ═══ Auth Module ═══           ▼   │  ← Epic selector (collapsible)
│                                     │
│  ┌───────────────────────────────┐ │
│  │ ○ JWT Setup                   │ │  ← Task card (backlog)
│  │   DoD: 3 items                │ │
│  └───────────────────────────────┘ │
│                                     │
│  ┌───────────────────────────────┐ │
│  │ ● Login Form    [worker-1]   │ │  ← Task card (working)
│  │   ████████░░ 2/4             │ │     with progress
│  └───────────────────────────────┘ │
│                                     │
│  ┌───────────────────────────────┐ │
│  │ ✓ Error Handling              │ │  ← Task card (done)
│  │   PR: #42                     │ │
│  └───────────────────────────────┘ │
│                                     │
│  [+ Add Task]                       │  ← Quick add button
│                                     │
├─────────────────────────────────────┤
│  WORKERS                            │  ← Worker status section
│  ● worker-1: CODING (Auth/Login)   │
│  ○ worker-2: IDLE                   │
└─────────────────────────────────────┘
```

---

## Color System

### Status Colors

| Status | Color | Hex | Usage |
|--------|-------|-----|-------|
| Backlog | Gray | `#6B7280` | Not started |
| Planning | Yellow | `#F59E0B` | AI creating plan |
| Awaiting Approval | Orange | `#F97316` | Needs human action |
| Working | Green | `#22C55E` | AI executing |
| Review | Blue | `#3B82F6` | PR ready |
| Done | Emerald | `#10B981` | Complete |
| Blocked | Red | `#EF4444` | Needs help |

### Theme Integration

Use JetBrains theme variables:

```kotlin
// Light theme
JBColor.background()      // Card background
JBColor.foreground()      // Text
JBColor.GRAY              // Secondary text

// Custom colors
val STATUS_WORKING = JBColor(Color(0x22C55E), Color(0x22C55E))
val STATUS_BLOCKED = JBColor(Color(0xEF4444), Color(0xEF4444))
```

---

## Components

### Task Card

```
┌─────────────────────────────────────────┐
│ ● Login Form                      [⋮]  │  ← Status dot + title + menu
│                                         │
│ Create login form with validation       │  ← Description (truncated)
│ and error handling...                   │
│                                         │
│ ████████████░░░░░░ 3/5                 │  ← Progress bar (if working)
│                                         │
│ 🤖 worker-1  ⏱ 12m                     │  ← Worker badge + time
└─────────────────────────────────────────┘
```

**States:**

| State | Visual Indicator |
|-------|------------------|
| Backlog | Gray dot, no progress |
| Planning | Yellow dot, pulsing |
| Awaiting | Orange dot, "Review Plan" button |
| Working | Green dot, progress bar |
| Review | Blue dot, PR link |
| Done | Checkmark, strikethrough title |
| Blocked | Red dot, warning icon |

### Epic Header

```
┌─────────────────────────────────────────┐
│ ═══ Authentication Module ═══      [▼] │  ← Collapsible
│ 2/5 tasks complete                      │  ← Progress summary
│ 🤖 1 worker active                      │  ← Worker count
└─────────────────────────────────────────┘
```

### Plan Approval Panel

When a plan is ready for review:

```
┌─────────────────────────────────────────────────────────────┐
│  📋 Plan Ready for Review                              [×]  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Task: Create login form component                          │
│                                                             │
│  Definition of Done:                                        │
│  ☐ Form renders correctly                                   │
│  ☐ Validates email format                                   │
│  ☐ Shows loading during submit                              │
│  ☐ Displays API errors                                      │
│                                                             │
│  ─────────────────────────────────────────────────────────  │
│                                                             │
│  Implementation Plan (4 steps):                             │
│                                                             │
│  1. Create Zod validation schema                            │
│     └─ src/lib/validations/auth.ts                          │
│                                                             │
│  2. Create LoginForm component                              │
│     └─ src/components/auth/LoginForm.tsx                    │
│                                                             │
│  3. Add error handling and loading states                   │
│     └─ src/components/auth/LoginForm.tsx                    │
│                                                             │
│  4. Write unit tests                                        │
│     └─ src/components/auth/LoginForm.test.tsx               │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                        [Reject]  [✓ Approve]                │
└─────────────────────────────────────────────────────────────┘
```

### Worker Status Badge

```
┌─────────────────────────────────┐
│ 🤖 worker-1                     │
│ ● CODING                        │
│ Task: Login Form (step 2/4)     │
│ Branch: moe/auth/login          │
│ ⏱ Active for 12 minutes        │
└─────────────────────────────────┘
```

---

## Interactions

### Drag and Drop

| Action | Result |
|--------|--------|
| Drag task to "In Progress" | Assigns next available worker, starts planning |
| Drag task to "Backlog" | Unassigns worker, task returns to queue |
| Drag task to "Done" | Only allowed if status is REVIEW |

### Click Actions

| Target | Single Click | Double Click |
|--------|--------------|--------------|
| Task card | Select (highlight) | Open detail panel |
| Epic header | Toggle collapse | Edit epic |
| Worker badge | Show status popup | Open worker logs |
| Progress bar | Show step list | Jump to current file |

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Alt+M` | Focus Moe panel |
| `Ctrl+Alt+A` | Approve current plan |
| `Ctrl+Alt+R` | Reject current plan |
| `Ctrl+Alt+N` | New task |
| `↑` / `↓` | Navigate tasks |
| `Enter` | Open selected task |
| `Escape` | Close panel/dialog |

---

## Notifications

### Balloon Notifications

| Event | Priority | Actions |
|-------|----------|---------|
| Plan ready | INFO | [Review] [Dismiss] |
| Task complete | INFO | [View PR] [Dismiss] |
| Worker blocked | WARNING | [View Details] |
| Rail violation | ERROR | [View Details] |

### Status Bar

Always visible in bottom-right:

```
🍺 2 workers active  |  ⏳ 1 awaiting approval
```

Click to open Moe panel.

---

## Empty States

### No .moe folder

```
┌─────────────────────────────────────────┐
│                                         │
│         🍺                              │
│                                         │
│    Moe is not initialized               │
│                                         │
│    Initialize Moe to start managing     │
│    your AI workers.                     │
│                                         │
│         [Initialize Moe]                │
│                                         │
└─────────────────────────────────────────┘
```

### No epics

```
┌─────────────────────────────────────────┐
│                                         │
│    No epics yet                         │
│                                         │
│    Create your first epic to start      │
│    organizing tasks.                    │
│                                         │
│         [Create Epic]                   │
│                                         │
└─────────────────────────────────────────┘
```

### No tasks in epic

```
┌─────────────────────────────────────────┐
│  ═══ Authentication ═══                 │
│                                         │
│    No tasks in this epic                │
│                                         │
│    Break down the epic into tasks       │
│    for your AI workers.                 │
│                                         │
│         [Add Task]                      │
│                                         │
└─────────────────────────────────────────┘
```

### No workers running

```
┌─────────────────────────────────────────┐
│  WORKERS                                │
│                                         │
│    No workers active                    │
│                                         │
│    Start Claude Code in terminal:       │
│    $ claude                             │
│                                         │
└─────────────────────────────────────────┘
```

---

## Responsive Behavior

### Panel Width

| Width | Layout |
|-------|--------|
| < 200px | Collapse to icon only |
| 200-300px | Compact cards |
| 300-400px | Standard layout |
| > 400px | Expanded with descriptions |

### Long Text

- Titles: Truncate with ellipsis after 2 lines
- Descriptions: Truncate after 3 lines, "Show more" link
- File paths: Show filename only, full path on hover

---

## Animations

Keep minimal for IDE context:

| Animation | Duration | Easing |
|-----------|----------|--------|
| Card status change | 200ms | ease-out |
| Progress bar update | 300ms | linear |
| Panel collapse | 150ms | ease-in-out |
| Notification slide | 200ms | ease-out |

---

## Accessibility

- All interactive elements keyboard accessible
- Status colors paired with icons (colorblind safe)
- Screen reader labels for all components
- High contrast mode support via JetBrains themes
- Focus indicators on all focusable elements

---

## Localization

Use JetBrains message bundles:

```properties
# MoeBundle.properties
moe.panel.title=Moe - AI Workforce
moe.task.status.backlog=Backlog
moe.task.status.planning=Planning
moe.task.status.awaiting=Awaiting Approval
moe.task.status.working=Working
moe.task.status.review=Review
moe.task.status.done=Done
moe.action.approve=Approve Plan
moe.action.reject=Reject Plan
moe.notification.plan.ready=Plan ready for review
```

Initial support: English only
Future: Community translations
