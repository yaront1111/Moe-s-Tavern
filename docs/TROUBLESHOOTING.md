# Troubleshooting Guide

Common issues and solutions for Moe's Tavern.

---

## Table of Contents

1. [Daemon Issues](#daemon-issues)
2. [Plugin Issues](#plugin-issues)
3. [MCP/Proxy Issues](#mcpproxy-issues)
4. [Task Sync Issues](#task-sync-issues)
5. [Performance Issues](#performance-issues)
6. [Diagnostic Commands](#diagnostic-commands)

---

## Daemon Issues

### Daemon won't start

**Symptom:** `moe-daemon start` fails or exits immediately.

**Possible causes and solutions:**

#### Port already in use

```bash
# Check if port 3141 is in use
# Windows
netstat -ano | findstr :3141

# Mac/Linux
lsof -i :3141
```

**Solution:** Kill the existing process or use a different port:
```bash
node dist/index.js start --project /path --port 3142
```

#### Permission denied

**Symptom:** `EACCES` error when starting daemon.

**Solution:** Ensure you have write permissions to the project's `.moe/` directory:
```bash
# Check permissions
ls -la .moe/

# Fix permissions (Mac/Linux)
chmod -R 755 .moe/
```

#### Wrong Node.js version

**Symptom:** Syntax errors or missing features.

**Solution:** Ensure Node.js 18+ is installed:
```bash
node --version  # Should be v18.x or higher
```

#### daemon.json is stale

**Symptom:** Daemon reports "already running" but isn't.

**Solution:** Remove stale lock file:
```bash
rm .moe/daemon.json
```

---

### Daemon crashes on startup

**Symptom:** Daemon starts but immediately crashes.

**Possible causes:**

#### Corrupted .moe/ files

**Solution:** Validate JSON files:
```bash
# Check for JSON syntax errors
node -e "require('./.moe/project.json')"
```

#### Missing project.json

**Solution:** Initialize the project:
```bash
# From JetBrains plugin: Tools > Moe > Initialize Project
# Or manually create .moe/project.json
```

---

## Plugin Issues

### Plugin can't connect to daemon

**Symptom:** "Disconnected" status in plugin, red indicator.

**Possible causes and solutions:**

#### Daemon not running

**Solution:** Start the daemon:
```bash
node packages/moe-daemon/dist/index.js start --project /your/project
```

#### Wrong port

**Solution:** Check daemon.json for actual port:
```bash
cat .moe/daemon.json
# Shows: { "port": 3141, ... }
```

#### Firewall blocking localhost

**Solution:** Ensure localhost connections are allowed. On Windows, check Windows Defender Firewall.

#### Plugin looking at wrong project

**Solution:** Ensure the IDE project root contains `.moe/` folder.

---

### Plugin shows stale data

**Symptom:** Tasks don't update after changes.

**Solution:**
1. Click "Refresh" in the Moe tool window
2. Restart the plugin connection (disconnect/reconnect)
3. Check daemon logs for WebSocket errors

---

### Plugin UI is blank

**Symptom:** Moe tool window shows nothing.

**Possible causes:**

#### Project not initialized

**Solution:** Initialize via Tools > Moe > Initialize Project

#### Plugin not loaded

**Solution:**
1. Check IDE logs: Help > Show Log in Explorer/Finder
2. Search for "Moe" errors
3. Try reinstalling the plugin

---

## MCP/Proxy Issues

### MCP tools not responding

**Symptom:** Claude/agent hangs when calling Moe tools.

**Possible causes and solutions:**

#### Proxy not running

**Solution:** Start the proxy:
```bash
node packages/moe-proxy/dist/index.js
```

#### Daemon not running

**Solution:** The proxy requires daemon to be running. Start daemon first.

#### Wrong project path

**Solution:** Ensure MOE_PROJECT_PATH points to correct directory:
```bash
export MOE_PROJECT_PATH=/path/to/project
node packages/moe-proxy/dist/index.js
```

---

### MCP tools return errors

**Symptom:** Tools return error responses.

**Common errors:**

#### "Task not found"

**Solution:** Verify task ID exists:
```bash
ls .moe/tasks/
```

#### "Worker not registered"

**Solution:** Register the worker first using `moe.claim_next_task`.

#### "RAIL_VIOLATION"

**Solution:** Ensure plan includes all required rail phrases. Check epic and task rails.

---

## Task Sync Issues

### Tasks not appearing in plugin

**Symptom:** Created tasks don't show in IDE.

**Possible causes:**

#### WebSocket disconnected

**Solution:** Check plugin connection status, reconnect if needed.

#### File watcher not triggering

**Solution:** Restart daemon to reinitialize file watcher.

---

### Task status not updating

**Symptom:** Status changes aren't reflected.

**Solution:**
1. Check daemon logs for errors
2. Verify file permissions on `.moe/tasks/`
3. Restart daemon

---

### Duplicate tasks appearing

**Symptom:** Same task shows multiple times.

**Solution:** This is usually a UI bug. Refresh the board or restart the plugin.

---

## Performance Issues

### Large activity.log slowing things down

**Symptom:** Daemon startup is slow, high memory usage.

**Solution:** The log rotator should handle this automatically. To manually rotate:
```bash
# Logs rotate automatically at 10MB
# Check current size
ls -lh .moe/activity.log

# View rotated logs
ls .moe/activity.log.*
```

To adjust rotation settings:
```bash
export LOG_MAX_SIZE_MB=5
export LOG_RETENTION_COUNT=3
```

---

### Too many tasks causing slowdown

**Symptom:** Board is slow to render, daemon uses high CPU.

**Solution:**
1. Archive completed epics
2. Delete old done tasks
3. Use pagination (if available)

---

### WebSocket reconnection storms

**Symptom:** Multiple rapid connect/disconnect messages.

**Solution:**
1. Check network stability
2. Increase reconnection delay in plugin settings
3. Restart both daemon and plugin

---

## Diagnostic Commands

### Check daemon status

```bash
# Via CLI
node packages/moe-daemon/dist/index.js status --project /path

# Via HTTP
curl http://localhost:3141/health
```

### View daemon logs

```bash
# Daemon logs to stdout by default
# For structured logs, set:
export LOG_LEVEL=debug
```

### Check .moe/ structure

```bash
# List all Moe files
find .moe -type f -name "*.json" | head -20

# Validate project.json
cat .moe/project.json | jq .
```

### Test WebSocket connection

```bash
# Using websocat (install separately)
websocat ws://localhost:3141/ws

# Send ping
{"type":"PING"}
```

### Check MCP proxy

```bash
# Test proxy responds
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node packages/moe-proxy/dist/index.js
```

---

## Getting Help

If these solutions don't resolve your issue:

1. **Check existing issues:** [GitHub Issues](https://github.com/yaront1111/Moe-s-Tavern/issues)
2. **Open a new issue** with:
   - OS and version
   - Node.js version
   - IDE and version
   - Steps to reproduce
   - Relevant log output
3. **Join discussions:** [GitHub Discussions](https://github.com/yaront1111/Moe-s-Tavern/discussions)
