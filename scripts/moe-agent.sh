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
    # Actually run --version to filter out the Windows Store shim that resolves
    # via `command -v python3` but errors with "Python was not found" when executed.
    if command -v python3 &> /dev/null && python3 --version &> /dev/null 2>&1; then
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

    # Windows (Git Bash / MSYS / WSL) -- PEP 397 launcher
    if command -v py &> /dev/null; then
        if py -3 --version &> /dev/null 2>&1; then
            echo "py -3"
            return 0
        fi
    fi

    # Last resort: plain `python` if it reports Python 3.x
    if command -v python &> /dev/null; then
        local py_version
        py_version=$(python --version 2>&1)
        if [[ "$py_version" == *"Python 3."* ]]; then
            echo "python"
            return 0
        fi
    fi

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
    with open(sys.argv[1]) as f:
        config = json.load(f)
    path = config.get('installPath', '')
    if path:
        print(path)
except:
    pass
" "$config_file" 2>/dev/null)
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
        # Create new config using python for safe JSON generation
        $PYTHON_CMD - "$config_file" "$PROJECT" "$PROXY_CMD" "$PROXY_ARGS" << 'EOF'
import json, sys
config_file = sys.argv[1]
project_path = sys.argv[2]
proxy_cmd = sys.argv[3]
proxy_args = sys.argv[4] if len(sys.argv) > 4 else ""
entry = {'command': proxy_cmd, 'env': {'MOE_PROJECT_PATH': project_path}}
if proxy_args:
    entry['args'] = [proxy_args]
config = {'mcpServers': {'moe': entry}}
with open(config_file, 'w') as f:
    json.dump(config, f, indent=2)
EOF
        echo -e "${GREEN}[OK]${NC} Created MCP config: $config_file"
    else
        # Update existing config using python3 (pass vars via argv to prevent injection)
        $PYTHON_CMD - "$config_file" "$PROJECT" "$PROXY_CMD" "$PROXY_ARGS" << 'EOF'
import json
import sys

config_file = sys.argv[1]
project_path = sys.argv[2]
proxy_cmd = sys.argv[3]
proxy_args = sys.argv[4] if len(sys.argv) > 4 else ""

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
        $PYTHON_CMD - "$project_mcp" "$PROXY_CMD" "$PROXY_ARGS" "$PROJECT" << 'MCPEOF'
import json
import sys

project_mcp = sys.argv[1]
proxy_cmd = sys.argv[2]
proxy_args = sys.argv[3] if len(sys.argv) > 3 else ""
project_path = sys.argv[4] if len(sys.argv) > 4 else ""

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
        $PYTHON_CMD - "$GEMINI_CONFIG_FILE" "$PROJECT" "$PROXY_CMD" "$PROXY_ARGS" << 'GEMINIEOF'
import json
import sys

config_file = sys.argv[1]
project_path = sys.argv[2]
proxy_cmd = sys.argv[3]
proxy_args = sys.argv[4] if len(sys.argv) > 4 else ""

# Build the desired moe MCP server entry
moe_entry = {
    'command': proxy_cmd,
    'env': {
        'MOE_PROJECT_PATH': project_path
    }
}
if proxy_args:
    moe_entry['args'] = [proxy_args]

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

# Auto-join role's default team (required for chat_send to accept the workerId)
# If --team not specified, use role-based default name
TEAM_CONTEXT=""
if [ -z "$TEAM" ]; then
    case $ROLE in
        architect) TEAM="Architects" ;;
        worker)    TEAM="Workers" ;;
        qa)        TEAM="QA" ;;
    esac
fi
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

    # Use python to safely construct JSON (prevents injection from special chars in team name)
    TEAM_CREATE_JSON=$($PYTHON_CMD -c "import json,sys; print(json.dumps({'name':sys.argv[1]}))" "$TEAM" 2>/dev/null)
    TEAM_CREATE_RPC=$($PYTHON_CMD -c "import json,sys; print(json.dumps({'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'moe.create_team','arguments':json.loads(sys.argv[1])}}))" "$TEAM_CREATE_JSON" 2>/dev/null)

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

            TEAM_JOIN_JSON=$($PYTHON_CMD -c "import json,sys; print(json.dumps({'teamId':sys.argv[1],'workerId':sys.argv[2]}))" "$TEAM_ID" "$WORKER_ID" 2>/dev/null)
            TEAM_JOIN_RPC=$($PYTHON_CMD -c "import json,sys; print(json.dumps({'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'moe.join_team','arguments':json.loads(sys.argv[1])}}))" "$TEAM_JOIN_JSON" 2>/dev/null)

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

# Expose Moe-vendored skills to the Claude Code Skill tool by mirroring
# <project>/.moe/skills/<name>/ into <project>/.claude/skills/<name>/. Claude
# Code only discovers project skills under .claude/skills/; it does not scan
# .moe/skills/. Prefer symlink so .moe/skills/ edits propagate immediately;
# fall back to copy if symlink creation fails.
MOE_SKILLS_DIR="$MOE_DIR/skills"
if [ -d "$MOE_SKILLS_DIR" ]; then
    CLAUDE_SKILLS_DIR="$PROJECT/.claude/skills"
    mkdir -p "$CLAUDE_SKILLS_DIR"
    mirrored=0
    skipped=0
    for src in "$MOE_SKILLS_DIR"/*/; do
        [ -d "$src" ] || continue
        name=$(basename "$src")
        dest="$CLAUDE_SKILLS_DIR/$name"
        if [ -e "$dest" ] || [ -L "$dest" ]; then
            skipped=$((skipped + 1))
            continue
        fi
        # Skill loader requires SKILL.md at dest root
        [ -f "${src}SKILL.md" ] || continue
        if ln -s "$src" "$dest" 2>/dev/null; then
            :
        else
            cp -R "$src" "$dest"
        fi
        mirrored=$((mirrored + 1))
    done
    if [ $mirrored -gt 0 ] || [ $skipped -gt 0 ]; then
        echo -e "${GREEN}[OK]${NC} Mirrored $mirrored skill(s) from .moe/skills/ to .claude/skills/ ($skipped already present)"
    fi
fi

# Load skills manifest (lean: name, role, description per skill).
# Bodies live in .moe/skills/<name>/SKILL.md and load on demand via the Skill tool.
SKILLS_LIST=""
SKILLS_MANIFEST_PATH="$MOE_DIR/skills/manifest.json"
if [ -f "$SKILLS_MANIFEST_PATH" ] && [ -n "$NODE_CMD" ]; then
    # Capture stderr separately so we can warn the user if parsing fails.
    SKILLS_STDERR=$(mktemp 2>/dev/null || echo "/tmp/moe-skills-stderr.$$")
    SKILLS_LIST=$("$NODE_CMD" -e "
try {
  const m = JSON.parse(require('fs').readFileSync(process.argv[1],'utf-8'));
  if (!Array.isArray(m.skills)) {
    process.stderr.write('manifest.skills is missing or not an array');
    process.exit(2);
  }
  // Render each skill with its trigger context so the agent recognizes WHEN
  // to invoke it, not just what it's about. Mirrors how Claude picks MCP
  // tools -- description alone is topic-oriented; triggers are actionable.
  const lines = m.skills.map(s => {
    const triggers = Array.isArray(s.triggeredBy) && s.triggeredBy.length
      ? '\n    when: ' + s.triggeredBy.join('; ')
      : '';
    return '- ' + s.name + ' (' + (s.role||'all') + '): ' + (s.description||'') + triggers;
  });
  process.stdout.write(lines.join('\n'));
} catch (e) { process.stderr.write(String(e && e.message || e)); process.exit(2); }
" "$SKILLS_MANIFEST_PATH" 2>"$SKILLS_STDERR" || true)
    if [ -n "$SKILLS_LIST" ]; then
        echo -e "${GREEN}[OK]${NC} Loaded skill manifest from: $SKILLS_MANIFEST_PATH"
    elif [ -s "$SKILLS_STDERR" ]; then
        echo -e "${YELLOW}[WARN]${NC} Skill manifest at $SKILLS_MANIFEST_PATH could not be parsed: $(cat "$SKILLS_STDERR")"
    fi
    rm -f "$SKILLS_STDERR"
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
# exit 0 triggers the EXIT trap which runs cleanup_temp
LOOP_RUNNING=true
trap 'echo ""; echo "Agent stopped."; exit 0' INT TERM

# moe_rpc TOOL ARGS_JSON
# Calls an MCP tool via the proxy and prints the tool's result text to stdout.
# Uses TEAM_PROXY / PROXY_CMD resolved earlier. Returns non-zero on failure.
moe_rpc() {
    local tool="$1"
    local args_json="${2:-{}}"
    local rpc
    rpc=$($PYTHON_CMD -c "
import json, sys
tool = sys.argv[1]
args = json.loads(sys.argv[2]) if sys.argv[2] else {}
if not tool.startswith('moe.'):
    tool = 'moe.' + tool
print(json.dumps({'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':tool,'arguments':args}}))
" "$tool" "$args_json" 2>/dev/null) || return 1

    local raw=""
    if [ -n "${TEAM_PROXY:-}" ]; then
        raw=$(echo "$rpc" | MOE_PROJECT_PATH="$PROJECT" "$NODE_CMD" "$TEAM_PROXY" 2>/dev/null) || return 1
    elif [ -n "${PROXY_CMD:-}" ]; then
        raw=$(echo "$rpc" | MOE_PROJECT_PATH="$PROJECT" $PROXY_CMD 2>/dev/null) || return 1
    else
        return 1
    fi

    $PYTHON_CMD -c "
import json, sys
raw = sys.stdin.read().strip()
if not raw:
    sys.exit(1)
for line in reversed(raw.split('\n')):
    line = line.strip()
    if not line:
        continue
    try:
        d = json.loads(line)
    except Exception:
        continue
    if 'error' in d:
        sys.stderr.write(json.dumps(d['error']) + '\n')
        sys.exit(1)
    if 'result' in d:
        r = d['result']
        if isinstance(r, dict) and 'content' in r:
            for c in r['content']:
                if c.get('type') == 'text':
                    print(c['text'])
                    sys.exit(0)
        print(json.dumps(r))
        sys.exit(0)
sys.exit(1)
" <<< "$raw"
}

FIRST_RUN=true

while [ "$LOOP_RUNNING" = true ]; do
    if [ "$FIRST_RUN" = false ]; then
        echo ""
        echo -e "${YELLOW}Agent exited, relaunching in 2 seconds... (Ctrl+C to stop)${NC}"
        sleep 2
        echo -e "${BLUE}Relaunching agent...${NC}"
    fi
    FIRST_RUN=false

    # -------- Pre-flight: perform startup rituals BEFORE spawning the CLI --------
    # Claim the next task, fetch context, read chat backlog, recall memory.
    # Results are baked into SYSTEM_APPEND/PROMPT below so the agent starts
    # already initialized instead of being told to do these via prompt.
    PREFLIGHT_TASK_ID=""
    PREFLIGHT_TASK_TITLE=""
    PREFLIGHT_TASK_CHANNEL=""
    PREFLIGHT_CONTEXT=""
    PREFLIGHT_GENERAL_UNREAD=""
    PREFLIGHT_TASK_UNREAD=""
    PREFLIGHT_RECALL=""
    PREFLIGHT_PENDING=""
    PREFLIGHT_SKILL_NAME=""
    PREFLIGHT_SKILL_REASON=""
    PREFLIGHT_SKILL_NEXT_TOOL=""
    PREFLIGHT_NO_TASK=false
    PREFLIGHT_OK=false
    PREFLIGHT_ROUTED_MENTIONS_JSON=""
    PREFLIGHT_ROUTED_MENTIONS_COUNT=0

    if [ "$AUTO_CLAIM" = true ]; then
        echo -e "${BLUE}Pre-flight: joining chat, claiming task, loading context...${NC}"

        # 0. Resolve #general channel id (chat tools take id, not name)
        GENERAL_CHANNEL_ID=""
        CHANNELS_RESP=$(moe_rpc chat_channels "{}" 2>/dev/null || echo "")
        if [ -n "$CHANNELS_RESP" ]; then
            GENERAL_CHANNEL_ID=$($PYTHON_CMD -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    for c in d.get('channels', []):
        if c.get('name') == 'general':
            print(c.get('id', ''))
            break
except Exception:
    pass
" <<< "$CHANNELS_RESP" 2>/dev/null || echo "")
        fi

        # 1. Join #general and read backlog (join is safe pre-claim; announce deferred to post-claim)
        if [ -n "$GENERAL_CHANNEL_ID" ]; then
            moe_rpc chat_join \
                "$($PYTHON_CMD -c "import json,sys; print(json.dumps({'channel':sys.argv[1],'workerId':sys.argv[2]}))" "$GENERAL_CHANNEL_ID" "$WORKER_ID" 2>/dev/null)" \
                > /dev/null 2>&1 || true

            # 2. Read unread #general messages
            PREFLIGHT_GENERAL_UNREAD=$(moe_rpc chat_read \
                "$($PYTHON_CMD -c "import json,sys; print(json.dumps({'channel':sys.argv[1],'workerId':sys.argv[2]}))" "$GENERAL_CHANNEL_ID" "$WORKER_ID" 2>/dev/null)" \
                2>/dev/null || echo "")
        fi

        # 3. Check pending questions
        PREFLIGHT_PENDING=$(moe_rpc get_pending_questions "{}" 2>/dev/null || echo "")

        # 4. Claim next task (auto-registers the worker)
        CLAIM_RESULT=$(moe_rpc claim_next_task "$CLAIM_JSON" 2>/dev/null || echo "")
        if [ -n "$CLAIM_RESULT" ]; then
            HAS_NEXT=$($PYTHON_CMD -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    print('true' if d.get('hasNext') else 'false')
except Exception:
    print('error')
" <<< "$CLAIM_RESULT" 2>/dev/null || echo "error")

            if [ "$HAS_NEXT" = "true" ]; then
                PREFLIGHT_TASK_ID=$($PYTHON_CMD -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    print(d.get('task', {}).get('id', ''))
except Exception:
    pass
" <<< "$CLAIM_RESULT" 2>/dev/null || echo "")
                PREFLIGHT_TASK_TITLE=$($PYTHON_CMD -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    print(d.get('task', {}).get('title', ''))
except Exception:
    pass
" <<< "$CLAIM_RESULT" 2>/dev/null || echo "")
                PREFLIGHT_TASK_CHANNEL=$($PYTHON_CMD -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    print(d.get('task', {}).get('chatChannel') or '')
except Exception:
    pass
" <<< "$CLAIM_RESULT" 2>/dev/null || echo "")

                # 5. Fetch context for the claimed task
                if [ -n "$PREFLIGHT_TASK_ID" ]; then
                    PREFLIGHT_CONTEXT=$(moe_rpc get_context \
                        "$($PYTHON_CMD -c "import json,sys; print(json.dumps({'taskId':sys.argv[1]}))" "$PREFLIGHT_TASK_ID" 2>/dev/null)" \
                        2>/dev/null || echo "")
                fi

                # 6. Read task channel backlog
                if [ -n "$PREFLIGHT_TASK_CHANNEL" ]; then
                    PREFLIGHT_TASK_UNREAD=$(moe_rpc chat_read \
                        "$($PYTHON_CMD -c "import json,sys; print(json.dumps({'channel':sys.argv[1],'workerId':sys.argv[2]}))" "$PREFLIGHT_TASK_CHANNEL" "$WORKER_ID" 2>/dev/null)" \
                        2>/dev/null || echo "")
                fi

                # 7. Recall relevant memory by task title
                if [ -n "$PREFLIGHT_TASK_TITLE" ]; then
                    PREFLIGHT_RECALL=$(moe_rpc recall \
                        "$($PYTHON_CMD -c "import json,sys; print(json.dumps({'query':sys.argv[1],'limit':10}))" "$PREFLIGHT_TASK_TITLE" 2>/dev/null)" \
                        2>/dev/null || echo "")
                fi

                # 8. Extract phase-recommended skill from context.nextAction. We
                #    DO NOT inline the body -- the agent loads it via the Skill tool.
                #    We only pull name + reason + the tool it gates, to emit a short
                #    JIT reminder further down in SYSTEM_APPEND.
                #
                #    The three fields are emitted NUL-separated so multi-line reasons
                #    (should one ever be introduced) don't corrupt the split.
                if [ -n "$PREFLIGHT_CONTEXT" ]; then
                    PARSED_SKILL=$($PYTHON_CMD -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    na = d.get('nextAction') or {}
    rec = na.get('recommendedSkill')
    name = ''
    reason = ''
    if isinstance(rec, dict):
        name = rec.get('name') or ''
        reason = rec.get('reason') or ''
    elif isinstance(rec, str):
        name = rec
    # NUL-separated so newlines inside reason are preserved verbatim.
    sys.stdout.write(name + '\0' + reason + '\0' + (na.get('tool') or '') + '\0')
except Exception:
    pass
" <<< "$PREFLIGHT_CONTEXT" 2>/dev/null || echo "")
                    # Split on NUL. IFS+read -d '' reads one NUL-terminated field at a time.
                    { IFS= read -r -d '' PREFLIGHT_SKILL_NAME
                      IFS= read -r -d '' PREFLIGHT_SKILL_REASON
                      IFS= read -r -d '' PREFLIGHT_SKILL_NEXT_TOOL
                    } <<< "$PARSED_SKILL" 2>/dev/null || true
                    # Fallback defaults if parse failed -- keep vars set to avoid
                    # "unbound variable" under `set -u` (not used today, but cheap).
                    PREFLIGHT_SKILL_NAME="${PREFLIGHT_SKILL_NAME:-}"
                    PREFLIGHT_SKILL_REASON="${PREFLIGHT_SKILL_REASON:-}"
                    PREFLIGHT_SKILL_NEXT_TOOL="${PREFLIGHT_SKILL_NEXT_TOOL:-}"
                fi
                if [ -n "$PREFLIGHT_SKILL_NAME" ]; then
                    echo -e "${BLUE}[skill]${NC} Recommending '$PREFLIGHT_SKILL_NAME' for this phase."
                fi

                PREFLIGHT_OK=true
                echo -e "${GREEN}[OK]${NC} Pre-flight complete. Claimed: $PREFLIGHT_TASK_ID ($PREFLIGHT_TASK_TITLE)"

                # Post-claim announce in #general (worker now registered, chat_send accepts it)
                if [ -n "$GENERAL_CHANNEL_ID" ]; then
                    moe_rpc chat_send \
                        "$($PYTHON_CMD -c "import json,sys; print(json.dumps({'channel':sys.argv[1],'workerId':sys.argv[2],'content':sys.argv[3]+' online, starting '+sys.argv[4]+': '+sys.argv[5]}))" "$GENERAL_CHANNEL_ID" "$WORKER_ID" "$ROLE" "$PREFLIGHT_TASK_ID" "$PREFLIGHT_TASK_TITLE" 2>/dev/null)" \
                        > /dev/null 2>&1 || true
                fi
            elif [ "$HAS_NEXT" = "false" ]; then
                PREFLIGHT_NO_TASK=true
                echo -e "${YELLOW}[INFO]${NC} No claimable task for role $ROLE. Agent will wait_for_task."
            else
                echo -e "${YELLOW}[WARN]${NC} Pre-flight claim returned unparseable response; falling back to in-agent claim."
            fi
        else
            echo -e "${YELLOW}[WARN]${NC} Pre-flight claim RPC failed (daemon/proxy error); falling back to in-agent claim."
        fi

        # Filter unread messages for ones routed at THIS worker. The model sees
        # <general_unread> as a wall and tends to skip replying. The
        # <routed_mentions> banner injected below gives it a focused list.
        # Match directly on WORKER_ID, on @all, or on the role-group tag this
        # worker belongs to (architects/workers/qa).
        if [ -n "$PYTHON_CMD" ]; then
            ROLE_GROUP_TAG=""
            case "$ROLE" in
                architect) ROLE_GROUP_TAG="architects" ;;
                worker)    ROLE_GROUP_TAG="workers" ;;
                qa)        ROLE_GROUP_TAG="qa" ;;
            esac
            MENTIONS_RESULT=$(PREFLIGHT_GENERAL_UNREAD="$PREFLIGHT_GENERAL_UNREAD" \
                              PREFLIGHT_TASK_UNREAD="$PREFLIGHT_TASK_UNREAD" \
                              "$PYTHON_CMD" - "$WORKER_ID" "$ROLE_GROUP_TAG" <<'PYEOF' 2>/dev/null || true
import sys, json, os
worker_id  = sys.argv[1]
role_group = sys.argv[2]
def extract_msgs(raw):
    if not raw:
        return []
    try:
        obj = json.loads(raw)
    except Exception:
        return []
    msgs = obj.get("messages") if isinstance(obj, dict) else None
    return msgs if isinstance(msgs, list) else []
hits = []
seen = set()
for env_name in ("PREFLIGHT_GENERAL_UNREAD", "PREFLIGHT_TASK_UNREAD"):
    for msg in extract_msgs(os.environ.get(env_name, "")):
        if not isinstance(msg, dict): continue
        mid = msg.get("id")
        if mid in seen: continue
        mentions = msg.get("mentions") or []
        if not isinstance(mentions, list): continue
        matched = False
        for m in mentions:
            if m == worker_id or m == "all" or (role_group and m == role_group):
                matched = True
                break
        if matched:
            hits.append({
                "id":      mid,
                "channel": msg.get("channel"),
                "sender":  msg.get("sender"),
                "content": msg.get("content"),
            })
            if mid is not None:
                seen.add(mid)
print(json.dumps({"count": len(hits), "messages": hits}))
PYEOF
            )
            if [ -n "$MENTIONS_RESULT" ]; then
                PREFLIGHT_ROUTED_MENTIONS_JSON="$MENTIONS_RESULT"
                PREFLIGHT_ROUTED_MENTIONS_COUNT=$("$PYTHON_CMD" -c "import json,sys; print(json.loads(sys.stdin.read()).get('count',0))" <<<"$MENTIONS_RESULT" 2>/dev/null || echo 0)
                if [ "$PREFLIGHT_ROUTED_MENTIONS_COUNT" -gt 0 ] 2>/dev/null; then
                    echo -e "${MAGENTA:-\033[0;35m}[mention]${NC} $PREFLIGHT_ROUTED_MENTIONS_COUNT unread message(s) tagging $WORKER_ID -- will surface in system prompt."
                fi
            fi
            unset MENTIONS_RESULT ROLE_GROUP_TAG
        fi
    fi
    # -------- End pre-flight --------

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

    # Append available-skills index (manifest only, not bodies -- bodies load on
    # demand via the Skill tool when relevant). The daemon also surfaces a
    # nextAction.recommendedSkill field per MCP response.
    if [ -n "$SKILLS_LIST" ]; then
        SYSTEM_APPEND="$SYSTEM_APPEND

# Available Skills (load via the Skill tool when the situation calls for one)
Each skill is deeper guidance for a specific phase of work. The daemon recommends one in nextAction.recommendedSkill when relevant -- invoke it via the host's Skill tool.

$SKILLS_LIST"
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

    # Append pre-flight results -- the agent starts already initialized.
    if [ "$PREFLIGHT_OK" = true ]; then
        SYSTEM_APPEND="$SYSTEM_APPEND

# Pre-flight Complete (runtime-injected -- do not repeat)
You ARE: $ROLE agent, workerId=$WORKER_ID.
The wrapper has ALREADY performed these steps before spawning you:
- joined #general and announced presence
- read unread #general messages (see <general_unread> below)
- claimed task $PREFLIGHT_TASK_ID: $PREFLIGHT_TASK_TITLE
- fetched its context (see <claimed_task_context> below)
- read its task chat backlog (see <task_chat_backlog> below)
- recalled relevant prior knowledge (see <relevant_memory> below)

DO NOT call at session start: moe.chat_join, moe.chat_send, moe.chat_read, moe.claim_next_task, moe.get_context, moe.recall. They are done.

Claimed task id: $PREFLIGHT_TASK_ID

<claimed_task_context>
$PREFLIGHT_CONTEXT
</claimed_task_context>

<general_unread>
$PREFLIGHT_GENERAL_UNREAD
</general_unread>

<task_chat_backlog>
$PREFLIGHT_TASK_UNREAD
</task_chat_backlog>

<relevant_memory>
$PREFLIGHT_RECALL
</relevant_memory>

<pending_questions>
$PREFLIGHT_PENDING
</pending_questions>"

        # JIT reminder: point the agent at the phase-recommended skill. We do
        # NOT inline the body -- the agent loads it itself via the Skill tool.
        # This is the nudge that keeps the agent from rationalizing past it.
        if [ -n "$PREFLIGHT_SKILL_NAME" ]; then
            JIT_NEXT_TOOL="${PREFLIGHT_SKILL_NEXT_TOOL:-your next Moe tool}"
            JIT_REASON="${PREFLIGHT_SKILL_REASON:-Phase-recommended for this task.}"
            SYSTEM_APPEND="$SYSTEM_APPEND

<system-reminder>
Skill recommendation for this task's current phase: $PREFLIGHT_SKILL_NAME
Why: $JIT_REASON
Before you call $JIT_NEXT_TOOL, invoke the Skill tool:
  Skill(skill=\"$PREFLIGHT_SKILL_NAME\")
This is not optional. Do not rationalize skipping it (\"I'm blocking, not planning\", \"this is trivial\", \"I already know what it says\"). Skills evolve -- load the current version.
If after loading you decide it truly does not apply here, say so explicitly in chat -- but LOAD IT FIRST.
</system-reminder>"
        fi
    elif [ "$PREFLIGHT_NO_TASK" = true ]; then
        SYSTEM_APPEND="$SYSTEM_APPEND

# Pre-flight Complete: no claimable task
The daemon reports no claimable task for role $ROLE right now.
Your FIRST action MUST be moe.wait_for_task with statuses=$STATUSES, workerId=$WORKER_ID.
When it returns hasNext:true, call moe.claim_next_task, then moe.get_context.
If moe.wait_for_task returns hasChatMessage:true, your NEXT calls MUST be moe.chat_read on chatMessage.channel, then moe.chat_send with your reply, THEN moe.wait_for_task again. Do not claim a new task while a routed mention is unanswered.
If hasPendingQuestion:true, call moe.get_pending_questions and answer with moe.add_comment."
    fi

    # Priority banner for unread messages routed at THIS worker. Injected LAST
    # (so it's the most recent text before the user prompt) to maximize the
    # chance the model acts on it before anything else. Role docs
    # (.moe/roles/<role>.md) back this up with the "Mention Response Protocol"
    # section -- the two work together.
    if [ "$PREFLIGHT_ROUTED_MENTIONS_COUNT" -gt 0 ] 2>/dev/null; then
        SYSTEM_APPEND="$SYSTEM_APPEND

<system-reminder>
# Incoming @mentions targeting you ($WORKER_ID)

You have $PREFLIGHT_ROUTED_MENTIONS_COUNT unread message(s) that named you directly, via @all, or via your role group. Before ANY other planned tool call (moe.start_step, moe.submit_plan, moe.qa_approve, moe.claim_next_task, etc.), you MUST reply to each via moe.chat_send in the same channel. Replies are substantive -- answer the question, confirm the handoff, or say why you can't. The Loop Guard (max 4 agent-to-agent hops per channel) is the system's throttle; you don't need your own.

<routed_mentions>
$PREFLIGHT_ROUTED_MENTIONS_JSON
</routed_mentions>
</system-reminder>"
    fi

    PROMPT=""
    if [ "$AUTO_CLAIM" = true ]; then
        if [ "$PREFLIGHT_OK" = true ]; then
            # Lean per-role prompt -- everything else is already in the system prompt.
            case $ROLE in
                architect)
                    PROMPT="Task $PREFLIGHT_TASK_ID is claimed and its full context is in your system prompt. If a <routed_mentions> block is present, reply to each tagged message via moe.chat_send FIRST. Then study the implementationPlan, rails, and definitionOfDone, and call moe.submit_plan with a complete plan. After submission, poll moe.check_approval. Once approved, call moe.save_session_summary, then moe.wait_for_task to pick up the next PLANNING task. If moe.wait_for_task wakes with hasChatMessage:true, moe.chat_read + moe.chat_send reply BEFORE claiming a new task."
                    ;;
                worker)
                    PROMPT="Task $PREFLIGHT_TASK_ID is claimed and its full context is in your system prompt. If a <routed_mentions> block is present, reply to each tagged message via moe.chat_send FIRST. Then execute the approved implementationPlan: call moe.start_step for step 0, implement it (write/edit code, run tests), call moe.complete_step, and repeat through the final step. Then call moe.complete_task. Before waiting for the next task, call moe.save_session_summary with what you did. Use moe.remember to save any non-obvious gotchas you discovered. Finally call moe.wait_for_task. If moe.wait_for_task wakes with hasChatMessage:true, moe.chat_read + moe.chat_send reply BEFORE claiming a new task."
                    ;;
                qa)
                    PROMPT="Task $PREFLIGHT_TASK_ID is claimed and its full context is in your system prompt. If a <routed_mentions> block is present, reply to each tagged message via moe.chat_send FIRST. Then verify the implementation against definitionOfDone and rails. Run the tests. If it passes, call moe.qa_approve. If it fails, call moe.qa_reject with a detailed list of issues. Then moe.save_session_summary and moe.wait_for_task. If moe.wait_for_task wakes with hasChatMessage:true, moe.chat_read + moe.chat_send reply BEFORE claiming a new task."
                    ;;
            esac
        elif [ "$PREFLIGHT_NO_TASK" = true ]; then
            PROMPT="No claimable task right now. Call moe.wait_for_task with statuses=$STATUSES, workerId=\"$WORKER_ID\". When it wakes with hasNext:true, call moe.claim_next_task with the same args, then moe.get_context. If it wakes with hasChatMessage:true, your next calls MUST be moe.chat_read on chatMessage.channel, then moe.chat_send with your reply, THEN moe.wait_for_task again. If it wakes with hasPendingQuestion:true, call moe.chat_read on that task's channel and answer the question. Do not claim a new task while a routed mention is unanswered."
        else
            # Pre-flight was skipped or failed -- fall back to the legacy multi-step prompt
            PROMPT="First call moe.chat_channels to find #general, then moe.chat_join and moe.chat_send to announce yourself as $ROLE. Then call moe.chat_read to catch up on any unread messages from other agents or human. Then call moe.get_pending_questions to check for unanswered questions. Answer any you find using moe.add_comment. Then use the MCP tool moe.claim_next_task with args $CLAIM_JSON. Do NOT read .moe/ files directly - only use moe.* MCP tools. If hasNext is false, call moe.wait_for_task with the same statuses and workerId. When it returns hasNext:true, call moe.claim_next_task again. If it returns hasChatMessage:true, call moe.chat_read to read and respond, then call moe.wait_for_task again. If it returns hasPendingQuestion:true, call moe.get_pending_questions, answer them with moe.add_comment, then call moe.wait_for_task again. If it returns timedOut:true, call moe.wait_for_task again. After claiming a task and calling moe.get_context, always check memory.relevant in the response and use moe.recall for deeper knowledge search. Before calling moe.wait_for_task, always call moe.save_session_summary to record what you accomplished and discovered. Keep waiting until you get a task."
        fi
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
        # 2. .codex/agent-instructions.md → loaded via model_instructions_file (full role doc + agent context + pre-flight results)
        # 3. developer_instructions in config.toml → injected into session (role identity reinforcement)
        # 4. SHORT_PROMPT below → the user message prompt (role-aware first action)
        if [ "$AUTO_CLAIM" = true ] && [ "$PREFLIGHT_OK" = true ]; then
            SHORT_PROMPT="$PROMPT"
        elif [ "$AUTO_CLAIM" = true ] && [ "$PREFLIGHT_NO_TASK" = true ]; then
            SHORT_PROMPT="$PROMPT"
        else
            # Legacy fallback -- pre-flight skipped or failed
            ROLE_WORKFLOW=""
            case $ROLE in
                architect) ROLE_WORKFLOW="Workflow: join chat → read messages → claim task → get_context → recall memory → explore codebase → submit_plan → save learnings → save session summary → announce in chat" ;;
                worker)    ROLE_WORKFLOW="Workflow: join chat → read messages → claim task → read task chat → get_context → recall memory → start_step → implement → complete_step → save learnings → complete_task → save session summary → announce in chat" ;;
                qa)        ROLE_WORKFLOW="Workflow: join chat → read messages → claim task → read task chat → get_context → recall memory → review code and tests → qa_approve or qa_reject → save learnings → save session summary → announce in chat" ;;
                *)         ROLE_WORKFLOW="Workflow: claim task → get_context → recall memory → complete task → save session summary" ;;
            esac
            if [ "$AUTO_CLAIM" = true ]; then
                SHORT_PROMPT="You are a $ROLE agent. Use ONLY Moe MCP tools (moe.*). $ROLE_WORKFLOW. First: join #general via moe.chat_channels, moe.chat_join, and moe.chat_send. Then moe.chat_read to catch up on messages. Then call moe.claim_next_task $CLAIM_JSON. If hasNext is false, say 'No tasks' and stop."
            else
                SHORT_PROMPT="You are a $ROLE agent. Use ONLY Moe MCP tools (moe.*). $ROLE_WORKFLOW. First: join #general via moe.chat_channels, moe.chat_join, and moe.chat_send. Then moe.chat_read to catch up on messages. Then call moe.claim_next_task to get your next task."
            fi
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
        # 2. .gemini/GEMINI.md → loaded as project-level context (full role doc + agent context + pre-flight results)
        # 3. SHORT_PROMPT below → the initial user message (role-aware first action)
        if [ "$AUTO_CLAIM" = true ] && [ "$PREFLIGHT_OK" = true ]; then
            SHORT_PROMPT="$PROMPT"
        elif [ "$AUTO_CLAIM" = true ] && [ "$PREFLIGHT_NO_TASK" = true ]; then
            SHORT_PROMPT="$PROMPT"
        else
            ROLE_WORKFLOW=""
            case $ROLE in
                architect) ROLE_WORKFLOW="Workflow: join chat → read messages → claim task → get_context → recall memory → explore codebase → submit_plan → save learnings → save session summary → announce in chat" ;;
                worker)    ROLE_WORKFLOW="Workflow: join chat → read messages → claim task → read task chat → get_context → recall memory → start_step → implement → complete_step → save learnings → complete_task → save session summary → announce in chat" ;;
                qa)        ROLE_WORKFLOW="Workflow: join chat → read messages → claim task → read task chat → get_context → recall memory → review code and tests → qa_approve or qa_reject → save learnings → save session summary → announce in chat" ;;
                *)         ROLE_WORKFLOW="Workflow: claim task → get_context → recall memory → complete task → save session summary" ;;
            esac
            if [ "$AUTO_CLAIM" = true ]; then
                SHORT_PROMPT="You are a $ROLE agent. Use ONLY Moe MCP tools (moe.*). $ROLE_WORKFLOW. First: join #general via moe.chat_channels, moe.chat_join, and moe.chat_send. Then moe.chat_read to catch up on messages. Then call moe.claim_next_task $CLAIM_JSON. If hasNext is false, say 'No tasks' and stop."
            else
                SHORT_PROMPT="You are a $ROLE agent. Use ONLY Moe MCP tools (moe.*). $ROLE_WORKFLOW. First: join #general via moe.chat_channels, moe.chat_join, and moe.chat_send. Then moe.chat_read to catch up on messages. Then call moe.claim_next_task to get your next task."
            fi
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

        # Write system prompt to a temp file to avoid command-line size/quoting issues
        # (system prompt contains XML tags, backticks, and JSON that can break arg passing)
        SYSTEM_PROMPT_FILE=$(create_secure_temp)/system-prompt.md
        printf '%s' "$SYSTEM_APPEND" > "$SYSTEM_PROMPT_FILE"

        if [ "$AUTO_CLAIM" = true ]; then
            echo "Starting ${CLI_TYPE} with auto-claim..."
            echo ""
            (cd "$PROJECT" && "$COMMAND" --append-system-prompt-file "$SYSTEM_PROMPT_FILE" --effort max "$PROMPT") || true
        else
            (cd "$PROJECT" && "$COMMAND" --append-system-prompt-file "$SYSTEM_PROMPT_FILE" --effort max) || true
        fi
    fi

    # -------- Post-flight: shutdown rituals after CLI exits --------
    # Save session summary and announce completion in #general. Best-effort -- any
    # RPC failure does not block loop continuation.
    if [ "$AUTO_CLAIM" = true ] && [ -n "$PREFLIGHT_TASK_ID" ]; then
        echo -e "${BLUE}Post-flight: saving session summary, announcing outcome...${NC}"

        # Check task's final status and reopenCount (agent may have completed,
        # paused, or bailed; reopenCount drives commit-message wording below).
        POSTFLIGHT_STATE=$(moe_rpc list_tasks '{}' 2>/dev/null || echo "")
        FINAL_STATUS=""
        FINAL_REOPEN_COUNT="0"
        if [ -n "$POSTFLIGHT_STATE" ]; then
            PARSED_POSTFLIGHT=$($PYTHON_CMD -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    for t in d.get('tasks', []):
        if t.get('id') == sys.argv[1]:
            # NUL-separated so we don't collide with whitespace in fields.
            sys.stdout.write((t.get('status') or '') + '\0' + str(t.get('reopenCount') or 0) + '\0')
            break
except Exception:
    pass
" "$PREFLIGHT_TASK_ID" <<< "$POSTFLIGHT_STATE" 2>/dev/null || echo "")
            { IFS= read -r -d '' FINAL_STATUS
              IFS= read -r -d '' FINAL_REOPEN_COUNT
            } <<< "$PARSED_POSTFLIGHT" 2>/dev/null || true
            FINAL_STATUS="${FINAL_STATUS:-}"
            FINAL_REOPEN_COUNT="${FINAL_REOPEN_COUNT:-0}"
        fi

        # Save session summary -- captures what this session accomplished, even if aborted.
        # If the daemon already has a summary from the agent's own moe.save_session_summary,
        # this is a best-effort no-op thanks to dedup.
        moe_rpc save_session_summary \
            "$($PYTHON_CMD -c "import json,sys; print(json.dumps({'workerId':sys.argv[1],'taskId':sys.argv[2],'summary':sys.argv[3]}))" \
                "$WORKER_ID" "$PREFLIGHT_TASK_ID" "wrapper post-flight: session ended with task status=${FINAL_STATUS:-unknown}" 2>/dev/null)" \
            > /dev/null 2>&1 || true

        # Announce outcome in #general
        if [ -n "$GENERAL_CHANNEL_ID" ] && [ -n "$FINAL_STATUS" ]; then
            case "$FINAL_STATUS" in
                DONE|REVIEW)
                    ANNOUNCE_TEXT="$ROLE completed $PREFLIGHT_TASK_ID (now $FINAL_STATUS)" ;;
                WORKING|AWAITING_APPROVAL)
                    ANNOUNCE_TEXT="$ROLE paused $PREFLIGHT_TASK_ID (still $FINAL_STATUS)" ;;
                *)
                    ANNOUNCE_TEXT="$ROLE exited $PREFLIGHT_TASK_ID (status: $FINAL_STATUS)" ;;
            esac
            moe_rpc chat_send \
                "$($PYTHON_CMD -c "import json,sys; print(json.dumps({'channel':sys.argv[1],'workerId':sys.argv[2],'content':sys.argv[3]}))" \
                    "$GENERAL_CHANNEL_ID" "$WORKER_ID" "$ANNOUNCE_TEXT" 2>/dev/null)" \
                > /dev/null 2>&1 || true
        fi

        # Auto-commit + push on worker completion. Runs when:
        #   - role is worker
        #   - task is now in REVIEW (worker just called moe.complete_task, either
        #     first time or retry after qa_reject)
        #   - project.json `settings.autoCommit` is not explicitly false
        #   - $PROJECT is a git repo with a remote
        # All operations are best-effort: failures log a warning but never abort
        # the wrapper loop. Commits use whatever git identity the user has
        # configured -- no Claude/Codex attribution.
        if [ "$ROLE" = "worker" ] && [ "$FINAL_STATUS" = "REVIEW" ]; then
            AUTO_COMMIT=$($PYTHON_CMD -c "
import json, os
p = os.path.join('$MOE_DIR', 'project.json')
try:
    d = json.load(open(p))
    v = (d.get('settings') or {}).get('autoCommit')
    # Default true: autoCommit is opt-out, not opt-in.
    print('false' if v is False else 'true')
except Exception:
    print('true')
" 2>/dev/null || echo "true")
            if [ "$AUTO_COMMIT" = "true" ]; then
                if git -C "$PROJECT" rev-parse --git-dir > /dev/null 2>&1; then
                    echo -e "${BLUE}Post-flight: auto-commit+push (settings.autoCommit=true)...${NC}"

                    # Never commit/push directly to main or master. If the worker
                    # finished on the default branch, peel off onto a shared Moe
                    # working branch (moe/work-<YYYY-MM-DD>) before committing.
                    # Uncommitted/staged changes follow the checkout. Existing
                    # non-default branches are reused as-is -- this is not
                    # branch-per-task.
                    CURRENT_BRANCH=$(git -C "$PROJECT" rev-parse --abbrev-ref HEAD 2>/dev/null)
                    if [ "$CURRENT_BRANCH" = "main" ] || [ "$CURRENT_BRANCH" = "master" ]; then
                        MOE_BRANCH="moe/work-$(date +%Y-%m-%d)"
                        echo -e "${YELLOW}[branch]${NC} on $CURRENT_BRANCH; switching to $MOE_BRANCH so we don't commit to the default branch."
                        if git -C "$PROJECT" rev-parse --verify --quiet "refs/heads/$MOE_BRANCH" > /dev/null 2>&1; then
                            git -C "$PROJECT" checkout "$MOE_BRANCH" 2>&1 | tail -2
                        elif git -C "$PROJECT" rev-parse --verify --quiet "refs/remotes/origin/$MOE_BRANCH" > /dev/null 2>&1; then
                            git -C "$PROJECT" checkout -b "$MOE_BRANCH" "origin/$MOE_BRANCH" 2>&1 | tail -2
                        else
                            git -C "$PROJECT" checkout -b "$MOE_BRANCH" 2>&1 | tail -2
                        fi
                        CURRENT_BRANCH=$(git -C "$PROJECT" rev-parse --abbrev-ref HEAD 2>/dev/null)
                        if [ "$CURRENT_BRANCH" != "$MOE_BRANCH" ]; then
                            echo -e "${YELLOW}[WARN]${NC} failed to switch off default branch; aborting auto-commit to avoid writing to it."
                            continue
                        fi
                    fi

                    COMMIT_TYPE="feat"
                    COMMIT_SUFFIX=""
                    if [ "$FINAL_REOPEN_COUNT" -gt 0 ] 2>/dev/null; then
                        COMMIT_TYPE="fix"
                        COMMIT_SUFFIX=" (retry after qa_reject #$FINAL_REOPEN_COUNT)"
                    fi
                    COMMIT_MSG="$COMMIT_TYPE($PREFLIGHT_TASK_ID): ${PREFLIGHT_TASK_TITLE:-completed task}$COMMIT_SUFFIX

Completed via Moe worker session."
                    # Stage everything in the worktree. The worker may have
                    # already committed mid-session; in that case `git diff
                    # --cached --quiet` returns 0 and we skip the commit, then
                    # still push to ship those mid-session commits.
                    git -C "$PROJECT" add -A 2>/dev/null || true
                    if ! git -C "$PROJECT" diff --cached --quiet 2>/dev/null; then
                        if git -C "$PROJECT" commit -m "$COMMIT_MSG" 2>&1 | tail -3; then
                            echo -e "${GREEN}[OK]${NC} Committed task $PREFLIGHT_TASK_ID on $CURRENT_BRANCH."
                        else
                            echo -e "${YELLOW}[WARN]${NC} git commit failed (pre-commit hook? detached HEAD?); skipping push."
                        fi
                    else
                        echo -e "${BLUE}[info]${NC} No staged changes to commit (worker may have already committed mid-session)."
                    fi
                    # Push whatever commits are ahead of the upstream. If the
                    # current branch has no upstream yet (fresh moe/work-* branch),
                    # set it on first push so subsequent `git push` succeeds.
                    if git -C "$PROJECT" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' > /dev/null 2>&1; then
                        PUSH_OUT=$(git -C "$PROJECT" push 2>&1)
                    else
                        PUSH_OUT=$(git -C "$PROJECT" push -u origin "$CURRENT_BRANCH" 2>&1)
                    fi
                    if [ $? -eq 0 ]; then
                        echo "$PUSH_OUT" | tail -5
                        echo -e "${GREEN}[OK]${NC} Pushed task $PREFLIGHT_TASK_ID to $CURRENT_BRANCH."
                    else
                        echo "$PUSH_OUT" | tail -5
                        echo -e "${YELLOW}[WARN]${NC} git push failed (no upstream? auth? network?) -- resolve and push manually."
                    fi
                else
                    echo -e "${YELLOW}[info]${NC} $PROJECT is not a git repo -- skipping auto-commit+push."
                fi
            fi
        fi
    fi
    # -------- End post-flight --------

    if [ "$LOOP_ENABLED" = false ]; then
        break
    fi
done
