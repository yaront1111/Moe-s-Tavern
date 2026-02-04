# Moe's Tavern 🍺

**AI Workforce Command Center** - A JetBrains IDE plugin + daemon system for managing AI task execution with human oversight.

## Overview

Moe provides a task board interface where humans can oversee and approve AI agent work. AI agents claim tasks, submit implementation plans for approval, and execute work step-by-step with full visibility.

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  JetBrains IDE  │────▶│   Moe Daemon    │◀────│   AI Agents     │
│    (Plugin)     │ WS  │  (Task Board)   │ MCP │  (Claude, etc)  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                               │
                               ▼
                          .moe/ folder
                       (source of truth)
```

## Features

- 📋 **Kanban Board** - Visual task management with drag-and-drop
- 🤖 **MCP Protocol** - Standard interface for AI agents
- 👁️ **Human Oversight** - Approve/reject AI plans before execution
- 📊 **Activity Logging** - Full audit trail of all actions
- 🔄 **Real-time Sync** - WebSocket-based live updates

## Quick Start

### Prerequisites
- Node.js 18+
- JDK 17+ (for plugin development)
- IntelliJ IDEA or other JetBrains IDE

### Installation

```bash
# Clone the repo
git clone https://github.com/yaront1111/Moe-s-Tavern.git
cd Moe-s-Tavern

# Build daemon
cd packages/moe-daemon && npm install && npm run build

# Build proxy
cd ../moe-proxy && npm install && npm run build

# Start daemon
node packages/moe-daemon/dist/index.js start --project /path/to/your/project
```

### JetBrains Plugin

```bash
cd moe-jetbrains
./gradlew runIde  # Launch sandbox IDE with plugin
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [MCP Server API](docs/MCP_SERVER.md)
- [Schema Reference](docs/SCHEMA.md)
- [Development Guide](docs/DEVELOPMENT.md)

## Project Structure

```
├── packages/
│   ├── moe-daemon/     # Node.js daemon (WebSocket server)
│   └── moe-proxy/      # MCP stdio proxy for AI agents
├── moe-jetbrains/      # JetBrains IDE plugin (Kotlin)
├── docs/               # Documentation
└── scripts/            # Installation & utility scripts
```

## Agent Roles

| Role | Responsibility | Claims Tasks In |
|------|---------------|-----------------|
| **Architect** | Creates implementation plans | PLANNING |
| **Worker** | Implements approved plans | WORKING |
| **Reviewer** | QA and testing | REVIEW |

## License

MIT - See [LICENSE](LICENSE) for details.

---

*"Welcome to Moe's Tavern - where AI agents come to get their work done!"*
