#!/bin/bash
# Moe Agent Wrapper for Mac/Linux
# Equivalent of moe-agent.ps1 for Windows

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
PROXY_PATH_OVERRIDE="${MOE_PROXY_PATH:-}"
DAEMON_PATH_OVERRIDE="${MOE_DAEMON_PATH:-}"

# Auto-detect node binary from common installation locations
find_node() {
    # 1. Explicit override via env var
    if [ -n "${MOE_NODE_COMMAND:-}" ]; then
        if command -v "$MOE_NODE_COMMAND" &> /dev/null; then
            echo "$MOE_NODE_COMMAND"
            return 0
        fi
    fi

    # 2. node on PATH
    if command -v node &> /dev/null; then
        echo "node"
        return 0
    fi

    # 3. Common Mac/Linux locations
    local candidates=(
        "/opt/homebrew/bin/node"          # Apple Silicon Homebrew
        "/usr/local/bin/node"             # Intel Homebrew
        "$HOME/.nvm/current/bin/node"     # nvm current symlink
        "$HOME/.volta/bin/node"           # volta
        "$HOME/.fnm/current/bin/node"     # fnm
        "/usr/bin/node"                   # system
    )

    for candidate in "${candidates[@]}"; do
        if [ -x "$candidate" ]; then
            echo "$candidate"
            return 0
        fi
    done

    # 4. nvm direct (find newest installed version)
    if [ -d "$HOME/.nvm/versions/node" ]; then
        local newest
        newest=$(ls -d "$HOME/.nvm/versions/node"/v* 2>/dev/null | sort -V | tail -n1)
        if [ -n "$newest" ] && [ -x "$newest/bin/node" ]; then
            echo "$newest/bin/node"
            return 0
        fi
    fi

    # Nothing found - return bare "node" and let it fail later
    echo "node"
    return 1
}

NODE_CMD=$(find_node)
NODE_VERSION=$("$NODE_CMD" --version 2>/dev/null || echo "unknown")
if [ "$NODE_VERSION" = "unknown" ]; then
    echo -e "${RED}[ERROR]${NC} Could not find node. Set MOE_NODE_COMMAND=/path/to/node"
    exit 1
fi
echo -e "${GREEN}[OK]${NC} Using node: $NODE_CMD ($NODE_VERSION)"

# Secure temp directory creation (for any operations needing temp storage)
# Uses mktemp with restricted permissions to prevent access on shared systems
SECURE_TEMP_DIR=""
create_secure_temp() {
    if [ -z "$SECURE_TEMP_DIR" ]; then
        SECURE_TEMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t 'moe-agent')
        chmod 700 "$SECURE_TEMP_DIR"
    fi
    echo "$SECURE_TEMP_DIR"
}

cleanup_temp() {
    if [ -n "$SECURE_TEMP_DIR" ] && [ -d "$SECURE_TEMP_DIR" ]; then
        rm -rf "$SECURE_TEMP_DIR" 2>/dev/null || true
    fi
}
trap cleanup_temp EXIT

# Path normalization for cross-platform support
# Converts Windows paths (backslashes) to Unix paths (forward slashes)
normalize_path() {
    local path="$1"
    # Convert backslashes to forward slashes
    path="${path//\\//}"
    # Handle Windows drive letters (C: -> /c or /mnt/c in WSL)
    if [[ "$path" =~ ^([A-Za-z]):/ ]]; then
        local drive="${BASH_REMATCH[1],,}" # lowercase
        local rest="${path:3}"
        if [ -d "/mnt/$drive" ]; then
            # WSL style path
            path="/mnt/$drive/$rest"
        else
            # Git Bash / MSYS style path
            path="/$drive/$rest"
        fi
    fi
    echo "$path"
}

# Detect if running in WSL
is_wsl() {
    if grep -qEi "(microsoft|wsl)" /proc/version 2>/dev/null; then
        return 0
    fi
    return 1
}

# Defaults
ROLE="worker"
PROJECT=""
PROJECT_NAME=""
WORKER_ID=""
COMMAND="claude"
COMMAND_ARGS=""
LIST_PROJECTS=false
NO_START_DAEMON=false
AUTO_CLAIM=true
POLL_INTERVAL=30
NO_LOOP=false
TEAM=""
CODEX_EXEC=false
GEMINI_EXEC=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -r|--role)
            ROLE="$2"
            shift 2
            ;;
        -p|--project)
            PROJECT="$2"
            shift 2
            ;;
        -n|--project-name)
            PROJECT_NAME="$2"
            shift 2
            ;;
        -w|--worker-id)
            WORKER_ID="$2"
            shift 2
            ;;
        -c|--command)
            COMMAND="$2"
            shift 2
            ;;
        --list-projects|-l)
            LIST_PROJECTS=true
            shift
            ;;
        --no-start-daemon)
            NO_START_DAEMON=true
            shift
            ;;
        --no-auto-claim)
            AUTO_CLAIM=false
            shift
            ;;
        --poll-interval)
            POLL_INTERVAL="$2"
            shift 2
            ;;
        --no-loop)
            NO_LOOP=true
            shift
            ;;
        -t|--team)
            TEAM="$2"
            shift 2
            ;;
        --codex-exec)
            CODEX_EXEC=true
            shift
            ;;
        --gemini-exec)
            GEMINI_EXEC=true
            shift
            ;;
        --help|-h)
            echo "Moe Agent Wrapper"
            echo ""
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  -r, --role ROLE          Role: architect, worker, qa (default: worker)"
            echo "  -p, --project PATH       Project path"
            echo "  -n, --project-name NAME  Project name from registry"
            echo "  -w, --worker-id ID       Worker ID (default: same as role)"
            echo "  -c, --command CMD        Agent command (claude, codex, gemini, or custom; default: claude)"
            echo "  -l, --list-projects      List registered projects"
            echo "  --no-start-daemon        Don't auto-start daemon"
            echo "  --no-auto-claim          Don't auto-claim a task on start"
            echo "  --poll-interval SECS     Seconds between task polls (default: 30)"
            echo "  --no-loop                Run once and exit (no polling)"
            echo "  -t, --team NAME          Team name for parallel same-role agents"
            echo "  --codex-exec             Use codex exec mode (non-interactive, headless)"
            echo "  --gemini-exec            Use gemini headless mode (non-interactive, --yolo)"
            echo "  --help, -h               Show this help"
            echo ""
            echo "Examples:"
            echo "  $0 --role architect --project ~/myproject"
            echo "  $0 -r worker -n myproject"
            echo "  $0 --list-projects"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Validate role
if [[ ! "$ROLE" =~ ^(architect|worker|qa)$ ]]; then
    echo -e "${RED}Invalid role: $ROLE${NC}"
    echo "Valid roles: architect, worker, qa"
    exit 1
fi

# Detect CLI type from command name
CLI_TYPE="claude"
CMD_BASE=$(basename "${COMMAND%% *}")
if [ "$CMD_BASE" = "codex" ]; then
    CLI_TYPE="codex"
elif [ "$CMD_BASE" = "gemini" ]; then
    CLI_TYPE="gemini"
fi
CODEX_INTERACTIVE=false
if [ "$CLI_TYPE" = "codex" ] && [ "$CODEX_EXEC" = false ]; then
    CODEX_INTERACTIVE=true
fi
GEMINI_INTERACTIVE=false
if [ "$CLI_TYPE" = "gemini" ] && [ "$GEMINI_EXEC" = false ]; then
    GEMINI_INTERACTIVE=true
fi

# Auto-detect python3 from common installation locations
find_python() {
    if command -v python3 &> /dev/null; then
        echo "python3"
        return 0
    fi

    local candidates=(
        "/opt/homebrew/bin/python3"                      # Apple Silicon Homebrew
        "/usr/local/bin/python3"                         # Intel Homebrew
        "/usr/bin/python3"                               # System / Xcode CLT
        "/Library/Developer/CommandLineTools/usr/bin/python3"  # Xcode CLT explicit
    )

    for candidate in "${candidates[@]}"; do
        if [ -x "$candidate" ]; then
            echo "$candidate"
            return 0
        fi
    done

    echo ""
    return 1
}

PYTHON_CMD=$(find_python)
if [ -z "$PYTHON_CMD" ]; then
    echo -e "${RED}Error: python3 is required but not found${NC}"
    echo "Install Python 3: brew install python3"
    exit 1
fi
echo -e "${GREEN}[OK]${NC} Using python3: $PYTHON_CMD"

# Read install path from ~/.moe/config.json
get_moe_install_path() {
    local config_file="$HOME/.moe/config.json"
    if [ ! -f "$config_file" ]; then
        echo ""
        return
    fi
    local install_path
    install_path=$($PYTHON_CMD -c "
import json, sys
try:
    with open('$config_file') as f:
        config = json.load(f)
    path = config.get('installPath', '')
    if path:
        print(path)
except:
    pass
" 2>/dev/null)
    if [ -z "$install_path" ]; then
        echo ""
        return
    fi
    local canary="$install_path/packages/moe-daemon/dist/index.js"
    if [ ! -f "$canary" ]; then
        echo ""
        return
    fi
    echo "$install_path"
}

# Load project registry
load_registry() {
    local registry_file="$HOME/.moe/projects.json"
    if [ -f "$registry_file" ]; then
        cat "$registry_file"
    else
        echo "[]"
    fi
}

# List projects
if [ "$LIST_PROJECTS" = true ]; then
    echo "Registered Moe projects:"
    echo ""
    registry=$(load_registry)
    if [ "$registry" = "[]" ]; then
        echo "No projects registered."
        echo "Open a project with the JetBrains plugin to register it."
    else
        echo "$registry" | $PYTHON_CMD -c "
import json, sys
data = json.load(sys.stdin)
if not data:
    print('No projects registered.')
else:
    for p in sorted(data, key=lambda x: x.get('lastOpenedAt', ''), reverse=True):
        print(f\"  {p.get('name', 'unnamed')}: {p.get('path', 'no path')}\")
" 2>/dev/null || echo "$registry"
    fi
    exit 0
fi

# Resolve project path
if [ -z "$PROJECT" ]; then
    if [ -n "$PROJECT_NAME" ]; then
        # Look up in registry
        registry=$(load_registry)
        PROJECT=$(echo "$registry" | $PYTHON_CMD -c "
import json, sys
data = json.load(sys.stdin)
name = '$PROJECT_NAME'
for p in data:
    if p.get('name') == name:
        print(p.get('path', ''))
        sys.exit(0)
sys.exit(1)
" 2>/dev/null)
        if [ -z "$PROJECT" ]; then
            echo -e "${RED}Project not found in registry: $PROJECT_NAME${NC}"
            echo "Use --list-projects to see registered projects."
            exit 1
        fi
    else
        echo -e "${RED}Error: Provide --project or --project-name${NC}"
        echo "Use --list-projects to see registered projects."
        exit 1
    fi
fi

# Normalize path for cross-platform support (Windows paths -> Unix paths)
PROJECT=$(normalize_path "$PROJECT")

# Resolve to absolute path
PROJECT=$(cd "$PROJECT" 2>/dev/null && pwd || echo "$PROJECT")
if [ ! -d "$PROJECT" ]; then
    echo -e "${RED}Project path not found: $PROJECT${NC}"
    if is_wsl; then
        echo -e "${YELLOW}Note: Running in WSL. Windows paths should be like /mnt/c/Users/...${NC}"
    fi
    exit 1
fi

# Check if project is initialized for Moe
MOE_DIR="$PROJECT/.moe"
if [ ! -d "$MOE_DIR" ]; then
    echo -e "${RED}Project is not initialized for Moe: $PROJECT${NC}"
    echo "Initialize it by opening in JetBrains IDE with Moe plugin, or create .moe folder manually."
    exit 1
fi

# Set environment variables
export MOE_PROJECT_PATH="$PROJECT"
if [ -z "$WORKER_ID" ]; then
    SHORT_ID=$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 4)
    WORKER_ID="${ROLE}-${SHORT_ID}"
fi
export MOE_WORKER_ID="$WORKER_ID"

# Ensure MCP config for Claude Code
ensure_mcp_config() {
    local config_dir="$HOME/.config/claude"
    local config_file="$config_dir/mcp_servers.json"

    # Find moe-proxy command
    PROXY_CMD=""
    PROXY_ARGS=""
    if [ -n "$PROXY_PATH_OVERRIDE" ] && [ -f "$PROXY_PATH_OVERRIDE" ]; then
        PROXY_CMD="$NODE_CMD"
        PROXY_ARGS="$PROXY_PATH_OVERRIDE"
    elif command -v moe-proxy &> /dev/null; then
        PROXY_CMD="moe-proxy"
    else
        PROXY_SCRIPT="$ROOT_DIR/packages/moe-proxy/dist/index.js"
        if [ -f "$PROXY_SCRIPT" ]; then
            PROXY_CMD="$NODE_CMD"
            PROXY_ARGS="$PROXY_SCRIPT"
        else
            # Fall back to global install config
            local global_install
            global_install=$(get_moe_install_path)
            if [ -n "$global_install" ]; then
                PROXY_SCRIPT="$global_install/packages/moe-proxy/dist/index.js"
                if [ -f "$PROXY_SCRIPT" ]; then
                    PROXY_CMD="$NODE_CMD"
                    PROXY_ARGS="$PROXY_SCRIPT"
                fi
            fi
            if [ -z "$PROXY_CMD" ]; then
                echo -e "${YELLOW}[WARN]${NC} moe-proxy not found, MCP config not updated"
                return
            fi
        fi
    fi

    mkdir -p "$config_dir"

    # Create or update config
    if [ ! -f "$config_file" ]; then
        # Create new config
        if [ -n "$PROXY_ARGS" ]; then
            cat > "$config_file" << EOF
{
  "mcpServers": {
    "moe": {
      "command": "$PROXY_CMD",
      "args": ["$PROXY_ARGS"],
      "env": {
        "MOE_PROJECT_PATH": "$PROJECT"
      }
    }
  }
}
EOF
        else
            cat > "$config_file" << EOF
{
  "mcpServers": {
    "moe": {
      "command": "$PROXY_CMD",
      "env": {
        "MOE_PROJECT_PATH": "$PROJECT"
      }
    }
  }
}
EOF
        fi
        echo -e "${GREEN}[OK]${NC} Created MCP config: $config_file"
    else
        # Update existing config using python3
        $PYTHON_CMD << EOF
import json
import sys

config_file = "$config_file"
project_path = "$PROJECT"
proxy_cmd = "$PROXY_CMD"
proxy_args = "$PROXY_ARGS"

try:
    with open(config_file, 'r') as f:
        config = json.load(f)
except:
    config = {}

if 'mcpServers' not in config:
    config['mcpServers'] = {}

entry = {
    'command': proxy_cmd,
    'env': {
        'MOE_PROJECT_PATH': project_path
    }
}
if proxy_args:
    entry['args'] = [proxy_args]
config['mcpServers']['moe'] = entry

with open(config_file, 'w') as f:
    json.dump(config, f, indent=2)

print(f"[OK] Updated MCP config: {config_file}")
EOF
    fi

    # Also write project-level .mcp.json so Claude Code finds MCP tools
    # regardless of working directory or global config issues
    local project_mcp="$PROJECT/.mcp.json"
    if [ -n "$PROXY_CMD" ]; then
        $PYTHON_CMD << MCPEOF
import json

project_mcp = "$project_mcp"
proxy_cmd = "$PROXY_CMD"
proxy_args = "$PROXY_ARGS"
project_path = "$PROJECT"

entry = {
    'command': proxy_cmd,
    'env': {
        'MOE_PROJECT_PATH': project_path
    }
}
if proxy_args:
    entry['args'] = [proxy_args]

config = {'mcpServers': {'moe': entry}}

with open(project_mcp, 'w') as f:
    json.dump(config, f, indent=2)
print(f"[OK] Wrote project MCP config: {project_mcp}")
MCPEOF
    fi
}

ensure_mcp_config

# For codex: write project-scoped .codex/config.toml instead of global registration
if [ "$CLI_TYPE" = "codex" ]; then
    echo "Writing project-scoped Codex MCP config..."
    CODEX_CONFIG_DIR="$PROJECT/.codex"
    CODEX_CONFIG_FILE="$CODEX_CONFIG_DIR/config.toml"
    mkdir -p "$CODEX_CONFIG_DIR"

    # Determine the proxy command and args for TOML
    TOML_PROXY_CMD=""
    TOML_PROXY_ARGS=""
    if [ -n "$PROXY_ARGS" ]; then
        TOML_PROXY_CMD="$NODE_CMD"
        TOML_PROXY_ARGS="$PROXY_ARGS"
    elif [ -n "$PROXY_CMD" ]; then
        TOML_PROXY_CMD="$PROXY_CMD"
    else
        echo -e "${YELLOW}[WARN]${NC} moe-proxy not found; cannot write Codex MCP config"
    fi

    if [ -n "$TOML_PROXY_CMD" ]; then
        $PYTHON_CMD - "$CODEX_CONFIG_FILE" "$TOML_PROXY_CMD" "$TOML_PROXY_ARGS" "$PROJECT" "$ROLE" << 'PYEOF'
import sys, os, re

config_file = sys.argv[1]
proxy_cmd = sys.argv[2]
proxy_args = sys.argv[3]
project_path = sys.argv[4]
role = sys.argv[5] if len(sys.argv) > 5 else "worker"

# Top-level config lines (role instructions + model instructions)
top_level_lines = [
    'model_instructions_file = "agent-instructions.md"',
    'developer_instructions = """You are a ' + role + ' agent in the Moe AI Workforce system. You MUST use Moe MCP tools (moe.*) for ALL task operations. Follow the Moe workflow strictly. Never edit .moe/ files directly."""',
]
top_level_block = "\n".join(top_level_lines)

# Build the moe MCP server TOML block
moe_block_lines = [
    "",
    "[mcp_servers.moe]",
    f'command = "{proxy_cmd}"',
]
if proxy_args:
    moe_block_lines.append(f'args = ["{proxy_args}"]')
moe_block_lines.extend([
    "",
    "[mcp_servers.moe.env]",
    f'MOE_PROJECT_PATH = "{project_path}"',
])
moe_block = "\n".join(moe_block_lines)

if os.path.exists(config_file):
    # Merge: read existing, remove old moe sections and moe-managed top-level keys
    with open(config_file, "r") as f:
        content_str = f.read()

    # Remove old model_instructions_file lines
    content_str = re.sub(r'^model_instructions_file\s*=.*\n?', '', content_str, flags=re.MULTILINE)

    # Remove old developer_instructions (triple-quoted multi-line)
    content_str = re.sub(r'^developer_instructions\s*=\s*""".*?"""\s*\n?', '', content_str, flags=re.MULTILINE | re.DOTALL)
    # Remove old developer_instructions (single-line)
    content_str = re.sub(r'^developer_instructions\s*=\s*"[^"]*"\s*\n?', '', content_str, flags=re.MULTILINE)

    # Filter out [mcp_servers.moe] and [mcp_servers.moe.env] sections
    lines = content_str.splitlines(True)
    cleaned = []
    skip = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("[mcp_servers.moe]") or stripped.startswith("[mcp_servers.moe.env]"):
            skip = True
            continue
        if skip and stripped.startswith("[") and not stripped.startswith("[mcp_servers.moe"):
            skip = False
        if not skip:
            cleaned.append(line)

    # Ensure agent-instructions.md is in project_doc_fallback_filenames
    content_str = "".join(cleaned)
    if "project_doc_fallback_filenames" in content_str and "agent-instructions.md" not in content_str:
        content_str = content_str.replace(
            'project_doc_fallback_filenames = ["CLAUDE.md"]',
            'project_doc_fallback_filenames = ["CLAUDE.md", ".codex/agent-instructions.md"]'
        )

    # Safety: if merge produced empty/whitespace-only content, fall back to fresh config
    if not content_str.strip():
        content_str = '# Codex project config (auto-generated by moe-agent)\nproject_doc_fallback_filenames = ["CLAUDE.md", ".codex/agent-instructions.md"]\n'

    # Insert top-level keys BEFORE the first [section] header to keep them at TOML root level
    first_section = re.search(r'^\[', content_str, re.MULTILINE)
    if first_section:
        pos = first_section.start()
        content = content_str[:pos].rstrip() + "\n" + top_level_block + "\n\n" + content_str[pos:].rstrip() + "\n" + moe_block + "\n"
    else:
        content = content_str.rstrip() + "\n" + top_level_block + "\n" + moe_block + "\n"
else:
    # Create new config
    content = '# Codex project config (auto-generated by moe-agent)\nproject_doc_fallback_filenames = ["CLAUDE.md", ".codex/agent-instructions.md"]\n' + top_level_block + "\n" + moe_block + "\n"

with open(config_file, "w") as f:
    f.write(content)
PYEOF

        if [ $? -eq 0 ] && [ -f "$CODEX_CONFIG_FILE" ]; then
            echo -e "${GREEN}[OK]${NC} Codex MCP config written to: $CODEX_CONFIG_FILE"
        else
            echo -e "${RED}[ERROR]${NC} Failed to write Codex MCP config"
            exit 1
        fi
    fi
fi

# For gemini: write project-scoped .gemini/settings.json with MCP config
if [ "$CLI_TYPE" = "gemini" ]; then
    echo "Writing project-scoped Gemini MCP config..."
    GEMINI_CONFIG_DIR="$PROJECT/.gemini"
    GEMINI_CONFIG_FILE="$GEMINI_CONFIG_DIR/settings.json"
    mkdir -p "$GEMINI_CONFIG_DIR"

    if [ -z "$PROXY_CMD" ]; then
        echo -e "${YELLOW}[WARN]${NC} moe-proxy not found; cannot write Gemini MCP config"
    else
        $PYTHON_CMD << GEMINIEOF
import json
import sys

config_file = "$GEMINI_CONFIG_FILE"
project_path = "$PROJECT"
proxy_cmd = "$PROXY_CMD"
proxy_args = "$PROXY_ARGS"

# Build the desired moe MCP server entry
moe_entry = {
    'command': proxy_cmd,
    'env': {
        'MOE_PROJECT_PATH': project_path
    }
}
if proxy_args:
    moe_entry['args'] = [proxy_args]

# New config to merge in
new_config = {
    'mcpServers': {
        'moe': moe_entry
    }
}

# Merge with existing settings.json if present
try:
    with open(config_file, 'r') as f:
        config = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    config = {}

if 'mcpServers' not in config:
    config['mcpServers'] = {}
config['mcpServers']['moe'] = moe_entry

with open(config_file, 'w') as f:
    json.dump(config, f, indent=2)

print(f"[OK] Gemini MCP config written to: {config_file}")
GEMINIEOF

        if [ $? -eq 0 ] && [ -f "$GEMINI_CONFIG_FILE" ]; then
            echo -e "${GREEN}[OK]${NC} Gemini MCP config written to: $GEMINI_CONFIG_FILE"
        else
            echo -e "${RED}[ERROR]${NC} Failed to write Gemini MCP config"
            exit 1
        fi
    fi
fi

# Start daemon if needed
if [ "$NO_START_DAEMON" = false ]; then
    DAEMON_INFO="$MOE_DIR/daemon.json"
    RUNNING=false

    if [ -f "$DAEMON_INFO" ]; then
        # Try to read PID from daemon.json
        # NOTE: Uses sys.argv[1] instead of string interpolation to safely handle
        # paths containing single quotes, double quotes, or spaces.
        PID_OUTPUT=$($PYTHON_CMD -c "import json,sys; print(json.load(open(sys.argv[1])).get('pid', ''))" "$DAEMON_INFO" 2>&1)
        PID_EXIT_CODE=$?

        if [ $PID_EXIT_CODE -ne 0 ]; then
            echo -e "${YELLOW}[WARN]${NC} Failed to parse daemon.json: $PID_OUTPUT"
            echo -e "${YELLOW}[WARN]${NC} Will attempt to start a new daemon"
            PID=""
        else
            PID="$PID_OUTPUT"
        fi

        if [ -n "$PID" ]; then
            # Validate PID is numeric
            if ! [[ "$PID" =~ ^[0-9]+$ ]]; then
                echo -e "${YELLOW}[WARN]${NC} Invalid PID in daemon.json: '$PID' (not numeric)"
                PID=""
            elif ! kill -0 "$PID" 2>/dev/null; then
                echo -e "${YELLOW}[INFO]${NC} Stale daemon.json detected (PID $PID is not running)"
                echo -e "${YELLOW}[INFO]${NC} Cleaning up stale daemon.json..."
                rm -f "$DAEMON_INFO"
                PID=""
            else
                RUNNING=true
            fi
        fi
    fi

    if [ "$RUNNING" = false ]; then
        echo -e "${YELLOW}Starting Moe daemon...${NC}"

        # Find daemon script
        DAEMON_CMD=""
        DAEMON_ARGS=()
        if [ -n "$DAEMON_PATH_OVERRIDE" ] && [ -f "$DAEMON_PATH_OVERRIDE" ]; then
            DAEMON_CMD="$NODE_CMD"
            DAEMON_ARGS=("$DAEMON_PATH_OVERRIDE")
        elif command -v moe-daemon &> /dev/null; then
            DAEMON_CMD="moe-daemon"
        else
            DAEMON_SCRIPT="$ROOT_DIR/packages/moe-daemon/dist/index.js"
            if [ ! -f "$DAEMON_SCRIPT" ]; then
                # Fall back to global install config
                local global_install
                global_install=$(get_moe_install_path)
                if [ -n "$global_install" ]; then
                    DAEMON_SCRIPT="$global_install/packages/moe-daemon/dist/index.js"
                fi
            fi
            if [ ! -f "$DAEMON_SCRIPT" ]; then
                echo -e "${RED}Daemon not found. Run install-mac.sh first.${NC}"
                exit 1
            fi
            DAEMON_CMD="$NODE_CMD"
            DAEMON_ARGS=("$DAEMON_SCRIPT")
        fi

        # Start daemon in background
        "$DAEMON_CMD" "${DAEMON_ARGS[@]}" start --project "$PROJECT" &
        DAEMON_PID=$!

        # Wait for daemon to be ready (poll for up to 10 seconds)
        MAX_WAIT=10
        WAITED=0
        while [ $WAITED -lt $MAX_WAIT ]; do
            sleep 1
            WAITED=$((WAITED + 1))

            # Check if daemon.json exists and process is running
            if [ -f "$DAEMON_INFO" ]; then
                NEW_PID=$($PYTHON_CMD -c "import json,sys; print(json.load(open(sys.argv[1])).get('pid', ''))" "$DAEMON_INFO" 2>/dev/null || echo "")
                if [ -n "$NEW_PID" ] && kill -0 "$NEW_PID" 2>/dev/null; then
                    echo -e "${GREEN}[OK]${NC} Daemon started (waited ${WAITED}s)"
                    break
                fi
            fi

            # Check if daemon process died
            if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
                echo -e "${RED}[ERROR]${NC} Daemon process exited unexpectedly"
                exit 1
            fi

            echo -e "${YELLOW}Waiting for daemon... (${WAITED}/${MAX_WAIT}s)${NC}"
        done

        if [ $WAITED -ge $MAX_WAIT ]; then
            echo -e "${RED}[ERROR]${NC} Daemon failed to start within ${MAX_WAIT}s"
            exit 1
        fi
    else
        echo -e "${GREEN}[OK]${NC} Daemon already running"
    fi
fi

# Auto-create/join team if --team specified
TEAM_CONTEXT=""
if [ -n "$TEAM" ]; then
    echo -e "${BLUE}Setting up team '$TEAM' for role '$ROLE'...${NC}"

    # Find proxy script
    TEAM_PROXY=""
    if [ -n "$PROXY_ARGS" ]; then
        TEAM_PROXY="$PROXY_ARGS"
    elif [ -n "$PROXY_CMD" ] && [ "$PROXY_CMD" != "$NODE_CMD" ]; then
        # proxy is a standalone binary
        TEAM_PROXY=""
    else
        TEAM_PROXY="$ROOT_DIR/packages/moe-proxy/dist/index.js"
        if [ ! -f "$TEAM_PROXY" ]; then
            global_install=$(get_moe_install_path)
            if [ -n "$global_install" ]; then
                TEAM_PROXY="$global_install/packages/moe-proxy/dist/index.js"
            fi
        fi
    fi

    TEAM_CREATE_JSON="{\"name\":\"$TEAM\"}"
    TEAM_CREATE_RPC="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"moe.create_team\",\"arguments\":$TEAM_CREATE_JSON}}"

    TEAM_RESULT=""
    if [ -n "$TEAM_PROXY" ]; then
        TEAM_RESULT=$(echo "$TEAM_CREATE_RPC" | "$NODE_CMD" "$TEAM_PROXY" 2>/dev/null || true)
    else
        TEAM_RESULT=$(echo "$TEAM_CREATE_RPC" | "$PROXY_CMD" 2>/dev/null || true)
    fi

    if [ -n "$TEAM_RESULT" ]; then
        TEAM_ID=$($PYTHON_CMD -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    text = data['result']['content'][0]['text']
    team = json.loads(text)
    print(team['team']['id'])
except:
    pass
" <<< "$TEAM_RESULT" 2>/dev/null || true)

        if [ -n "$TEAM_ID" ]; then
            echo -e "${GREEN}[OK]${NC} Team '$TEAM' ready (id: $TEAM_ID)"

            TEAM_JOIN_JSON="{\"teamId\":\"$TEAM_ID\",\"workerId\":\"$WORKER_ID\"}"
            TEAM_JOIN_RPC="{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"moe.join_team\",\"arguments\":$TEAM_JOIN_JSON}}"

            if [ -n "$TEAM_PROXY" ]; then
                echo "$TEAM_JOIN_RPC" | "$NODE_CMD" "$TEAM_PROXY" 2>/dev/null > /dev/null || true
            else
                echo "$TEAM_JOIN_RPC" | "$PROXY_CMD" 2>/dev/null > /dev/null || true
            fi
            echo -e "${GREEN}[OK]${NC} Worker $WORKER_ID joined team '$TEAM'"
            TEAM_CONTEXT="You are part of team '$TEAM' (id: $TEAM_ID, role: $ROLE). Team members can work in parallel on the same epic."
        else
            echo -e "${YELLOW}[WARN]${NC} Failed to parse team ID from response"
        fi
    else
        echo -e "${YELLOW}[WARN]${NC} Failed to create team '$TEAM'"
    fi
fi

# Determine status filter based on role
case $ROLE in
    architect)
        STATUSES='["PLANNING"]'
        ;;
    worker)
        STATUSES='["WORKING"]'
        ;;
    qa)
        STATUSES='["REVIEW"]'
        ;;
esac

echo ""
echo -e "${BLUE}================================${NC}"
echo -e "Role:      ${GREEN}$ROLE${NC}"
echo -e "Project:   $PROJECT"
echo -e "WorkerId:  $WORKER_ID"
echo -e "AutoClaim: $AUTO_CLAIM"
if [ -n "$TEAM" ]; then
    echo -e "Team:      ${GREEN}$TEAM${NC}"
fi
echo -e "${BLUE}================================${NC}"
echo ""

# Build claim command
CLAIM_JSON="{\"statuses\":$STATUSES,\"workerId\":\"$WORKER_ID\"}"

# Load role documentation
ROLE_DOC=""
ROLE_DOC_PATH="$MOE_DIR/roles/$ROLE.md"
if [ ! -f "$ROLE_DOC_PATH" ]; then
    # Fall back to docs/roles/
    ROLE_DOC_PATH="$ROOT_DIR/docs/roles/$ROLE.md"
fi

if [ -f "$ROLE_DOC_PATH" ]; then
    ROLE_DOC=$(cat "$ROLE_DOC_PATH")
    echo -e "${GREEN}[OK]${NC} Loaded role doc from: $ROLE_DOC_PATH"
else
    echo -e "${YELLOW}[WARN]${NC} Role documentation not found: $ROLE.md"
fi

# Load shared agent context (.moe/ first, then fallback to install docs/)
AGENT_CONTEXT=""
AGENT_CONTEXT_PATH="$MOE_DIR/agent-context.md"
if [ ! -f "$AGENT_CONTEXT_PATH" ]; then
    AGENT_CONTEXT_PATH="$ROOT_DIR/docs/agent-context.md"
fi
if [ -f "$AGENT_CONTEXT_PATH" ]; then
    AGENT_CONTEXT=$(cat "$AGENT_CONTEXT_PATH")
    echo -e "${GREEN}[OK]${NC} Loaded agent context from: $AGENT_CONTEXT_PATH"
fi

# Read approval mode from project.json (lightweight, no jq dependency)
APPROVAL_MODE=""
PROJECT_JSON="$MOE_DIR/project.json"
if [ -f "$PROJECT_JSON" ]; then
    APPROVAL_MODE=$(grep -o '"approvalMode"[[:space:]]*:[[:space:]]*"[^"]*"' "$PROJECT_JSON" 2>/dev/null | head -1 | sed 's/.*"approvalMode"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
    if [ -n "$APPROVAL_MODE" ]; then
        echo -e "${GREEN}[OK]${NC} Approval mode: $APPROVAL_MODE"
    fi
fi

# Read enableAgentTeams from project.json
ENABLE_AGENT_TEAMS=""
if [ -f "$PROJECT_JSON" ]; then
    ENABLE_AGENT_TEAMS=$(grep -o '"enableAgentTeams"[[:space:]]*:[[:space:]]*[a-z]*' "$PROJECT_JSON" 2>/dev/null | head -1 | sed 's/.*:[[:space:]]*//' || true)
    if [ "$ENABLE_AGENT_TEAMS" = "true" ]; then
        echo -e "${GREEN}[OK]${NC} Agent Teams: enabled"
    fi
fi

# Load known issues if present
KNOWN_ISSUES=""
KNOWN_ISSUES_PATH="$MOE_DIR/KNOWN_ISSUES.md"
if [ -f "$KNOWN_ISSUES_PATH" ]; then
    KNOWN_ISSUES=$(cat "$KNOWN_ISSUES_PATH")
    echo -e "${GREEN}[OK]${NC} Loaded known issues from: $KNOWN_ISSUES_PATH"
fi

LOOP_ENABLED=true
if [ "$NO_LOOP" = true ] || [ "$POLL_INTERVAL" -le 0 ] 2>/dev/null; then
    LOOP_ENABLED=false
fi

if [ "$CODEX_INTERACTIVE" = true ] || [ "$GEMINI_INTERACTIVE" = true ]; then
    LOOP_ENABLED=false
    if [ "$NO_LOOP" = false ]; then
        echo "Interactive mode: polling disabled"
    fi
fi

if [ "$LOOP_ENABLED" = true ]; then
    echo -e "Polling mode: will check for new tasks every ${POLL_INTERVAL}s after completion (Ctrl+C to stop)"
fi

# Trap SIGINT/SIGTERM to exit cleanly from the loop
LOOP_RUNNING=true
trap 'echo ""; echo "Agent stopped."; LOOP_RUNNING=false; exit 0' INT TERM

FIRST_RUN=true

while [ "$LOOP_RUNNING" = true ]; do
    if [ "$FIRST_RUN" = false ]; then
        echo ""
        echo -e "${YELLOW}Agent exited, relaunching in 2 seconds... (Ctrl+C to stop)${NC}"
        sleep 2
        echo -e "${BLUE}Relaunching agent...${NC}"
    fi
    FIRST_RUN=false

    ROLE_STATUS_DESC=""
    case $ROLE in
        architect)
            ROLE_STATUS_DESC="You handle tasks in PLANNING status."
            ;;
        worker)
            ROLE_STATUS_DESC="You handle tasks in WORKING status."
            ;;
        qa)
            ROLE_STATUS_DESC="You handle tasks in REVIEW status (the REVIEW column on the board)."
            ;;
    esac
    SYSTEM_APPEND="Role: $ROLE. $ROLE_STATUS_DESC
CRITICAL: You MUST use Moe MCP tools (moe.claim_next_task, moe.get_context, moe.wait_for_task, etc.) for ALL task operations. NEVER read or parse .moe/ files directly. NEVER use bash, grep, python, or any other method to inspect .moe/ task files. The MCP tools are the ONLY correct way to interact with the task system."
    if [ "$AUTO_CLAIM" = true ]; then
        SYSTEM_APPEND="$SYSTEM_APPEND Start by claiming the next task for your role."
    fi

    # Append agent context
    if [ -n "$AGENT_CONTEXT" ]; then
        SYSTEM_APPEND="$SYSTEM_APPEND

$AGENT_CONTEXT"
    fi

    # Append approval mode
    if [ -n "$APPROVAL_MODE" ]; then
        SYSTEM_APPEND="$SYSTEM_APPEND

# Project Settings
Approval mode: $APPROVAL_MODE"
    fi

    # Append role doc
    if [ -n "$ROLE_DOC" ]; then
        SYSTEM_APPEND="$SYSTEM_APPEND

$ROLE_DOC"
    fi

    # Append known issues
    if [ -n "$KNOWN_ISSUES" ]; then
        SYSTEM_APPEND="$SYSTEM_APPEND

# Known Issues
$KNOWN_ISSUES"
    fi

    # Append team context
    if [ -n "$TEAM_CONTEXT" ]; then
        SYSTEM_APPEND="$SYSTEM_APPEND

# Team
$TEAM_CONTEXT"
    fi

    # Add pending questions instructions
    SYSTEM_APPEND="$SYSTEM_APPEND

# Pending Questions
Before claiming a task, call moe.get_pending_questions to check for unanswered human questions.
For each pending question, call moe.add_comment with your workerId and a response in this format:
  Q: <the human's question>
  A: <your answer based on task context>
This clears the pending flag so the question is answered for the next agent.
If moe.wait_for_task returns hasPendingQuestion:true, call moe.get_pending_questions and answer them, then resume waiting."

    # Add fallback CLI helper info
    moe_call="$SCRIPT_DIR/moe-call.sh"
    if [ -f "$moe_call" ]; then
        SYSTEM_APPEND="$SYSTEM_APPEND

# Fallback CLI
If MCP tools (moe.*) are not available, use the CLI helper instead:
  bash $moe_call <tool> '<json_args>' --project $PROJECT
Examples:
  bash $moe_call claim_next_task '{\"statuses\":[\"PLANNING\"],\"workerId\":\"$WORKER_ID\"}'
  bash $moe_call get_context '{\"workerId\":\"$WORKER_ID\"}'
  bash $moe_call submit_plan '{\"taskId\":\"task-xxx\",\"plan\":[...]}'
  bash $moe_call add_comment '{\"taskId\":\"task-xxx\",\"content\":\"my message\",\"workerId\":\"$WORKER_ID\"}'
  bash $moe_call wait_for_task '{\"statuses\":[\"PLANNING\"],\"workerId\":\"$WORKER_ID\",\"timeoutMs\":300000}'
Run: bash $moe_call --help for full list."
    fi

    PROMPT=""
    if [ "$AUTO_CLAIM" = true ]; then
        PROMPT="First call moe.get_pending_questions to check for unanswered questions. Answer any you find using moe.add_comment. Then use the MCP tool moe.claim_next_task with args $CLAIM_JSON. Do NOT read .moe/ files directly - only use moe.* MCP tools. If hasNext is false, call moe.wait_for_task with the same statuses and workerId. When it returns hasNext:true, call moe.claim_next_task again. If it returns hasPendingQuestion:true, call moe.get_pending_questions, answer them with moe.add_comment, then call moe.wait_for_task again. If it returns timedOut:true, call moe.wait_for_task again. Keep waiting until you get a task."
    else
        echo "Suggested first call:"
        echo "  moe.claim_next_task $CLAIM_JSON"
        echo ""
    fi

    if [ "$CLI_TYPE" = "codex" ]; then
        # Check codex is available
        if ! command -v "$COMMAND" &> /dev/null; then
            echo -e "${RED}[ERROR]${NC} Codex command not found: $COMMAND. Install codex CLI first."
            exit 1
        fi

        # Write system/role context to instructions file (codex reads it via model_instructions_file)
        # This avoids passing the long multi-line prompt as a CLI argument, which breaks codex's arg parser
        AGENT_INSTRUCTIONS_PATH="$PROJECT/.codex/agent-instructions.md"
        mkdir -p "$(dirname "$AGENT_INSTRUCTIONS_PATH")"
        printf '%s' "$SYSTEM_APPEND" > "$AGENT_INSTRUCTIONS_PATH"
        echo -e "${GREEN}[OK]${NC} Agent instructions written to: $AGENT_INSTRUCTIONS_PATH"

        # Build role-aware short prompt for Codex CLI argument
        # Codex instruction delivery chain:
        # 1. AGENTS.md → loaded automatically as project docs (generic project context)
        # 2. .codex/agent-instructions.md → loaded via model_instructions_file (full role doc + agent context)
        # 3. developer_instructions in config.toml → injected into session (role identity reinforcement)
        # 4. SHORT_PROMPT below → the user message prompt (role-aware first action)
        #
        # Claude equivalent: --append-system-prompt carries all context in a single system message
        ROLE_WORKFLOW=""
        case $ROLE in
            architect) ROLE_WORKFLOW="Workflow: claim task → get_context → explore codebase → submit_plan for approval" ;;
            worker)    ROLE_WORKFLOW="Workflow: claim task → get_context → start_step → implement → complete_step → complete_task" ;;
            qa)        ROLE_WORKFLOW="Workflow: claim task → get_context → review code and tests → qa_approve or qa_reject" ;;
            *)         ROLE_WORKFLOW="Workflow: claim task → get_context → complete task" ;;
        esac
        if [ "$AUTO_CLAIM" = true ]; then
            SHORT_PROMPT="You are a $ROLE agent. Use ONLY Moe MCP tools (moe.*). $ROLE_WORKFLOW. First: call moe.claim_next_task $CLAIM_JSON. If hasNext is false, say 'No tasks' and stop."
        else
            SHORT_PROMPT="You are a $ROLE agent. Use ONLY Moe MCP tools (moe.*). $ROLE_WORKFLOW. Start by calling moe.claim_next_task to get your next task."
        fi

        if [ "$CODEX_EXEC" = true ]; then
            # Non-interactive exec mode
            echo -e "Starting Codex (exec, headless)..."
            echo ""
            echo "Command: $COMMAND exec -C \"$PROJECT\" --full-auto --sandbox workspace-write \"<prompt>\""
            $COMMAND exec -C "$PROJECT" --full-auto --sandbox workspace-write "$SHORT_PROMPT" || true
        else
            # Interactive TUI mode
            echo "Starting Codex (interactive TUI)..."
            echo ""
            echo "Command: $COMMAND -C \"$PROJECT\" \"<prompt>\""
            $COMMAND -C "$PROJECT" "$SHORT_PROMPT" || true
        fi
    elif [ "$CLI_TYPE" = "gemini" ]; then
        # Check gemini is available
        if ! command -v "$COMMAND" &> /dev/null; then
            echo -e "${RED}[ERROR]${NC} Gemini command not found: $COMMAND. Install Gemini CLI first (npm install -g @anthropic-ai/gemini-cli or see https://github.com/google-gemini/gemini-cli)."
            exit 1
        fi

        # Write system/role context to .gemini/GEMINI.md (Gemini's native context file)
        # Gemini CLI auto-discovers and loads this file on every prompt
        GEMINI_INSTRUCTIONS_PATH="$PROJECT/.gemini/GEMINI.md"
        mkdir -p "$(dirname "$GEMINI_INSTRUCTIONS_PATH")"
        printf '%s' "$SYSTEM_APPEND" > "$GEMINI_INSTRUCTIONS_PATH"
        echo -e "${GREEN}[OK]${NC} Agent instructions written to: $GEMINI_INSTRUCTIONS_PATH"

        # Build role-aware short prompt for Gemini CLI argument
        # Gemini instruction delivery chain:
        # 1. AGENTS.md → loaded via context settings (generic project context)
        # 2. .gemini/GEMINI.md → loaded as project-level context (full role doc + agent context)
        # 3. SHORT_PROMPT below → the initial user message (role-aware first action)
        ROLE_WORKFLOW=""
        case $ROLE in
            architect) ROLE_WORKFLOW="Workflow: claim task → get_context → explore codebase → submit_plan for approval" ;;
            worker)    ROLE_WORKFLOW="Workflow: claim task → get_context → start_step → implement → complete_step → complete_task" ;;
            qa)        ROLE_WORKFLOW="Workflow: claim task → get_context → review code and tests → qa_approve or qa_reject" ;;
            *)         ROLE_WORKFLOW="Workflow: claim task → get_context → complete task" ;;
        esac
        if [ "$AUTO_CLAIM" = true ]; then
            SHORT_PROMPT="You are a $ROLE agent. Use ONLY Moe MCP tools (moe.*). $ROLE_WORKFLOW. First: call moe.claim_next_task $CLAIM_JSON. If hasNext is false, say 'No tasks' and stop."
        else
            SHORT_PROMPT="You are a $ROLE agent. Use ONLY Moe MCP tools (moe.*). $ROLE_WORKFLOW. Start by calling moe.claim_next_task to get your next task."
        fi

        if [ "$GEMINI_EXEC" = true ]; then
            # Non-interactive headless mode
            echo -e "Starting Gemini (headless, --yolo)..."
            echo ""
            echo "Command: $COMMAND --prompt \"<prompt>\" --yolo"
            (cd "$PROJECT" && $COMMAND --prompt "$SHORT_PROMPT" --yolo) || true
        else
            # Interactive mode
            echo "Starting Gemini (interactive)..."
            echo ""
            echo "Command: $COMMAND --prompt-interactive \"<prompt>\""
            (cd "$PROJECT" && $COMMAND --prompt-interactive "$SHORT_PROMPT") || true
        fi
    else
        # Enable CC Agent Teams for Claude workers when setting is on
        unset CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
        if [ "$ROLE" = "worker" ] && [ "$ENABLE_AGENT_TEAMS" = "true" ]; then
            export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
            echo -e "${GREEN}[OK]${NC} Agent Teams enabled for this worker session"
        fi

        if [ "$AUTO_CLAIM" = true ]; then
            echo "Starting ${CLI_TYPE} with auto-claim..."
            echo ""
            (cd "$PROJECT" && $COMMAND --append-system-prompt "$SYSTEM_APPEND" "$PROMPT") || true
        else
            (cd "$PROJECT" && $COMMAND) || true
        fi
    fi

    if [ "$LOOP_ENABLED" = false ]; then
        break
    fi
done
