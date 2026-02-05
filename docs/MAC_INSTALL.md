# Mac Installation Guide

Complete installation guide for Moe's Tavern on macOS (Intel and Apple Silicon).

---

## Quick Install (Homebrew)

```bash
brew tap yaront1111/moe
brew install moe
```

This installs `moe-daemon` and `moe-proxy` globally.

---

## Install from Source

### Prerequisites

- **Node.js 18+**: `brew install node`
- **Git**: `brew install git`
- **JDK 17+** (optional, for plugin): `brew install openjdk@17`

### Clone and Build

```bash
git clone https://github.com/yaront1111/Moe-s-Tavern.git
cd Moe-s-Tavern
chmod +x scripts/*.sh
./scripts/install-mac.sh
```

### Manual Build (Alternative)

```bash
# Build daemon
cd packages/moe-daemon
npm install
npm run build

# Build proxy
cd ../moe-proxy
npm install
npm run build
```

---

## Initialize a Project

```bash
cd /path/to/your/project
moe-daemon init

# Or specify explicitly
moe-daemon init --project /path/to/project --name "My Project"
```

`init` starts the daemon and keeps running. Stop it with `Ctrl+C` or:
```bash
moe-daemon stop --project /path/to/project
```

---

## Run an Agent

```bash
# Architect role
./scripts/moe-agent.sh --role architect --project ~/myproject

# Worker role
./scripts/moe-agent.sh -r worker -p ~/myproject

# QA role
./scripts/moe-agent.sh -r qa -p ~/myproject

# List registered projects
./scripts/moe-agent.sh --list-projects
```

---

## Verification Checklist

Use this checklist to verify your installation works correctly.

### Basic Install

- [ ] `node --version` shows 18.x or higher
- [ ] `npm --version` shows 9.x or higher
- [ ] Clone completes without errors
- [ ] `npm install` completes in both packages
- [ ] `npm run build` completes without errors

### Daemon

- [ ] `moe-daemon init --project ~/test-project` creates `.moe/` folder
- [ ] `moe-daemon init --project ~/test-project` starts the daemon
- [ ] `.moe/project.json` exists with correct structure
- [ ] `moe-daemon start --project ~/test-project` starts without errors
- [ ] `curl http://localhost:3141/health` returns healthy status
- [ ] `moe-daemon stop --project ~/test-project` stops cleanly
- [ ] `moe-daemon status --project ~/test-project` shows correct state

### Proxy

- [ ] `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node packages/moe-proxy/dist/index.js` returns tool list
- [ ] MCP config created at `~/.config/claude/mcp_servers.json`

### Agent Script

- [ ] `./scripts/moe-agent.sh --help` shows usage
- [ ] `./scripts/moe-agent.sh --list-projects` works
- [ ] Agent starts with `--role architect --project ~/test-project`
- [ ] Role documentation loads (shows "Loaded role doc from:")
- [ ] MCP config updates for project

### JetBrains Plugin (Optional)

- [ ] Plugin builds: `cd moe-jetbrains && ./gradlew buildPlugin`
- [ ] Plugin installs in IDE
- [ ] Moe tool window appears
- [ ] Can connect to daemon
- [ ] Tasks display correctly

---

## Platform-Specific Notes

### Apple Silicon (M1/M2/M3)

- Node.js should be ARM64 native: `node -p process.arch` should show `arm64`
- Homebrew installs to `/opt/homebrew` (not `/usr/local`)
- Rosetta 2 not required for any Moe components

### Intel Macs

- Node.js will be x64: `node -p process.arch` shows `x64`
- Homebrew installs to `/usr/local`
- Works identically to Apple Silicon

### Known Issues

1. **Port already in use**: If 3141 is taken, daemon scans for next available port
2. **Permission denied**: Ensure `chmod +x` on all scripts
3. **python3 not found**: Install via `brew install python3` (required for JSON parsing in scripts)

---

## Troubleshooting

### Daemon won't start

```bash
# Check for existing process
lsof -i :3141

# Remove stale lock file
rm .moe/daemon.json

# Start with debug logging
LOG_LEVEL=debug moe-daemon start --project /path
```

### Agent can't connect

```bash
# Verify daemon is running
curl http://localhost:3141/health

# Check MCP config
cat ~/.config/claude/mcp_servers.json
```

### Build errors

```bash
# Clear node_modules and rebuild
rm -rf node_modules package-lock.json
npm install
npm run build
```

For more troubleshooting tips, see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).
