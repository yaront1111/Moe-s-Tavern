```
 __  __            _        _____
|  \/  | ___   ___( )___   |_   _|_ ___   _____ _ __ _ __
| |\/| |/ _ \ / _ \// __|    | |/ _` \ \ / / _ \ '__| '_ \
| |  | | (_) |  __/ \__ \    | | (_| |\ V /  __/ |  | | | |
|_|  |_|\___/ \___| |___/    |_|\__,_| \_/ \___|_|  |_| |_|
```

<p align="center">
  <strong>AI Workforce Command Center</strong><br>
  Human oversight for AI coding agents
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://github.com/yaront1111/Moe-s-Tavern/releases"><img src="https://img.shields.io/badge/version-0.1.0-green.svg" alt="Version"></a>
  <a href="https://github.com/yaront1111/Moe-s-Tavern/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Mac%20%7C%20Linux-lightgrey.svg" alt="Platform">
</p>

---

## Why Moe?

AI coding agents are powerful but need guardrails. **Moe's Tavern** provides:

- **Visibility** - See what AI agents are doing in a Kanban board
- **Control** - Approve or reject AI plans before code gets written
- **Traceability** - Full audit log of every action
- **Flexibility** - Works with Claude, GPT, and any MCP-compatible agent

> *"Let AI do the coding, but keep humans in the loop."*

---

## Features

| Feature | Description |
|---------|-------------|
| **Kanban Board** | Visual task management in your IDE |
| **Plan Approval** | Review AI implementation plans before execution |
| **Multi-Agent** | Run architect, worker, and reviewer agents |
| **MCP Protocol** | Standard interface for AI agent integration |
| **Real-time Sync** | Live updates via WebSocket |
| **Activity Log** | Complete audit trail with log rotation |
| **Rails System** | Define constraints AI must follow |

---

## Quick Start

### Prerequisites

- **Node.js 18+** - [Download](https://nodejs.org/)
- **JetBrains IDE** (optional) - For visual Kanban board

### Installation

**Windows:**
```powershell
git clone https://github.com/yaront1111/Moe-s-Tavern.git
cd Moe-s-Tavern
.\scripts\install-all.ps1
```

**Mac / Linux:**
```bash
git clone https://github.com/yaront1111/Moe-s-Tavern.git
cd Moe-s-Tavern
chmod +x scripts/*.sh
./scripts/install-mac.sh
```

### Run Your First Agent

```bash
# Windows
.\scripts\moe-agent.ps1 -Role architect -Project "C:\your\project"

# Mac / Linux
./scripts/moe-agent.sh --role architect --project /your/project
```

The agent will:
1. Connect to the daemon
2. Claim a task from the board
3. Submit a plan for your approval
4. Execute the plan step-by-step

---

## Architecture

```mermaid
graph LR
    subgraph IDE
        Plugin[JetBrains Plugin]
    end

    subgraph Backend
        Daemon[Moe Daemon]
        Files[.moe/ files]
    end

    subgraph Agents
        Claude[Claude Code]
        GPT[GPT Agent]
        Other[Other MCP Agents]
    end

    Plugin <-->|WebSocket| Daemon
    Daemon <-->|Read/Write| Files
    Claude <-->|MCP| Daemon
    GPT <-->|MCP| Daemon
    Other <-->|MCP| Daemon
```

**Key Principle:** The `.moe/` folder is the source of truth. The daemon is the sole writer. All clients (plugin, agents) communicate through the daemon.

---

## Project Structure

```
moe/
├── packages/
│   ├── moe-daemon/      # Node.js daemon (TypeScript)
│   └── moe-proxy/       # MCP stdio proxy for agents
├── moe-jetbrains/       # JetBrains IDE plugin (Kotlin)
├── docs/                # Documentation
│   ├── ARCHITECTURE.md  # System design
│   ├── MCP_SERVER.md    # MCP tool reference
│   ├── SCHEMA.md        # Data schema
│   └── DEVELOPMENT.md   # Dev guide
└── scripts/             # Cross-platform install scripts
```

---

## Agent Roles

| Role | Purpose | Claims Tasks In |
|------|---------|-----------------|
| **Architect** | Creates implementation plans | PLANNING status |
| **Worker** | Executes approved plans | WORKING status |
| **Reviewer** | QA and code review | REVIEW status |

---

## Approval Modes

Configure in `.moe/project.json`:

| Mode | Behavior |
|------|----------|
| **CONTROL** | Manual approval required (default) |
| **SPEED** | Auto-approve after delay (configurable) |
| **TURBO** | Instant auto-approve |

---

## Documentation

- [Architecture Overview](docs/ARCHITECTURE.md)
- [MCP Server API](docs/MCP_SERVER.md)
- [Data Schema](docs/SCHEMA.md)
- [Development Guide](docs/DEVELOPMENT.md)

---

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing`)
5. Open a Pull Request

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines.

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

<p align="center">
  <em>"Welcome to Moe's Tavern - where AI agents come to get their work done!"</em>
</p>
