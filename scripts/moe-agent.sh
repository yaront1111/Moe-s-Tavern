#!/bin/bash
# Moe Agent Wrapper for Mac/Linux
# Equivalent of moe-agent.ps1 for Windows

set -e

# Never let a git call (push/pull/fetch over https) block the wrapper on a
# credential prompt: there is no human on the other end of a fleet terminal.
export GIT_TERMINAL_PROMPT=0

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
        newest=$(find "$HOME/.nvm/versions/node" -maxdepth 1 -type d -name "v*" 2>/dev/null | sort -V | tail -n1)
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
    # This is the EXIT trap: it inherits `set -e`, and a failing command here
    # would abort the trap half-way (no rescue, no deregister). Everything
    # below is best-effort.
    set +e
    # Kill the heartbeat sidecar first — it's just a background subshell, not
    # tracked by anything else, so a hard exit (Ctrl+C, error) would otherwise
    # leak it past this process's own lifetime. HEARTBEAT_PID/stop_heartbeat_sidecar
    # are defined later in the script but read/called here at exit time.
    if [ "$(type -t stop_heartbeat_sidecar)" = "function" ]; then
        stop_heartbeat_sidecar
    fi
    # Teardown rescue BEFORE deregister: if this session holds a task with a
    # baseline and never completed a landing (Ctrl+C mid-CLI, set -e abort),
    # park its edits on refs/moe/rescue/<taskId>/<ts> so a peer re-claiming
    # the released task cannot absorb them. Idempotent; the persisted baseline
    # still makes the next pre-flight land them on the branch.
    if [ "$(type -t teardown_rescue)" = "function" ]; then
        teardown_rescue || true
    fi
    # Gracefully release any task this worker still holds so the next agent can
    # claim it immediately. This is best-effort and never blocks exit. There is
    # NO idle-timeout fallback for hard crashes where this trap never runs: the
    # task stays assigned until daemon restart, deregister, or an explicit
    # release. WORKER_ID/PROJECT are set later in the script but read here at
    # exit time.
    if [ -n "${WORKER_ID:-}" ] && [ -n "${PROJECT:-}" ] && [ -f "$SCRIPT_DIR/moe-call.sh" ]; then
        # Via bash, not direct exec: bundled copies can lose the exec bit
        # (e.g. a bundler writeFile), which would silently skip deregister.
        bash "$SCRIPT_DIR/moe-call.sh" deregister_worker \
            "{\"workerId\":\"$WORKER_ID\",\"reason\":\"terminal_closed\"}" \
            --project "$PROJECT" >/dev/null 2>&1 || true
    fi
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
LIST_PROJECTS=false
NO_START_DAEMON=false
AUTO_CLAIM=true
POLL_INTERVAL=30
NO_LOOP=false
LOOP_REQUESTED=false
TEAM=""
CODEX_EXEC=false
GEMINI_EXEC=false
INTERACTIVE_REQUESTED=""
MODEL=""

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
        --loop)
            LOOP_REQUESTED=true
            shift
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
        --interactive)
            INTERACTIVE_REQUESTED=true
            shift
            ;;
        --no-interactive)
            INTERACTIVE_REQUESTED=false
            shift
            ;;
        --model)
            MODEL="$2"
            shift 2
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
            echo "  --loop                   Explicitly enable polling loop mode"
            echo "  --no-loop                Run once and exit (no polling)"
            echo "  -t, --team NAME          Team name for parallel same-role agents"
            echo "  --codex-exec             Use codex exec mode (non-interactive, headless)"
            echo "  --gemini-exec            Use gemini headless mode (non-interactive, --yolo)"
            echo "  --interactive            Force Claude into interactive TUI (default: on for architect/governor)"
            echo "  --no-interactive         Force one-shot --print mode (default for worker/qa; fresh CLI per task)"
            echo "  --model MODEL            Claude model override (default: all roles = opus-5)"
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

if [ "$LOOP_REQUESTED" = true ] && [ "$NO_LOOP" = true ]; then
    echo -e "${RED}Conflicting options: --loop and --no-loop cannot be used together${NC}" >&2
    echo "Choose either --loop for polling mode or --no-loop for single-shot mode." >&2
    exit 2
fi

# Validate role
if [[ ! "$ROLE" =~ ^(architect|worker|qa|governor)$ ]]; then
    echo -e "${RED}Invalid role: $ROLE${NC}"
    echo "Valid roles: architect, worker, qa, governor"
    exit 1
fi

# Detect CLI type from command name. Parse $COMMAND once into a binary + argv array so quoted multi-word paths
# (e.g. "C:\Program Files\claude\claude.exe") AND inline args
# (e.g. "claude --foo") both round-trip correctly. The previous
# `${COMMAND%% *}` would split the first space, mangling either case.
COMMAND_BIN=""
COMMAND_ARGV=()
parse_command_into_argv() {
    local line="$1"
    local python_bin="${PYTHON_CMD:-python3}"
    if command -v "$python_bin" &> /dev/null; then
        # \x1f-separated so argv elements containing whitespace survive read.
        # NOT NUL: bash command substitution strips NUL bytes, which merged all
        # tokens and left COMMAND_BIN empty (launch exec'd "" -> ": command not
        # found").
        local parsed
        parsed=$("$python_bin" -c 'import shlex,sys
for t in shlex.split(sys.argv[1], posix=True):
    sys.stdout.write(t + "\x1f")' "$line" 2>/dev/null) || return 1
        COMMAND_ARGV=()
        while IFS= read -r -d $'\x1f' tok; do
            COMMAND_ARGV+=("$tok")
        done <<< "$parsed"
        COMMAND_BIN="${COMMAND_ARGV[0]:-}"
        if [ ${#COMMAND_ARGV[@]} -gt 0 ]; then
            COMMAND_ARGV=("${COMMAND_ARGV[@]:1}")
        fi
        return 0
    fi
    # Fallback if python is unavailable. Strip one layer of surrounding quotes
    # and treat the rest as a single binary path (no extra args). Good enough
    # for the dominant case (`claude` / `codex` / a single quoted path).
    local stripped="$line"
    stripped="${stripped#\"}"
    stripped="${stripped%\"}"
    stripped="${stripped#\'}"
    stripped="${stripped%\'}"
    COMMAND_BIN="$stripped"
    COMMAND_ARGV=()
    return 0
}
parse_command_first_token() {
    # Convenience wrapper that returns just the first token. Used during
    # CLI-type detection before find_python has fully run (the function above
    # tolerates a missing PYTHON_CMD but is overkill for that path).
    parse_command_into_argv "$1"
    printf '%s\n' "$COMMAND_BIN"
}

CLI_TYPE="claude"
CMD_FIRST=$(parse_command_first_token "$COMMAND")
CMD_BASE=$(basename "$CMD_FIRST")
# Strip Windows extension so `claude.exe` / `codex.cmd` etc. still match.
CMD_BASE="${CMD_BASE%.*}"
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

# Resolve final INTERACTIVE: explicit --interactive / --no-interactive wins,
# otherwise architect + governor default to true (planning is a conversation,
# governance is interactive oversight), worker and qa default to false. The
# false default is load-bearing, not cosmetic: the TUI never exits on its own,
# and this wrapper blocks inside the CLI call for its whole lifetime, so an
# interactive worker never reaches the post-flight below -- no session-end
# announce and, worse, no auto-commit+push for a task that reached REVIEW.
if [ -n "$INTERACTIVE_REQUESTED" ]; then
    INTERACTIVE="$INTERACTIVE_REQUESTED"
elif [ "$ROLE" = "architect" ] || [ "$ROLE" = "governor" ]; then
    INTERACTIVE=true
else
    INTERACTIVE=false
fi
CLAUDE_INTERACTIVE=false
if [ "$CLI_TYPE" = "claude" ] && [ "$INTERACTIVE" = true ]; then
    CLAUDE_INTERACTIVE=true
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

# Re-parse $COMMAND now that PYTHON_CMD is resolved, so quoted paths and
# inline args are split correctly via shlex (the initial parse during
# CLI-type detection may have hit the no-python fallback).
parse_command_into_argv "$COMMAND"
if [ -z "$COMMAND_BIN" ]; then
    echo -e "${RED}[ERROR]${NC} Could not parse --command '$COMMAND' into a binary; refusing to launch an empty command."
    exit 1
fi

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
        # Look up in registry. Pass PROJECT_NAME via argv to prevent shell->python
        # injection if the name contains single quotes or backslashes.
        registry=$(load_registry)
        PROJECT=$(echo "$registry" | $PYTHON_CMD -c "
import json, sys
data = json.load(sys.stdin)
name = sys.argv[1]
for p in data:
    if p.get('name') == name:
        print(p.get('path', ''))
        sys.exit(0)
sys.exit(1)
" "$PROJECT_NAME" 2>/dev/null)
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
    # 8 hex chars (~4 billion space) -- 4 chars (~65K space) collided under
    # simultaneous multi-agent launches from JetBrains.
    SHORT_ID=$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 8)
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

    # Resolve the Serena binary (LSP symbol navigation/editing). Pinned to this
    # project below so agents get exact cross-file code intelligence. Empty if not
    # installed -> the python writers skip the serena entry. Override: MOE_SERENA_PATH.
    SERENA_CMD="${MOE_SERENA_PATH:-}"
    if [ -z "$SERENA_CMD" ]; then
        if [ -x "$HOME/.local/bin/serena" ]; then
            SERENA_CMD="$HOME/.local/bin/serena"
        elif command -v serena &> /dev/null; then
            SERENA_CMD="serena"
        fi
    fi

    # Resolve Serena's project root, DECOUPLED from the Moe project root. A
    # multi-repo workspace root (no single language root, e.g. no root go.mod)
    # yields near-empty symbol intelligence from gopls/Serena, so pin Serena at
    # the actual code repo. Resolution order:
    #   1) "serenaProject" in <project>/.moe-agent.json  (per-project, lives with the workspace)
    #   2) $MOE_SERENA_PROJECT                            (ad-hoc / CI override)
    #   3) the Moe project root                           (correct for single-repo projects)
    # Computed ONCE here (where SERENA_CMD is resolved) and exported so the
    # claude/codex/gemini config writers below all see the same value; they read
    # it via argv (their heredocs are quoted, so bash does not interpolate inside).
    SERENA_PROJECT=""
    SERENA_PROJECT_SOURCE="project root"
    local moe_agent_config="$PROJECT/.moe-agent.json"
    if [ -f "$moe_agent_config" ]; then
        SERENA_PROJECT=$($PYTHON_CMD -c "
import json, sys
try:
    with open(sys.argv[1]) as f:
        d = json.load(f)
    print(d.get('serenaProject', ''))
except Exception:
    print('')
" "$moe_agent_config" 2>/dev/null)
        if [ -n "$SERENA_PROJECT" ]; then
            SERENA_PROJECT_SOURCE=".moe-agent.json"
        fi
    fi
    if [ -z "$SERENA_PROJECT" ] && [ -n "${MOE_SERENA_PROJECT:-}" ]; then
        SERENA_PROJECT="$MOE_SERENA_PROJECT"
        SERENA_PROJECT_SOURCE="MOE_SERENA_PROJECT"
    fi
    if [ -n "$SERENA_PROJECT" ] && [ ! -d "$SERENA_PROJECT" ]; then
        echo -e "${YELLOW}[WARN]${NC} Serena project '$SERENA_PROJECT' (from $SERENA_PROJECT_SOURCE) not found; using Moe project root" >&2
        SERENA_PROJECT=""
        SERENA_PROJECT_SOURCE="project root (override not found)"
    fi
    if [ -z "$SERENA_PROJECT" ]; then
        SERENA_PROJECT="$PROJECT"
    fi
    export SERENA_PROJECT
    if [ -n "$SERENA_CMD" ]; then
        echo -e "${GREEN}[OK]${NC} Serena MCP project: $SERENA_PROJECT (source: $SERENA_PROJECT_SOURCE)"
    fi

    # Create or update config
    if [ ! -f "$config_file" ]; then
        # Create new config using python for safe JSON generation
        $PYTHON_CMD - "$config_file" "$PROJECT" "$PROXY_CMD" "$PROXY_ARGS" "$SERENA_CMD" "$SERENA_PROJECT" << 'EOF'
import json, sys
config_file = sys.argv[1]
project_path = sys.argv[2]
proxy_cmd = sys.argv[3]
proxy_args = sys.argv[4] if len(sys.argv) > 4 else ""
serena_cmd = sys.argv[5] if len(sys.argv) > 5 else ""
serena_project = sys.argv[6] if len(sys.argv) > 6 else project_path
entry = {'command': proxy_cmd, 'env': {'MOE_PROJECT_PATH': project_path}}
if proxy_args:
    entry['args'] = [proxy_args]
config = {'mcpServers': {'moe': entry}}
if serena_cmd:
    config['mcpServers']['serena'] = {
        'command': serena_cmd,
        'args': ['start-mcp-server', '--context', 'claude-code', '--project', serena_project,
                 '--enable-web-dashboard', 'false', '--enable-gui-log-window', 'false'],
    }
with open(config_file, 'w') as f:
    json.dump(config, f, indent=2)
EOF
        echo -e "${GREEN}[OK]${NC} Created MCP config: $config_file"
    else
        # Update existing config using python3 (pass vars via argv to prevent injection)
        $PYTHON_CMD - "$config_file" "$PROJECT" "$PROXY_CMD" "$PROXY_ARGS" "$SERENA_CMD" "$SERENA_PROJECT" << 'EOF'
import json
import sys

config_file = sys.argv[1]
project_path = sys.argv[2]
proxy_cmd = sys.argv[3]
proxy_args = sys.argv[4] if len(sys.argv) > 4 else ""
serena_cmd = sys.argv[5] if len(sys.argv) > 5 else ""
serena_project = sys.argv[6] if len(sys.argv) > 6 else project_path

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

if serena_cmd:
    config['mcpServers']['serena'] = {
        'command': serena_cmd,
        'args': ['start-mcp-server', '--context', 'claude-code', '--project', serena_project,
                 '--enable-web-dashboard', 'false', '--enable-gui-log-window', 'false'],
    }
elif 'serena' in config['mcpServers']:
    del config['mcpServers']['serena']

with open(config_file, 'w') as f:
    json.dump(config, f, indent=2)

print(f"[OK] Updated MCP config: {config_file}")
EOF
    fi

    # Also write project-level .mcp.json so Claude Code finds MCP tools
    # regardless of working directory or global config issues
    local project_mcp="$PROJECT/.mcp.json"
    if [ -n "$PROXY_CMD" ]; then
        $PYTHON_CMD - "$project_mcp" "$PROXY_CMD" "$PROXY_ARGS" "$PROJECT" "$SERENA_CMD" "$SERENA_PROJECT" << 'MCPEOF'
import json
import sys

project_mcp = sys.argv[1]
proxy_cmd = sys.argv[2]
proxy_args = sys.argv[3] if len(sys.argv) > 3 else ""
project_path = sys.argv[4] if len(sys.argv) > 4 else ""
serena_cmd = sys.argv[5] if len(sys.argv) > 5 else ""
serena_project = sys.argv[6] if len(sys.argv) > 6 else project_path

entry = {
    'command': proxy_cmd,
    'env': {
        'MOE_PROJECT_PATH': project_path
    }
}
if proxy_args:
    entry['args'] = [proxy_args]

config = {'mcpServers': {'moe': entry}}

if serena_cmd:
    config['mcpServers']['serena'] = {
        'command': serena_cmd,
        'args': ['start-mcp-server', '--context', 'claude-code', '--project', serena_project,
                 '--enable-web-dashboard', 'false', '--enable-gui-log-window', 'false'],
    }

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

    # Normalize the Serena project path the same way PROJECT is normalized (line
    # ~505) so a raw Windows backslash path from .moe-agent.json/MOE_SERENA_PROJECT
    # becomes a forward-slash path before it lands in the TOML string.
    TOML_SERENA_PROJECT=$(normalize_path "$SERENA_PROJECT")

    if [ -n "$TOML_PROXY_CMD" ]; then
        $PYTHON_CMD - "$CODEX_CONFIG_FILE" "$TOML_PROXY_CMD" "$TOML_PROXY_ARGS" "$PROJECT" "$ROLE" "$SERENA_CMD" "$TOML_SERENA_PROJECT" "${MOE_CODEX_REASONING_EFFORT:-xhigh}" << 'PYEOF'
import sys, os, re, json

config_file = sys.argv[1]
proxy_cmd = sys.argv[2]
proxy_args = sys.argv[3]
project_path = sys.argv[4]
role = sys.argv[5] if len(sys.argv) > 5 else "worker"
serena_cmd = sys.argv[6] if len(sys.argv) > 6 else ""
serena_project = sys.argv[7] if len(sys.argv) > 7 else project_path
reasoning_effort = sys.argv[8] if len(sys.argv) > 8 else "xhigh"

# Top-level config lines (role instructions + model instructions)
top_level_lines = [
    'model_instructions_file = "agent-instructions.md"',
    'model_reasoning_effort = ' + json.dumps(reasoning_effort),
    'developer_instructions = """You are a ' + role + ' agent in the Moe AI Workforce system. You MUST use Moe MCP tools (moe.*) for ALL task operations. Follow the Moe workflow strictly. Never edit .moe/ files directly."""',
]
top_level_block = "\n".join(top_level_lines)

# Build the moe MCP server TOML block. Emit every string/array value via
# json.dumps -- JSON strings are valid TOML basic strings, so this escapes
# Windows backslashes and embedded quotes instead of injecting raw text into the
# TOML (which a backslash path or a quote would otherwise corrupt).
# Codex's default MCP startup timeout is 30s, which the proxy can exceed while
# it waits for a supervised daemon (re)start to rewrite daemon.json.
try:
    startup_timeout_sec = int(os.environ.get("MOE_CODEX_MCP_STARTUP_TIMEOUT_SEC", "120"))
except ValueError:
    startup_timeout_sec = 120
moe_block_lines = [
    "",
    "[mcp_servers.moe]",
    'command = ' + json.dumps(proxy_cmd),
]
if proxy_args:
    moe_block_lines.append('args = ' + json.dumps([proxy_args]))
moe_block_lines.append('startup_timeout_sec = %d' % startup_timeout_sec)
moe_block_lines.extend([
    "",
    "[mcp_servers.moe.env]",
    'MOE_PROJECT_PATH = ' + json.dumps(project_path),
])
# Persist a pre-set daemon host override (WSL cross-boundary runs). The
# discovered-at-runtime case is handled by the post-discovery upsert in the
# main flow -- daemon host probing runs after this writer.
if os.environ.get("MOE_DAEMON_HOST"):
    moe_block_lines.append('MOE_DAEMON_HOST = ' + json.dumps(os.environ["MOE_DAEMON_HOST"]))
moe_block = "\n".join(moe_block_lines)

# Build the serena MCP server TOML block (LSP code intelligence + memory, pinned
# to this project). Empty when Serena isn't installed. Serena needs no .env table.
serena_block = ""
if serena_cmd:
    serena_block = "\n".join([
        "",
        "[mcp_servers.serena]",
        'command = ' + json.dumps(serena_cmd),
        'args = ' + json.dumps(["start-mcp-server", "--context", "codex", "--project", serena_project,
                                 "--enable-web-dashboard", "false", "--enable-gui-log-window", "false"]),
    ])

if os.path.exists(config_file):
    # Merge: read existing, remove old moe sections and moe-managed top-level keys
    with open(config_file, "r") as f:
        content_str = f.read()

    # Remove old model_instructions_file / model_reasoning_effort lines
    content_str = re.sub(r'^model_instructions_file\s*=.*\n?', '', content_str, flags=re.MULTILINE)
    content_str = re.sub(r'^model_reasoning_effort\s*=.*\n?', '', content_str, flags=re.MULTILINE)

    # Remove old developer_instructions (triple-quoted multi-line)
    content_str = re.sub(r'^developer_instructions\s*=\s*""".*?"""\s*\n?', '', content_str, flags=re.MULTILINE | re.DOTALL)
    # Remove old developer_instructions (single-line)
    content_str = re.sub(r'^developer_instructions\s*=\s*"[^"]*"\s*\n?', '', content_str, flags=re.MULTILINE)

    # Filter out the sections this writer owns and re-emits: [mcp_servers.moe],
    # [mcp_servers.moe.env], [mcp_servers.serena]. Serena SUBtables (e.g.
    # [mcp_servers.serena.tools.*], user-authored per-tool config) are kept while
    # Serena is installed, but must be stripped when it is not: an orphaned
    # [mcp_servers.serena.*] with no parent transport makes codex reject the
    # whole config ("invalid transport in mcp_servers.serena").
    def strips(header):
        if header.startswith("[mcp_servers.moe]") or header.startswith("[mcp_servers.moe.env]"):
            return True
        if header.startswith("[mcp_servers.serena]"):
            return True
        if not serena_cmd and header.startswith("[mcp_servers.serena."):
            return True
        return False

    lines = content_str.splitlines(True)
    cleaned = []
    skip = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("["):
            skip = strips(stripped)
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
        content = content_str[:pos].rstrip() + "\n" + top_level_block + "\n\n" + content_str[pos:].rstrip() + "\n" + moe_block + serena_block + "\n"
    else:
        content = content_str.rstrip() + "\n" + top_level_block + "\n" + moe_block + serena_block + "\n"
else:
    # Create new config
    content = '# Codex project config (auto-generated by moe-agent)\nproject_doc_fallback_filenames = ["CLAUDE.md", ".codex/agent-instructions.md"]\n' + top_level_block + "\n" + moe_block + serena_block + "\n"

with open(config_file, "w") as f:
    f.write(content)
PYEOF

        if [ -f "$CODEX_CONFIG_FILE" ]; then
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
        $PYTHON_CMD - "$GEMINI_CONFIG_FILE" "$PROJECT" "$PROXY_CMD" "$PROXY_ARGS" "$SERENA_CMD" "$SERENA_PROJECT" << 'GEMINIEOF'
import json
import sys

config_file = sys.argv[1]
project_path = sys.argv[2]
proxy_cmd = sys.argv[3]
proxy_args = sys.argv[4] if len(sys.argv) > 4 else ""
serena_cmd = sys.argv[5] if len(sys.argv) > 5 else ""
serena_project = sys.argv[6] if len(sys.argv) > 6 else project_path

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

# Serena MCP (LSP code intelligence + memory), pinned to this project. Set/refresh
# when installed; drop a stale entry when it isn't, for parity with the claude writer.
if serena_cmd:
    config['mcpServers']['serena'] = {
        'command': serena_cmd,
        'args': ['start-mcp-server', '--context', 'agent', '--project', serena_project,
                 '--enable-web-dashboard', 'false', '--enable-gui-log-window', 'false'],
    }
elif 'serena' in config.get('mcpServers', {}):
    del config['mcpServers']['serena']

with open(config_file, 'w') as f:
    json.dump(config, f, indent=2)

print(f"[OK] Gemini MCP config written to: {config_file}")
GEMINIEOF

        if [ -f "$GEMINI_CONFIG_FILE" ]; then
            echo -e "${GREEN}[OK]${NC} Gemini MCP config written to: $GEMINI_CONFIG_FILE"
        else
            echo -e "${RED}[ERROR]${NC} Failed to write Gemini MCP config"
            exit 1
        fi
    fi
fi

# HTTP /health probe against a daemon endpoint. Used when a PID check cannot
# answer liveness (a Windows daemon's PID is invisible inside WSL).
probe_daemon_health() {
    local host="$1"
    local port="$2"
    $PYTHON_CMD -c "
import json, sys, urllib.request
try:
    with urllib.request.urlopen('http://%s:%s/health' % (sys.argv[1], sys.argv[2]), timeout=3) as r:
        d = json.load(r)
    sys.exit(0 if d.get('status') == 'healthy' else 1)
except Exception:
    sys.exit(1)
" "$host" "$port" 2>/dev/null
}

# Default gateway of a NAT-mode WSL distro = the Windows host.
wsl_gateway_host() {
    ip route show default 2>/dev/null | awk '{print $3; exit}'
}

# Start daemon if needed
if [ "$NO_START_DAEMON" = false ]; then
    DAEMON_INFO="$MOE_DIR/daemon.json"
    RUNNING=false
    FOREIGN_DAEMON=false

    if [ -f "$DAEMON_INFO" ]; then
        # Try to read PID/port/projectPath from daemon.json
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

        DAEMON_PORT=$($PYTHON_CMD -c "import json,sys; print(json.load(open(sys.argv[1])).get('port', ''))" "$DAEMON_INFO" 2>/dev/null || echo "")
        DAEMON_PROJECT=$($PYTHON_CMD -c "import json,sys; print(json.load(open(sys.argv[1])).get('projectPath', ''))" "$DAEMON_INFO" 2>/dev/null || echo "")

        # daemon.json written by a Windows-side daemon while we run under
        # WSL/Linux: its PID is invisible here, so kill -0 would misread a live
        # daemon as stale, delete its discovery file, and spawn a duplicate
        # daemon onto the same .moe/. Detect via the projectPath form and
        # answer liveness over HTTP instead.
        if [[ "$OSTYPE" != "msys" && "$OSTYPE" != "cygwin" && "$DAEMON_PROJECT" =~ ^[A-Za-z]:[\\/] ]]; then
            FOREIGN_DAEMON=true
        fi

        if [ "$FOREIGN_DAEMON" = true ]; then
            if [ -z "$DAEMON_PORT" ]; then
                echo -e "${RED}[ERROR]${NC} daemon.json (Windows daemon) has no port; cannot probe it from this environment"
                exit 1
            fi
            # Candidate hosts: explicit override, loopback (mirrored networking),
            # then the WSL default gateway (NAT mode, daemon bound to 0.0.0.0).
            DAEMON_HOST_CANDIDATES=""
            [ -n "${MOE_DAEMON_HOST:-}" ] && DAEMON_HOST_CANDIDATES="$MOE_DAEMON_HOST"
            DAEMON_HOST_CANDIDATES="$DAEMON_HOST_CANDIDATES 127.0.0.1"
            if is_wsl; then
                GW=$(wsl_gateway_host)
                [ -n "$GW" ] && DAEMON_HOST_CANDIDATES="$DAEMON_HOST_CANDIDATES $GW"
            fi
            for CANDIDATE in $DAEMON_HOST_CANDIDATES; do
                if probe_daemon_health "$CANDIDATE" "$DAEMON_PORT"; then
                    export MOE_DAEMON_HOST="$CANDIDATE"
                    echo -e "${GREEN}[OK]${NC} Windows-side daemon reachable at $CANDIDATE:$DAEMON_PORT (cross-boundary)"
                    RUNNING=true
                    break
                fi
            done
            if [ "$RUNNING" = false ]; then
                echo -e "${RED}[ERROR]${NC} daemon.json points at a Windows-side daemon ($DAEMON_PROJECT, port $DAEMON_PORT) that is not reachable from here (tried:$DAEMON_HOST_CANDIDATES)."
                echo -e "${YELLOW}Fix options:${NC}"
                echo "  - Restart the daemon listening beyond loopback: --host 0.0.0.0 (or MOE_BIND_HOST=0.0.0.0)"
                echo "  - Allow inbound TCP $DAEMON_PORT from the WSL subnet in Windows Defender Firewall"
                echo "  - Or set MOE_DAEMON_HOST to the address the daemon is reachable at"
                echo "Refusing to touch daemon.json or start a second daemon over the same .moe/."
                echo "If the Windows daemon is genuinely gone, delete $DAEMON_INFO manually and re-run."
                exit 1
            fi
        elif [ -n "$PID" ]; then
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

# Persist the discovered cross-boundary daemon host into the codex MCP config.
# The codex writer runs BEFORE daemon host discovery, so a WSL launch would
# otherwise leave [mcp_servers.moe.env] without MOE_DAEMON_HOST and the proxy
# dialing loopback whenever codex doesn't forward the wrapper's environment to
# spawned MCP servers. Idempotent; no-op when MOE_DAEMON_HOST is unset
# (same-host daemon) or the config doesn't exist.
if [ "$CLI_TYPE" = "codex" ] && [ -n "${MOE_DAEMON_HOST:-}" ] && [ -f "$PROJECT/.codex/config.toml" ]; then
    $PYTHON_CMD - "$PROJECT/.codex/config.toml" "$MOE_DAEMON_HOST" << 'PYEOF'
import sys, re, json

config_file, daemon_host = sys.argv[1], sys.argv[2]
with open(config_file, "r") as f:
    lines = f.read().splitlines(True)

entry = 'MOE_DAEMON_HOST = ' + json.dumps(daemon_host) + "\n"
out, in_env, done = [], False, False
for line in lines:
    stripped = line.strip()
    if stripped.startswith("["):
        if in_env and not done:
            if out and not out[-1].endswith("\n"):
                out[-1] += "\n"
            out.append(entry)
            done = True
        in_env = stripped == "[mcp_servers.moe.env]"
        out.append(line)
        continue
    if in_env and not done and re.match(r'^MOE_DAEMON_HOST\s*=', stripped):
        out.append(entry)
        done = True
        continue
    out.append(line)
if in_env and not done:
    if out and not out[-1].endswith("\n"):
        out[-1] += "\n"
    out.append(entry)
    done = True

if done:
    with open(config_file, "w") as f:
        f.write("".join(out))
    print(f"[OK] Codex MCP config: MOE_DAEMON_HOST={daemon_host}")
PYEOF
fi

# Auto-join role's default team (required for chat_send to accept the workerId)
# If --team not specified, use role-based default name
TEAM_CONTEXT=""
if [ -z "$TEAM" ]; then
    case $ROLE in
        architect) TEAM="Architects" ;;
        worker)    TEAM="Workers" ;;
        qa)        TEAM="QA" ;;
        governor)  TEAM="Governors" ;;
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

    # Use python to safely construct JSON (prevents injection from special chars in team name).
    # Team creation is idempotent on (name, role). enter_governance strictly requires
    # team.role === 'governor', so the governor role gets a role-bound team. For
    # architect/worker/qa we omit role: a user-supplied $TEAM like "Cordum" should
    # mean ONE shared team across those roles. The mention router falls back to a
    # workerId-substring match for @architects/@workers/@qa when team.role isn't set.
    if [ "$ROLE" = "governor" ]; then
        TEAM_CREATE_JSON=$($PYTHON_CMD -c "import json,sys; print(json.dumps({'name':sys.argv[1],'role':'governor'}))" "$TEAM" 2>/dev/null)
    else
        TEAM_CREATE_JSON=$($PYTHON_CMD -c "import json,sys; print(json.dumps({'name':sys.argv[1]}))" "$TEAM" 2>/dev/null)
    fi
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
    governor)
        # Governor does NOT claim tasks via statuses -- uses enter_governance
        # in the preflight section below. Empty array keeps CLAIM_JSON
        # well-defined for legacy/fallback prompt branches.
        STATUSES='[]'
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

# Load role documentation. load_role_doc is re-run every loop iteration: the
# daemon upgrades .moe/roles/ in place (sha-marker convention) while this
# wrapper runs, and a respawned agent must pick up the latest guidance.
# Unchanged file -> identical bytes -> the prompt-cache prefix stays stable.
load_role_doc() {
    ROLE_DOC=""
    ROLE_DOC_PATH="$MOE_DIR/roles/$ROLE.md"
    if [ ! -f "$ROLE_DOC_PATH" ]; then
        # Fall back to docs/roles/
        ROLE_DOC_PATH="$ROOT_DIR/docs/roles/$ROLE.md"
    fi
    if [ -f "$ROLE_DOC_PATH" ]; then
        ROLE_DOC=$(cat "$ROLE_DOC_PATH")
    fi
}

load_role_doc
if [ -n "$ROLE_DOC" ]; then
    echo -e "${GREEN}[OK]${NC} Loaded role doc from: $ROLE_DOC_PATH"
else
    echo -e "${YELLOW}[WARN]${NC} Role documentation not found: $ROLE.md"
fi

# Agent context is no longer auto-injected; role doc + CLAUDE.md cover the same
# ground without duplication. Per-task context comes from <claimed_task_context>.
AGENT_CONTEXT=""

# Read approval mode from project.json (lightweight, no jq dependency)
APPROVAL_MODE=""
PROJECT_JSON="$MOE_DIR/project.json"
if [ -f "$PROJECT_JSON" ]; then
    APPROVAL_MODE=$(grep -o '"approvalMode"[[:space:]]*:[[:space:]]*"[^"]*"' "$PROJECT_JSON" 2>/dev/null | head -1 | sed 's/.*"approvalMode"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
    if [ -n "$APPROVAL_MODE" ]; then
        echo -e "${GREEN}[OK]${NC} Approval mode: $APPROVAL_MODE"
    fi
fi

# Read enableAgentTeams from project.json. Subagents are now on by default for
# every Moe role; explicit `false` opts out. Was previously opt-in for workers only.
ENABLE_AGENT_TEAMS="true"
if [ -f "$PROJECT_JSON" ]; then
    RAW=$(grep -o '"enableAgentTeams"[[:space:]]*:[[:space:]]*[a-z]*' "$PROJECT_JSON" 2>/dev/null | head -1 | sed 's/.*:[[:space:]]*//' || true)
    if [ "$RAW" = "false" ]; then
        ENABLE_AGENT_TEAMS="false"
        echo -e "${GREEN}[OK]${NC} Agent Teams: disabled (project.json opt-out)"
    else
        echo -e "${GREEN}[OK]${NC} Agent Teams: enabled"
    fi
fi

# Resolve Claude model for this role.
# Precedence: --model flag -> project.json settings.models.<role> -> per-role default.
# All roles -> Opus 5. Override per role via project.json settings.models.{role}.
RESOLVED_MODEL="$MODEL"
if [ -z "$RESOLVED_MODEL" ] && [ -f "$PROJECT_JSON" ] && [ -n "$PYTHON_CMD" ]; then
    RESOLVED_MODEL=$("$PYTHON_CMD" -c "
import json, sys
try:
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        d = json.load(f)
    print((d.get('settings', {}).get('models', {}) or {}).get(sys.argv[2], '') or '')
except Exception:
    pass
" "$PROJECT_JSON" "$ROLE" 2>/dev/null || true)
fi
if [ -z "$RESOLVED_MODEL" ]; then
    # All roles default to Opus 5 -- matches moe-agent.ps1. Launched with
    # --effort max below. Override per role via project.json settings.models.{role}.
    case "$ROLE" in
        architect) RESOLVED_MODEL="claude-opus-5" ;;
        worker)    RESOLVED_MODEL="claude-opus-5" ;;
        qa)        RESOLVED_MODEL="claude-opus-5" ;;
        governor)  RESOLVED_MODEL="claude-opus-5" ;;
    esac
fi
if [ -n "$RESOLVED_MODEL" ]; then
    echo -e "${GREEN}[OK]${NC} Model: $RESOLVED_MODEL"
fi

# Load known issues if present
KNOWN_ISSUES=""
KNOWN_ISSUES_PATH="$MOE_DIR/KNOWN_ISSUES.md"
if [ -f "$KNOWN_ISSUES_PATH" ]; then
    KNOWN_ISSUES=$(cat "$KNOWN_ISSUES_PATH")
    echo -e "${GREEN}[OK]${NC} Loaded known issues from: $KNOWN_ISSUES_PATH"
fi

# Skill discovery: the daemon surfaces phase-recommended skills via
# nextAction.recommendedSkill on every MCP response. Skills live on disk under
# .moe/skills/; the agent loads them via its host's Skill tool when relevant.

# Mirror .moe/agents/<name>.md to .claude/agents/<name>.md so Claude Code's
# subagent loader discovers them. Idempotent: only copies files that don't
# already exist in the destination (preserves user customizations).
if [ "$ENABLE_AGENT_TEAMS" = "true" ] && [ -d "$MOE_DIR/agents" ]; then
    CLAUDE_AGENTS_DIR="$PROJECT/.claude/agents"
    mkdir -p "$CLAUDE_AGENTS_DIR"
    AGENT_MIRRORED=0
    AGENT_SKIPPED=0
    for src in "$MOE_DIR/agents"/*.md; do
        [ -f "$src" ] || continue
        name=$(basename "$src")
        dest="$CLAUDE_AGENTS_DIR/$name"
        if [ -e "$dest" ]; then
            AGENT_SKIPPED=$((AGENT_SKIPPED + 1))
            continue
        fi
        cp "$src" "$dest"
        AGENT_MIRRORED=$((AGENT_MIRRORED + 1))
    done
    if [ $AGENT_MIRRORED -gt 0 ] || [ $AGENT_SKIPPED -gt 0 ]; then
        echo -e "${GREEN}[OK]${NC} Subagents: mirrored $AGENT_MIRRORED, kept $AGENT_SKIPPED existing (.moe/agents/ -> .claude/agents/)"
    fi
fi

LOOP_ENABLED=false
if [ "$AUTO_CLAIM" = true ] && [ "$POLL_INTERVAL" -gt 0 ] 2>/dev/null; then
    LOOP_ENABLED=true
fi
if [ "$LOOP_REQUESTED" = true ] && [ "$POLL_INTERVAL" -gt 0 ] 2>/dev/null; then
    LOOP_ENABLED=true
fi
if [ "$NO_LOOP" = true ]; then
    LOOP_ENABLED=false
fi

if [ "$CODEX_INTERACTIVE" = true ] || [ "$GEMINI_INTERACTIVE" = true ]; then
    # Codex / Gemini TUIs hold a single long-lived REPL session — looping them
    # would just respawn the same TUI on top of the previous one. Claude's
    # interactive mode is fine to loop: each iteration spawns a fresh CLI
    # invocation, so per-task cache replay matches --print mode.
    LOOP_ENABLED=false
    if [ "$NO_LOOP" = false ]; then
        echo "Interactive mode: polling disabled"
    fi
elif [ "$CLAUDE_INTERACTIVE" = true ] && [ "$LOOP_ENABLED" = true ]; then
    echo "Claude interactive mode: polling enabled (each task spawns a fresh TUI)"
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
    # NOTE: not "${2:-{}}" — bash ends the brace expansion at the FIRST '}',
    # so with $2 set that form appends a stray '}' to the caller's JSON
    # ('{"a":1}' -> '{"a":1}}'), silently failing every RPC that passes args.
    local args_json="${2:-}"
    if [ -z "$args_json" ]; then args_json='{}'; fi
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

# The CLI invocation below blocks this process for the CLI's entire runtime
# with no interleaved activity of our own. moe-proxy opens a fresh connection
# per RPC call rather than holding one for the CLI's lifetime, so the
# daemon's ONLY liveness signal is "did this worker call a moe.* tool
# recently." A long silent local step (a build, a full test run) can go quiet
# longer than the 30-min REVIEW self-heal window even while the CLI is very
# much still running and about to call qa_approve/qa_reject — the self-heal
# then yanks the task out from under a live session. This sidecar pings
# moe.heartbeat on a timer from a background subshell (inherits moe_rpc and
# every resolved proxy/project variable, so no separate resolution needed) so
# a genuinely-alive-but-quiet session keeps its task. Bounded by
# MOE_HEARTBEAT_MAX_DURATION_SEC so a truly-hung CLI still eventually goes
# stale — this extends the self-heal's patience window, it does not defeat it.
HEARTBEAT_PID=""
start_heartbeat_sidecar() {
    local worker_id="$1"
    if [ "${MOE_DISABLE_HEARTBEAT:-}" = "1" ]; then return; fi
    local interval_sec="${MOE_HEARTBEAT_INTERVAL_SEC:-60}"
    local max_duration_sec="${MOE_HEARTBEAT_MAX_DURATION_SEC:-7200}"
    (
        set +e
        end_time=$(( $(date +%s) + max_duration_sec ))
        while [ "$(date +%s)" -lt "$end_time" ]; do
            sleep "$interval_sec"
            moe_rpc "heartbeat" "{\"workerId\":\"$worker_id\"}" >/dev/null 2>&1
        done
    ) &
    HEARTBEAT_PID=$!
}

stop_heartbeat_sidecar() {
    if [ -n "$HEARTBEAT_PID" ]; then
        kill "$HEARTBEAT_PID" 2>/dev/null || true
        wait "$HEARTBEAT_PID" 2>/dev/null || true
        HEARTBEAT_PID=""
    fi
}

post_flight() {
    local exit_code="${CLI_EXIT_CODE:-0}"

    if [ "${PREFLIGHT_OK:-false}" != "true" ] || [ -z "${PREFLIGHT_TASK_ID:-}" ]; then
        return 0
    fi

    # Session handoff is no longer persisted by the wrapper: cross-session memory
    # now lives in Serena (the agent writes a `task-<id>-handoff` note before it
    # stops). The post-flight chat message below remains the session-ended signal.
    if [ -n "${GENERAL_CHANNEL_ID:-}" ]; then
        local content
        content="$ROLE session ended: task=$PREFLIGHT_TASK_ID (CLI exit=$exit_code) commit=${LAND_SUMMARY_SHA:-none} kind=${LAND_SUMMARY_KIND:-none} paths=${LAND_SUMMARY_PATHS:-0} inferred=${LAND_SUMMARY_INFERRED:-0} unattributed=${LAND_SUMMARY_UNATTR:-0}"
        # Same suffix as the ps1 twin: a landing that did not commit carries
        # its outcome + code so governors can triage from the chat line alone.
        if [ -n "${LAND_SUMMARY_OUTCOME:-}" ] && [ "${LAND_SUMMARY_OUTCOME:-}" != "committed" ] && [ -n "${LAND_SUMMARY_CODE:-}" ]; then
            content="$content outcome=$LAND_SUMMARY_OUTCOME code=$LAND_SUMMARY_CODE"
        fi
        if ! moe_rpc chat_send \
            "$($PYTHON_CMD -c "import json,sys; print(json.dumps({'channel':sys.argv[1],'workerId':sys.argv[2],'content':sys.argv[3]}))" \
                "$GENERAL_CHANNEL_ID" "$WORKER_ID" "$content" 2>/dev/null)" \
            > /dev/null 2>&1; then
            echo -e "${YELLOW}[WARN]${NC} post-flight chat_send failed" >&2
        fi
    fi

    return 0
}

# announce_push_failure TASK_ID
# Best-effort loud, daemon-visible warning that auto-commit pushed nothing for a
# task that has already flipped to REVIEW. The task is reviewable in the board
# but its code never reached the remote -- QA would review stale/missing work.
# Posts to #general via chat_send (the daemon broadcasts it to every connected
# client) and always returns 0 so it never aborts the loop.
announce_push_failure() {
    local task_id="$1"
    local msg="PUSH FAILED for task $task_id -- committed locally only; do not review until pushed"
    if [ -n "${GENERAL_CHANNEL_ID:-}" ]; then
        moe_rpc chat_send \
            "$($PYTHON_CMD -c "import json,sys; print(json.dumps({'channel':sys.argv[1],'workerId':sys.argv[2],'content':sys.argv[3]}))" \
                "$GENERAL_CHANNEL_ID" "$WORKER_ID" "$msg" 2>/dev/null)" \
            > /dev/null 2>&1 || true
    fi
    return 0
}

# announce_gate_failure TASK_ID GATE_CMD GATE_RC GATE_OUT
# Best-effort loud, daemon-visible warning that settings.qualityGate failed and
# the auto-commit+push were skipped for a task that has already flipped to
# REVIEW. Posts to #general via chat_send and attaches the tail of the gate
# output to the task via add_comment so QA/humans can see WHY without digging
# through wrapper logs. Always returns 0 so it never aborts the loop.
announce_gate_failure() {
    local task_id="$1"
    local gate_cmd="$2"
    local gate_rc="$3"
    local gate_out="$4"
    local msg="🚫 PUSH-BLOCKED: qualityGate failed for task $task_id: $gate_cmd (exit $gate_rc)"
    if [ -n "${GENERAL_CHANNEL_ID:-}" ]; then
        moe_rpc chat_send \
            "$($PYTHON_CMD -c "import json,sys; print(json.dumps({'channel':sys.argv[1],'workerId':sys.argv[2],'content':sys.argv[3]}))" \
                "$GENERAL_CHANNEL_ID" "$WORKER_ID" "$msg" 2>/dev/null)" \
            > /dev/null 2>&1 || true
    fi
    # Last ~50 lines only (and cap the bytes): add_comment rejects content over
    # 10k chars and a failing build's full output can be huge.
    local out_tail content
    out_tail=$(printf '%s\n' "$gate_out" | tail -50 | tail -c 8000)
    content="$msg

$out_tail"
    moe_rpc add_comment \
        "$($PYTHON_CMD -c "import json,sys; print(json.dumps({'taskId':sys.argv[1],'workerId':sys.argv[2],'content':sys.argv[3]}))" \
            "$task_id" "$WORKER_ID" "$content" 2>/dev/null)" \
        > /dev/null 2>&1 || true
    return 0
}

# =============================================================================
# Land-on-every-exit machinery (twin: moe-agent.ps1 -- same reason codes,
# banners, chat prefixes and settings keys; scripts/tests/parity-check.sh greps
# both wrappers for the shared vocabulary and fails on asymmetry).
#
# Vocabulary: ROOT = $PROJECT; TOP = repo toplevel; REL = `rev-parse
# --show-prefix` ('' when ROOT == TOP); GITDIR = --absolute-git-dir. EVERY git
# call runs `-C $MOE_TOP` and every path is handled TOP-relative: `status
# --porcelain` paths are always TOP-relative while add/ls-files/hash-object are
# cwd-relative, so mixing the two silently mis-stages under a sub-directory
# ROOT. Declared (ROOT-relative) paths are converted with REL + path. The
# per-task baseline lives at GITDIR/moe/baseline/<taskId>.tsv, the landing temp
# index at GITDIR/moe/idx-<taskId>-<pid>.
#
# Every `VAR=$(git ...)` below carries `|| VAR=""`: under `set -e` a failing
# substitution in an assignment aborts the whole wrapper (measured on the old
# detached-HEAD `symbolic-ref` probe), and a wrapper that dies inside its
# post-flight strands the session's edits -- the very defect this fixes.
# GIT_INDEX_FILE is set per plumbing call only (a leaked export would make every
# later git call, including the CLI's, use the temp index).
# =============================================================================
MOE_TAB=$'\t'
MOE_ZERO_OID="0000000000000000000000000000000000000000"

# read_commit_settings -- one project.json read per iteration. Explicit-false
# semantics as today for autoCommit (opt-out); commitHooks is opt-in.
read_commit_settings() {
    CS_AUTO_COMMIT="true"
    CS_CHECKPOINT_COMMITS="true"
    CS_CHECKPOINT_PUSH="true"
    CS_COMMIT_BOARD_STATE="true"
    CS_COMMIT_HOOKS="false"
    CS_ATTR_UNDECLARED="solo"
    CS_ATTR_CONTESTED="commit"
    CS_ATTR_EXCLUDE=""
    CS_CONSOLIDATION_BRANCH=""
    local parsed
    parsed=$($PYTHON_CMD -c "
import json, os, sys
p = os.path.join(sys.argv[1], 'project.json')
def clean(s):
    return str(s).replace('\r', ' ').replace('\n', ' ').replace('\x1f', ' ').replace('\x1e', ' ')
try:
    d = json.load(open(p, encoding='utf-8'))
    s = d.get('settings') or {}
    if not isinstance(s, dict):
        s = {}
except Exception:
    s = {}
attr = s.get('attribution') if isinstance(s.get('attribution'), dict) else {}
def flag(key, default):
    v = s.get(key)
    if v is True:
        return 'true'
    if v is False:
        return 'false'
    return default
und = attr.get('undeclared')
und = und if und in ('solo', 'never', 'always') else 'solo'
con = attr.get('contested')
con = con if con in ('commit', 'skip') else 'commit'
exc = attr.get('exclude')
exc = [clean(e.strip()) for e in exc if isinstance(e, str) and e.strip()] if isinstance(exc, list) else []
cb = s.get('consolidationBranch')
cb = cb.strip() if isinstance(cb, str) and cb.strip() and '*' not in cb else ''
fields = [flag('autoCommit', 'true'), flag('checkpointCommits', 'true'), flag('checkpointPush', 'true'),
          flag('commitBoardState', 'true'), flag('commitHooks', 'false'), und, con, '\x1e'.join(exc), clean(cb)]
sys.stdout.write('\x1f'.join(fields) + '\x1f')
" "$MOE_DIR" 2>/dev/null) || parsed=""
    if [ -n "$parsed" ]; then
        { IFS= read -r -d $'\x1f' CS_AUTO_COMMIT
          IFS= read -r -d $'\x1f' CS_CHECKPOINT_COMMITS
          IFS= read -r -d $'\x1f' CS_CHECKPOINT_PUSH
          IFS= read -r -d $'\x1f' CS_COMMIT_BOARD_STATE
          IFS= read -r -d $'\x1f' CS_COMMIT_HOOKS
          IFS= read -r -d $'\x1f' CS_ATTR_UNDECLARED
          IFS= read -r -d $'\x1f' CS_ATTR_CONTESTED
          IFS= read -r -d $'\x1f' CS_ATTR_EXCLUDE
          IFS= read -r -d $'\x1f' CS_CONSOLIDATION_BRANCH
        } <<< "$parsed" 2>/dev/null || true
    fi
    CS_AUTO_COMMIT="${CS_AUTO_COMMIT:-true}"
    CS_CHECKPOINT_COMMITS="${CS_CHECKPOINT_COMMITS:-true}"
    CS_CHECKPOINT_PUSH="${CS_CHECKPOINT_PUSH:-true}"
    CS_COMMIT_BOARD_STATE="${CS_COMMIT_BOARD_STATE:-true}"
    CS_COMMIT_HOOKS="${CS_COMMIT_HOOKS:-false}"
    CS_ATTR_UNDECLARED="${CS_ATTR_UNDECLARED:-solo}"
    CS_ATTR_CONTESTED="${CS_ATTR_CONTESTED:-commit}"
    # MOE_ATTRIBUTION=declared: declared-only attribution for this run.
    if [ "${MOE_ATTRIBUTION:-}" = "declared" ]; then
        CS_ATTR_UNDECLARED="never"
    fi
    return 0
}

# git_top -- resolve TOP / REL / GITDIR for $PROJECT. Returns 1 when not a repo.
git_top() {
    MOE_TOP=""
    MOE_REL=""
    MOE_GITDIR=""
    local top rel gitdir
    top=$(git -C "$PROJECT" rev-parse --show-toplevel 2>/dev/null) || top=""
    [ -n "$top" ] || return 1
    rel=$(git -C "$PROJECT" rev-parse --show-prefix 2>/dev/null) || rel=""
    gitdir=$(git -C "$PROJECT" rev-parse --absolute-git-dir 2>/dev/null) || gitdir=""
    [ -n "$gitdir" ] || return 1
    MOE_TOP="$top"
    MOE_REL="$rel"
    MOE_GITDIR="$gitdir"
    return 0
}

# git_dirty_snapshot OUT -- `status --porcelain=v1 -z --untracked-files=all
# --no-renames` mapped to `<blob|D>\t<XY>\t<path>` lines (TOP-relative). Blobs
# come from ONE `hash-object --stdin-paths` (newline-separated: git has no -z
# for it), so a path carrying a newline/tab/CR is dropped with a WARN -- it
# can never be committed by this machinery, which is the safe direction.
# Returns 1 when `git status` itself fails: a failed status is NOT a clean
# tree, and masking it as an empty snapshot would mark the landing "nothing"
# (landed=1) and silently strand the session's real edits as inter-session
# foreign dirt at the next baseline merge -- callers must fail closed instead
# (MOE_COMMIT_FAILED_ATTRIBUTION, baseline kept), like the ps1 twin.
git_dirty_snapshot() {
    local out="$1"
    local work status_z paths_txt
    work="$(create_secure_temp)"
    status_z="$work/snapshot-status-$$.z"
    paths_txt="$work/snapshot-paths-$$.txt"
    : > "$out"
    if ! git -C "$MOE_TOP" status --porcelain=v1 -z --untracked-files=all --no-renames > "$status_z" 2>/dev/null; then
        rm -f "$status_z" "$paths_txt" 2>/dev/null || true
        return 1
    fi
    : > "$paths_txt"
    local -a present_paths=() present_xy=()
    local entry xy p n_present=0
    while IFS= read -r -d '' entry; do
        [ "${#entry}" -ge 4 ] || continue
        xy="${entry:0:2}"
        p="${entry:3}"
        case "$p" in
            *$'\n'*|*"$MOE_TAB"*|*$'\r'*)
                echo -e "${YELLOW}[WARN]${NC} [attribution] a dirty path contains a control character and cannot be represented -- it is never committed by the wrapper." >&2
                continue ;;
        esac
        # A nested repository / submodule shows as a directory: skip it.
        if [ -d "$MOE_TOP/$p" ] && [ ! -L "$MOE_TOP/$p" ]; then continue; fi
        if [ -e "$MOE_TOP/$p" ] || [ -L "$MOE_TOP/$p" ]; then
            present_paths+=("$p")
            present_xy+=("$xy")
            printf '%s\n' "$p" >> "$paths_txt"
            n_present=$((n_present + 1))
        else
            printf 'D\t%s\t%s\n' "$xy" "$p" >> "$out"
        fi
    done < "$status_z"
    if [ "$n_present" -gt 0 ]; then
        local hashes="" n_hashes=0 i=0 h
        hashes=$(git -C "$MOE_TOP" hash-object --stdin-paths < "$paths_txt" 2>/dev/null) || hashes=""
        if [ -n "$hashes" ]; then
            n_hashes=$(printf '%s\n' "$hashes" | wc -l | tr -d '[:space:]')
        fi
        if [ "${n_hashes:-0}" -eq "$n_present" ]; then
            while IFS= read -r h; do
                printf '%s\t%s\t%s\n' "$h" "${present_xy[$i]}" "${present_paths[$i]}" >> "$out"
                i=$((i + 1))
            done <<< "$hashes"
        else
            # Batch failed (an unreadable file?) -- hash one at a time; an
            # unhashable path gets '?' which always counts as changed.
            for ((i = 0; i < n_present; i++)); do
                h=$(git -C "$MOE_TOP" hash-object -- "${present_paths[$i]}" 2>/dev/null) || h=""
                [ -n "$h" ] || h="?"
                printf '%s\t%s\t%s\n' "$h" "${present_xy[$i]}" "${present_paths[$i]}" >> "$out"
            done
        fi
    fi
    rm -f "$status_z" "$paths_txt" 2>/dev/null || true
    return 0
}

# ---- baseline TSV: header + B/U rows ----------------------------------------
# `#moe-baseline v1 task=<id> at=<iso> head=<sha> landed=<0|1>` then
# `B\t<blob|D>\t<path>` rows (dirty state presumed foreign) and `U\t<blob>\t<path>`
# rows (the locally persisted unattributed set). `landed=1` marks a session that
# ended with a completed landing so the next pre-flight does not replay a
# recovery checkpoint for nothing; absent (a twin that does not write it) means
# "recover". Written .tmp + rename.
baseline_path() {
    printf '%s/moe/baseline/%s.tsv' "$MOE_GITDIR" "$1"
}

baseline_read() { # $1 taskId, $2 out B rows (blob\tpath), $3 out U rows; 1 = none
    local f line
    f="$(baseline_path "$1")"
    : > "$2"
    : > "$3"
    [ -f "$f" ] || return 1
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            B"$MOE_TAB"*) printf '%s\n' "${line#B$MOE_TAB}" >> "$2" ;;
            U"$MOE_TAB"*) printf '%s\n' "${line#U$MOE_TAB}" >> "$3" ;;
        esac
    done < "$f"
    return 0
}

baseline_landed() { # $1 taskId -- 0 when the header says landed=1
    local f
    f="$(baseline_path "$1")"
    [ -f "$f" ] || return 1
    head -n1 "$f" 2>/dev/null | grep -q ' landed=1' 2>/dev/null
}

baseline_write() { # $1 taskId, $2 head, $3 B rows file, $4 U rows file, $5 landed(0|1)
    local dir="$MOE_GITDIR/moe/baseline" line
    mkdir -p "$dir" 2>/dev/null || return 1
    local f="$dir/$1.tsv" tmp="$dir/$1.tsv.tmp.$$"
    {
        printf '#moe-baseline v1 task=%s at=%s head=%s landed=%s\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$2" "${5:-0}"
        if [ -f "$3" ]; then
            while IFS= read -r line || [ -n "$line" ]; do
                [ -n "$line" ] && printf 'B\t%s\n' "$line"
            done < "$3"
        fi
        if [ -f "$4" ]; then
            while IFS= read -r line || [ -n "$line" ]; do
                [ -n "$line" ] && printf 'U\t%s\n' "$line"
            done < "$4"
        fi
        :
    } > "$tmp" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; return 1; }
    mv -f "$tmp" "$f" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; return 1; }
    return 0
}

baseline_delete() {
    [ -n "${MOE_GITDIR:-}" ] || return 0
    rm -f "$(baseline_path "$1")" 2>/dev/null || true
    return 0
}

# baseline_mark_landed TASKID -- flip the header's landed flag in place.
# Caller: the post-flight's deliberate LANDING_MODE=none exit (checkpoint
# commits off / a role with no landing), so the next pre-flight does not
# replay a "recovered" checkpoint the operator turned off.
baseline_mark_landed() {
    local f work b u head
    f="$(baseline_path "$1")"
    [ -f "$f" ] || return 0
    work="$(create_secure_temp)"
    baseline_read "$1" "$work/bl-b-$$.tsv" "$work/bl-u-$$.tsv" || true
    head=$(head -n1 "$f" 2>/dev/null | sed -n 's/.* head=\([^ ]*\).*/\1/p') || head=""
    baseline_write "$1" "$head" "$work/bl-b-$$.tsv" "$work/bl-u-$$.tsv" 1 || true
    rm -f "$work/bl-b-$$.tsv" "$work/bl-u-$$.tsv" 2>/dev/null || true
    return 0
}

# commit_scope PHASE TASKID OUT -- moe.get_commit_scope, with the disk fallback
# (own record + every other .moe/tasks/*.json; policy forced undeclared=never,
# peersActive=true) when the daemon cannot answer. Sets MOE_SCOPE_FALLBACK.
commit_scope() {
    local phase="$1" task_id="$2" out="$3" args="" resp=""
    MOE_SCOPE_FALLBACK=0
    args=$($PYTHON_CMD -c "
import json, sys
d = {'taskId': sys.argv[1], 'workerId': sys.argv[2], 'phase': sys.argv[3]}
if sys.argv[4]:
    d['sessionId'] = sys.argv[4]
if sys.argv[5]:
    d['since'] = sys.argv[5]
print(json.dumps(d))
" "$task_id" "$WORKER_ID" "$phase" "${MOE_SID:-}" "${MOE_PREFLIGHT_ISO:-}" 2>/dev/null) || args=""
    if [ -n "$args" ]; then
        resp=$(moe_rpc get_commit_scope "$args" 2>/dev/null) || resp=""
    fi
    if [ -n "$resp" ] && $PYTHON_CMD -c "
import json, sys
d = json.loads(sys.stdin.read())
sys.exit(0 if isinstance(d, dict) and d.get('taskId') else 1)
" <<< "$resp" 2>/dev/null; then
        printf '%s' "$resp" > "$out"
        return 0
    fi
    MOE_SCOPE_FALLBACK=1
    if ! $PYTHON_CMD - "$PROJECT" "$task_id" > "$out" 2>/dev/null <<'PYEOF'
import glob, json, os, re, sys
project, task_id = sys.argv[1], sys.argv[2]
tasks_dir = os.path.join(project, '.moe', 'tasks')
CI = sys.platform in ('win32', 'darwin')
def norm(raw):
    if not isinstance(raw, str):
        return None
    p = raw.strip()
    if not p or len(p) > 500:
        return None
    p = p.replace('\\', '/')
    if p.startswith('./'):
        p = p[2:]
    if p.startswith('/') or re.match(r'^[A-Za-z]:/', p):
        return None
    if any(seg == '..' for seg in p.split('/')):
        return None
    return p
def key(p):
    return p.lower() if CI else p
class PS:
    def __init__(self):
        self.m = {}
    def add(self, raw):
        n = norm(raw)
        if n is None:
            return None
        k = key(n)
        if k in self.m:
            return self.m[k]
        self.m[k] = n
        return n
    def addall(self, xs):
        if isinstance(xs, list):
            for x in xs:
                self.add(x)
        return self
    def has(self, p):
        n = norm(p)
        return n is not None and key(n) in self.m
    def values(self):
        return list(self.m.values())
def steps(t):
    s = t.get('implementationPlan')
    return s if isinstance(s, list) else []
def tiers(t):
    a = PS()
    for s in steps(t):
        if isinstance(s, dict) and s.get('status') == 'COMPLETED':
            a.addall(s.get('modifiedFiles') or s.get('affectedFiles') or [])
    a.addall(t.get('filesModified')).addall(t.get('declaredFiles')).addall(t.get('touchedFiles'))
    for c in (t.get('commits') or []):
        if not isinstance(c, dict):
            continue
        inf = PS().addall(c.get('inferredPaths'))
        for p in (c.get('paths') or []):
            n = norm(p)
            if n is None or inf.has(n):
                continue
            a.add(n)
    pl = PS()
    for s in steps(t):
        if not isinstance(s, dict):
            continue
        for raw in list(s.get('affectedFiles') or []) + list(s.get('newFiles') or []) + list(s.get('modifiedFiles') or []):
            n = norm(raw)
            if n is None or a.has(n):
                continue
            pl.add(n)
    for raw in (t.get('inferredPaths') or []):
        n = norm(raw)
        if n is None or a.has(n):
            continue
        pl.add(n)
    return a.values(), pl.values()
def load(path):
    try:
        with open(path, encoding='utf-8') as fh:
            d = json.load(fh)
        return d if isinstance(d, dict) else None
    except Exception:
        return None
own = None
for cand in (os.path.join(tasks_dir, task_id + '.json'), os.path.join(tasks_dir, 'task-' + task_id + '.json')):
    own = load(cand)
    if own is not None:
        break
out = {'taskId': task_id, 'fallback': True}
always = []
if own is None:
    out['notFound'] = True
    out.update(title='', status='', asserted=[], planned=[], touchedFiles=[], inferredPaths=[], unattributedPaths=[])
else:
    a, pl = tiers(own)
    out.update(title=own.get('title') or '', status=own.get('status') or '', epicId=own.get('epicId'),
               reopenCount=own.get('reopenCount') or 0, assignedWorkerId=own.get('assignedWorkerId'),
               asserted=a, planned=pl,
               touchedFiles=PS().addall(own.get('touchedFiles')).values(),
               inferredPaths=PS().addall(own.get('inferredPaths')).values(),
               unattributedPaths=PS().addall(own.get('unattributedPaths')).values())
    always.append('.moe/tasks/' + task_id + '.json')
always.append('.moe/project.json')
for f in sorted(glob.glob(os.path.join(project, '.moe', 'epics', '*.json'))):
    always.append('.moe/epics/' + os.path.basename(f))
peer = []
seen = PS()
live = []
for f in sorted(glob.glob(os.path.join(tasks_dir, '*.json'))):
    t = load(f)
    if t is None or not t.get('id') or t.get('id') == task_id:
        continue
    if t.get('status') in ('DONE', 'ARCHIVED'):
        continue
    # Liveness is unknown without the daemon: every open task counts as a live
    # peer, so no other task record is ever a board candidate in fallback mode.
    live.append(t.get('id'))
    a2, p2 = tiers(t)
    for p in a2 + p2:
        if seen.has(p):
            continue
        seen.add(p)
        peer.append({'path': p, 'taskId': t.get('id')})
out.update(peerDeclared=peer, livePeerIds=live, activePeerIds=live, peersActive=True,
           alwaysInclude=always, excludePrefixes=[],
           policy={'undeclared': 'never', 'contested': 'commit'})
print(json.dumps(out))
PYEOF
    then
        printf '{"taskId":"%s","notFound":true,"fallback":true,"asserted":[],"planned":[],"peerDeclared":[],"livePeerIds":[],"peersActive":true,"alwaysInclude":[],"excludePrefixes":[],"policy":{"undeclared":"never","contested":"commit"}}' "$task_id" > "$out"
    fi
    return 0
}

# resolve_attribution MODE TASKID SNAPSHOT B_FILE U_FILE TOOL_FILE SCOPE_JSON OUT_DIR POLICY_OVERRIDE
# The exact tiered algorithm (see docs/CONFIGURATION.md "attribution"), in ONE
# python pass -- bash 3.2 has no associative arrays. Writes NUL-terminated
# records into OUT_DIR: candidates (reason\tblob\tpath), skipped (code\tpath),
# unattributed (blob\tpath), contested (peer\tpath), missing (path), plus a
# KEY=VALUE summary. Tiers: BOARD (own task record always; project.json /
# epics / non-live-peer records when changed) > DENY (.moe/**, .mcp.json,
# .codex/**, .gemini/**, .claude/agents/**, .claude/settings.local.json,
# untracked .serena/**, .worktrees/**, .moe-worktree*, attribution.exclude) >
# ASSERTED ∪ TOOL ∪ own Serena memories (committed regardless of the baseline;
# CONTESTED when a peer declared them too) > PEER-declared (skipped) >
# PREEXISTING (dirty before the task and untouched: NEVER committed, the hard
# constraint) > PLANNED (plan-declared, changed since baseline) > MEASURED
# (undeclared, changed; policy 'always', or 'solo' with no active peer;
# inferred=true, never promoted) > UNATTRIBUTED (reported, never staged).
resolve_attribution() {
    local mode="$1" tid="$2" snap="$3" bfile="$4" ufile="$5" toolfile="$6" scopefile="$7" outdir="$8" override="${9:-}"
    mkdir -p "$outdir" 2>/dev/null || return 1
    MOE_LAND_UNDECLARED="$CS_ATTR_UNDECLARED" MOE_LAND_CONTESTED="$CS_ATTR_CONTESTED" MOE_LAND_EXCLUDE="$CS_ATTR_EXCLUDE" \
    MOE_LAND_BOARD_STATE="$CS_COMMIT_BOARD_STATE" MOE_LAND_POLICY_OVERRIDE="$override" \
    MOE_GIT_TOP="$MOE_TOP" MOE_GIT_REL="$MOE_REL" \
    $PYTHON_CMD - "$mode" "$tid" "$snap" "$bfile" "$ufile" "$toolfile" "$scopefile" "$outdir" 2>"$outdir/attr.err" <<'PYEOF'
import json, os, re, subprocess, sys
mode, task_id, snap_f, b_f, u_f, tool_f, scope_f, out_dir = sys.argv[1:9]
env = os.environ
top = (env.get('MOE_GIT_TOP') or '').replace('\\', '/').rstrip('/')
rel = env.get('MOE_GIT_REL') or ''
undeclared = env.get('MOE_LAND_UNDECLARED') or 'solo'
contested_policy = env.get('MOE_LAND_CONTESTED') or 'commit'
board_state = (env.get('MOE_LAND_BOARD_STATE') or 'true') == 'true'
override = env.get('MOE_LAND_POLICY_OVERRIDE') or ''
if override == 'never':
    undeclared = 'never'
exclude_extra = [e for e in (env.get('MOE_LAND_EXCLUDE') or '').split('\x1e') if e]
CI = sys.platform in ('win32', 'darwin')
def key(p):
    return p.lower() if CI else p
def norm_decl(raw):
    # ROOT-relative declared path -> TOP-relative; None when unusable.
    if not isinstance(raw, str):
        return None
    p = raw.strip().replace('\\', '/')
    if not p:
        return None
    while p.startswith('./'):
        p = p[2:]
    if p.startswith('/') or re.match(r'^[A-Za-z]:/', p):
        return None
    if any(seg == '..' for seg in p.split('/')):
        return None
    p = p.rstrip('/')
    return (rel + p) if p else None
def norm_top(raw):
    if not isinstance(raw, str):
        return None
    p = raw.replace('\\', '/')
    while p.startswith('./'):
        p = p[2:]
    return p or None
def read_rows(path):
    rows = []
    try:
        with open(path, encoding='utf-8', errors='surrogateescape') as fh:
            for line in fh:
                line = line.rstrip('\n').rstrip('\r')
                if line:
                    rows.append(line.split('\t'))
    except Exception:
        pass
    return rows
S = {}
for parts in read_rows(snap_f):
    if len(parts) < 3:
        continue
    p = norm_top('\t'.join(parts[2:]))
    if p:
        S[key(p)] = (p, parts[0], parts[1])
B = {}
for parts in read_rows(b_f):
    if len(parts) < 2:
        continue
    p = norm_top('\t'.join(parts[1:]))
    if p:
        B[key(p)] = parts[0]
TOOL = set()
try:
    with open(tool_f, encoding='utf-8', errors='surrogateescape') as fh:
        for line in fh:
            p = norm_top(line.rstrip('\n').rstrip('\r'))
            if p:
                TOOL.add(key(p))
except Exception:
    pass
try:
    with open(scope_f, encoding='utf-8') as fh:
        scope = json.load(fh)
    if not isinstance(scope, dict):
        scope = {}
except Exception:
    scope = {}
def decl_set(lst):
    out = {}
    if isinstance(lst, list):
        for raw in lst:
            n = norm_decl(raw)
            if n:
                out.setdefault(key(n), n)
    return out
ASSERTED = decl_set(scope.get('asserted'))
PLANNED = dict((k, v) for k, v in decl_set(scope.get('planned')).items() if k not in ASSERTED)
PEER = {}
for ent in (scope.get('peerDeclared') or []):
    if isinstance(ent, dict):
        n = norm_decl(ent.get('path'))
        if n:
            PEER.setdefault(key(n), str(ent.get('taskId') or ''))
peers_active = bool(scope.get('peersActive'))
if override == 'never' or scope.get('fallback'):
    peers_active = True
always_include = decl_set(scope.get('alwaysInclude'))
exclude_prefixes = [n for n in (norm_decl(e) for e in (scope.get('excludePrefixes') or []) if isinstance(e, str)) if n]
exclude_prefixes += [n for n in (norm_decl(e) for e in exclude_extra) if n]
MINE = set(ASSERTED) | TOOL
own_records = set()
for name in (task_id + '.json', 'task-' + task_id + '.json'):
    n = norm_decl('.moe/tasks/' + name)
    if n:
        own_records.add(key(n))
board_always = set(own_records) if board_state else set()
board_changed = set(k for k in always_include if k not in own_records) if board_state else set()
if board_state and not always_include:
    n = norm_decl('.moe/project.json')
    if n:
        board_changed.add(key(n))
roots = [key(rel)] + ([''] if rel else [])
def is_epic_record(pk):
    # THIS project's epics only (REL-prefixed): when the Moe project is nested
    # in a larger repo, an OUTER `.moe/epics/*.json` belongs to another fleet
    # and must fall through to denied() (bare root stays in `roots`), never
    # become this task's BOARD candidate.
    head = key(rel) + '.moe/epics/'
    return pk.startswith(head) and pk.endswith('.json') and '/' not in pk[len(head):]
def denied(p, xy):
    pk = key(p)
    for pre in roots:
        if pk.startswith(pre + '.moe/'):
            return True
        if pk == pre + '.mcp.json' or pk == pre + '.claude/settings.local.json':
            return True
        if pk.startswith(pre + '.codex/') or pk.startswith(pre + '.gemini/') or pk.startswith(pre + '.claude/agents/'):
            return True
        if pk.startswith(pre + '.serena/') and xy == '??':
            return True
        if pk.startswith(pre + '.worktrees/') or pk.startswith(pre + '.moe-worktree'):
            return True
    for ex in exclude_prefixes:
        ek = key(ex)
        if pk == ek or pk.startswith(ek.rstrip('/') + '/'):
            return True
    return False
def own_memory(p, xy):
    if xy == '??':
        return False
    pk = key(p)
    if '.serena/memories/' not in pk:
        return False
    return key(task_id) in pk.rsplit('/', 1)[-1]
def changed(pk, blob):
    if pk not in B:
        return True
    return blob == '?' or B[pk] != blob
cands, skipped, unattributed, contested, missing = [], [], [], [], []
n_pre = n_exc = n_inf = 0
for pk in sorted(S):
    p, blob, xy = S[pk]
    if pk in board_always:
        cands.append(('BOARD', blob, p))
        continue
    if pk in board_changed or (board_state and is_epic_record(pk)):
        if changed(pk, blob):
            cands.append(('BOARD', blob, p))
        else:
            skipped.append(('MOE_ATTR_EXCLUDED', p))
            n_exc += 1
        continue
    if denied(p, xy):
        skipped.append(('MOE_ATTR_EXCLUDED', p))
        n_exc += 1
        continue
    if pk in MINE or own_memory(p, xy):
        if pk in PEER:
            contested.append((PEER[pk], p))
            if contested_policy == 'skip':
                skipped.append(('MOE_ATTR_CONTESTED', p))
                continue
        cands.append(('ASSERTED', blob, p))
        continue
    if pk in PEER:
        skipped.append(('MOE_ATTR_PEER_DECLARED(%s)' % PEER[pk], p))
        continue
    if not changed(pk, blob):
        skipped.append(('MOE_ATTR_PREEXISTING', p))
        n_pre += 1
        continue
    if pk in PLANNED:
        cands.append(('PLANNED', blob, p))
        continue
    if undeclared == 'always' or (undeclared == 'solo' and not peers_active):
        cands.append(('MEASURED', blob, p))
        n_inf += 1
        continue
    unattributed.append((blob, p))
all_missing = 1 if ASSERTED else 0
for ak, ap in ASSERTED.items():
    if ak in S:
        all_missing = 0
        continue
    full = (top + '/' + ap) if top else ap
    if os.path.lexists(full):
        all_missing = 0
        continue
    in_head = False
    try:
        r = subprocess.run(['git', '-C', top, 'cat-file', '-e', 'HEAD:' + ap], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        in_head = (r.returncode == 0)
    except Exception:
        in_head = False
    if in_head:
        all_missing = 0
        continue
    missing.append(ap)
def write_recs(name, recs):
    with open(os.path.join(out_dir, name), 'w', encoding='utf-8', errors='surrogateescape', newline='') as fh:
        for rec in recs:
            fh.write('\t'.join(rec) + '\0')
write_recs('candidates', cands)
write_recs('skipped', skipped)
write_recs('unattributed', unattributed)
write_recs('contested', contested)
write_recs('missing', [(m,) for m in missing])
declared = set(ASSERTED) | set(PLANNED)
with open(os.path.join(out_dir, 'summary'), 'w', newline='') as fh:
    fh.write('N_CANDIDATES=%d\nN_INFERRED=%d\nN_SKIPPED=%d\nN_UNATTRIBUTED=%d\nN_MISSING=%d\nN_PREEXISTING=%d\nN_EXCLUDED=%d\nN_DECLARED=%d\nN_ASSERTED=%d\nALL_ASSERTED_MISSING=%d\nN_TOOL=%d\nN_CONTESTED=%d\nPEERS_ACTIVE=%d\n' % (
        len(cands), n_inf, len(skipped), len(unattributed), len(missing), n_pre, n_exc, len(declared), len(ASSERTED), all_missing, len(TOOL), len(contested), 1 if peers_active else 0))
PYEOF
}

# attr_summary_load DIR -- read the summary into ATTR_* globals.
attr_summary_load() {
    ATTR_N_CANDIDATES=0; ATTR_N_INFERRED=0; ATTR_N_SKIPPED=0; ATTR_N_UNATTRIBUTED=0; ATTR_N_MISSING=0
    ATTR_N_PREEXISTING=0; ATTR_N_EXCLUDED=0; ATTR_N_DECLARED=0; ATTR_N_ASSERTED=0; ATTR_ALL_ASSERTED_MISSING=0
    ATTR_N_TOOL=0; ATTR_N_CONTESTED=0; ATTR_PEERS_ACTIVE=0
    [ -f "$1/summary" ] || return 1
    local k v
    while IFS='=' read -r k v; do
        v="${v%$''}"
        case "$k" in
            N_CANDIDATES) ATTR_N_CANDIDATES="$v" ;;
            N_INFERRED) ATTR_N_INFERRED="$v" ;;
            N_SKIPPED) ATTR_N_SKIPPED="$v" ;;
            N_UNATTRIBUTED) ATTR_N_UNATTRIBUTED="$v" ;;
            N_MISSING) ATTR_N_MISSING="$v" ;;
            N_PREEXISTING) ATTR_N_PREEXISTING="$v" ;;
            N_EXCLUDED) ATTR_N_EXCLUDED="$v" ;;
            N_DECLARED) ATTR_N_DECLARED="$v" ;;
            N_ASSERTED) ATTR_N_ASSERTED="$v" ;;
            ALL_ASSERTED_MISSING) ATTR_ALL_ASSERTED_MISSING="$v" ;;
            N_TOOL) ATTR_N_TOOL="$v" ;;
            N_CONTESTED) ATTR_N_CONTESTED="$v" ;;
            PEERS_ACTIVE) ATTR_PEERS_ACTIVE="$v" ;;
        esac
    done < "$1/summary"
    return 0
}

# attr_print_skips DIR -- `[skip] <path> <code>` per dropped path (EXCLUDED
# runtime paths are summarised, PREEXISTING capped at 20 -- a busy shared
# checkout carries hundreds).
attr_print_skips() {
    local rec code p n_pre=0
    while IFS= read -r -d '' rec; do
        code="${rec%%"$MOE_TAB"*}"
        p="${rec#*"$MOE_TAB"}"
        [ "$code" = "MOE_ATTR_EXCLUDED" ] && continue
        if [ "$code" = "MOE_ATTR_PREEXISTING" ]; then
            n_pre=$((n_pre + 1))
            [ "$n_pre" -le 20 ] || continue
        fi
        echo "[skip] $p $code"
    done < "$1/skipped"
    if [ "$n_pre" -gt 20 ]; then
        echo "[skip] ... $((n_pre - 20)) more MOE_ATTR_PREEXISTING path(s)"
    fi
    while IFS= read -r -d '' rec; do
        echo "[skip] $rec MOE_ATTR_MISSING"
    done < "$1/missing"
    return 0
}

# ---- temp index --------------------------------------------------------------
# moe_temp_index_build BASE CAND_FILE STAGED_OUT DROPPED_OUT
# BASE = commit/tree to start from ('' = unborn -> empty index). Stages every
# candidate with `:(literal)` into GITDIR/moe/idx-<task>-<pid> (never the
# shared index), then verifies the staged blob equals the snapshot blob (or no
# entry for a deletion); a mismatch means the path moved under us and is
# dropped with MOE_ATTR_CONCURRENT (re-attempted next exit). Sets TI_INDEX,
# TI_N_STAGED, TI_N_INFERRED.
moe_temp_index_build() {
    local base="$1" cand="$2" staged_out="$3" dropped_out="$4"
    TI_INDEX="$MOE_GITDIR/moe/idx-${LAND_TASK_ID}-$$"
    TI_N_STAGED=0
    TI_N_INFERRED=0
    mkdir -p "$MOE_GITDIR/moe" 2>/dev/null || return 1
    rm -f "$TI_INDEX" 2>/dev/null || true
    : > "$staged_out"
    : > "$dropped_out"
    if [ -n "$base" ]; then
        GIT_INDEX_FILE="$TI_INDEX" git -C "$MOE_TOP" read-tree "$base" >/dev/null 2>&1 || return 1
    else
        GIT_INDEX_FILE="$TI_INDEX" git -C "$MOE_TOP" read-tree --empty >/dev/null 2>&1 || return 1
    fi
    local rec reason rest blob p actual
    while IFS= read -r -d '' rec; do
        reason="${rec%%"$MOE_TAB"*}"
        rest="${rec#*"$MOE_TAB"}"
        blob="${rest%%"$MOE_TAB"*}"
        p="${rest#*"$MOE_TAB"}"
        [ -n "$p" ] || continue
        if ! GIT_INDEX_FILE="$TI_INDEX" git -C "$MOE_TOP" add -- ":(literal)$p" >/dev/null 2>&1; then
            printf 'MOE_ATTR_MISSING\t%s\0' "$p" >> "$dropped_out"
            continue
        fi
        actual=$(GIT_INDEX_FILE="$TI_INDEX" git -C "$MOE_TOP" ls-files -s -- ":(literal)$p" 2>/dev/null | head -n1 | awk '{print $2}') || actual=""
        if { [ "$blob" = "D" ] && [ -n "$actual" ]; } || { [ "$blob" != "D" ] && [ "$actual" != "$blob" ]; }; then
            if [ -n "$base" ]; then
                GIT_INDEX_FILE="$TI_INDEX" git -C "$MOE_TOP" reset -q "$base" -- ":(literal)$p" >/dev/null 2>&1 || true
            else
                GIT_INDEX_FILE="$TI_INDEX" git -C "$MOE_TOP" rm -q --cached -- ":(literal)$p" >/dev/null 2>&1 || true
            fi
            printf 'MOE_ATTR_CONCURRENT\t%s\0' "$p" >> "$dropped_out"
            continue
        fi
        printf '%s\t%s\t%s\0' "$reason" "$blob" "$p" >> "$staged_out"
        TI_N_STAGED=$((TI_N_STAGED + 1))
        [ "$reason" = "MEASURED" ] && TI_N_INFERRED=$((TI_N_INFERRED + 1))
    done < "$cand"
    return 0
}

# moe_temp_index_has_changes BASE -- 0 when the temp index differs from BASE
# (unborn: any entry counts).
moe_temp_index_has_changes() {
    local base="$1"
    if [ -n "$base" ]; then
        if GIT_INDEX_FILE="$TI_INDEX" git -C "$MOE_TOP" diff-index --cached --quiet "$base" >/dev/null 2>&1; then
            return 1
        fi
        return 0
    fi
    local first
    first=$(GIT_INDEX_FILE="$TI_INDEX" git -C "$MOE_TOP" ls-files -z 2>/dev/null | head -c 1) || first=""
    [ -n "$first" ]
}

moe_temp_index_drop() {
    [ -n "${TI_INDEX:-}" ] && rm -f "$TI_INDEX" 2>/dev/null
    TI_INDEX=""
    return 0
}

# index_refresh STAGED_FILE -- after a plumbing landing, make the SHARED index
# agree with HEAD for exactly the landed paths (`git reset -q -- <specs>`) so
# `git status` is clean for them while peers' pre-staged entries survive.
# 5 x 2 s retry on index.lock; the commit already exists either way.
index_refresh() {
    local -a specs=()
    local rec p i out=""
    while IFS= read -r -d '' rec; do
        p="${rec##*"$MOE_TAB"}"
        [ -n "$p" ] && specs+=(":(literal)$p")
    done < "$1"
    [ "${#specs[@]}" -gt 0 ] || return 0
    for i in 1 2 3 4 5; do
        if out=$(git -C "$MOE_TOP" reset -q -- "${specs[@]}" 2>&1); then
            return 0
        fi
        case "$out" in
            *index.lock*) sleep 2 ;;
            *) break ;;
        esac
    done
    echo -e "${YELLOW}[WARN]${NC} MOE_COMMIT_INDEX_REFRESH_FAILED: the commit exists but the shared index could not be refreshed for the landed paths ($(printf '%s' "$out" | tail -n1))."
    return 1
}

# ---- branch safety -----------------------------------------------------------
peel_target_branch() {
    if [ -n "${CS_CONSOLIDATION_BRANCH:-}" ]; then
        printf '%s' "$CS_CONSOLIDATION_BRANCH"
    else
        printf 'moe/work-%s' "$(date +%Y-%m-%d)"
    fi
}

current_branch_name() {
    local b
    b=$(git -C "$MOE_TOP" symbolic-ref --short -q HEAD 2>/dev/null) || b=""
    if [ -z "$b" ]; then
        b=$(git -C "$MOE_TOP" rev-parse --abbrev-ref HEAD 2>/dev/null) || b=""
    fi
    printf '%s' "$b"
}

# ensure_safe_branch -- never commit on main/master/detached/unborn: peel onto
# the literal settings.consolidationBranch (no `*`) else moe/work-<date>
# (local, then origin/, then create). Existing non-default branches are reused
# as-is (not branch-per-task). Sets MOE_SHARED_BRANCH; returns 1 on failure.
# symbolic-ref returns the name on an unborn branch and FAILS on a detached
# HEAD; rev-parse is the fallback but returns the literal "HEAD" for both, so
# detached ("HEAD" / '') and main/master are all unsafe.
ensure_safe_branch() {
    MOE_SHARED_BRANCH=""
    local current target
    current="$(current_branch_name)"
    if [ "$current" = "main" ] || [ "$current" = "master" ] || [ "$current" = "HEAD" ] || [ -z "$current" ]; then
        target="$(peel_target_branch)"
        echo -e "${YELLOW}[branch]${NC} on ${current:-detached/unborn}; switching to $target so we don't commit to the default branch."
        if git -C "$MOE_TOP" rev-parse --verify --quiet "refs/heads/$target" > /dev/null 2>&1; then
            git -C "$MOE_TOP" checkout "$target" 2>&1 | tail -2
        elif git -C "$MOE_TOP" rev-parse --verify --quiet "refs/remotes/origin/$target" > /dev/null 2>&1; then
            git -C "$MOE_TOP" checkout -b "$target" "origin/$target" 2>&1 | tail -2
        else
            git -C "$MOE_TOP" checkout -b "$target" 2>&1 | tail -2
        fi
        current="$(current_branch_name)"
        if [ "$current" != "$target" ]; then
            echo -e "${YELLOW}[WARN]${NC} [branch] failed to switch off ${current:-detached/unborn} onto $target; refusing to commit to the default branch."
            return 1
        fi
    fi
    MOE_SHARED_BRANCH="$current"
    return 0
}

# ---- commit messages (grep-stable; identical in moe-agent.ps1) -----------------
# write_commit_message KIND OUT N_PATHS N_INFERRED
write_commit_message() {
    local kind="$1" out="$2" n_paths="${3:-0}" n_inferred="${4:-0}"
    local subject body contested_lines="" rec peer p
    while IFS= read -r -d '' rec; do
        peer="${rec%%"$MOE_TAB"*}"
        p="${rec#*"$MOE_TAB"}"
        contested_lines="$contested_lines
Moe-Contested: $p ($peer)"
    done < "$ATTR_DIR/contested"
    if [ "$kind" = "completion" ]; then
        local ctype="feat" suffix=""
        if [ "${LAND_REOPEN:-0}" -gt 0 ] 2>/dev/null; then
            ctype="fix"
            suffix=" (retry after qa_reject #$LAND_REOPEN)"
        fi
        subject="$ctype($LAND_TASK_ID): ${LAND_TITLE:-completed task}$suffix"
        body="Completed via Moe worker session."
    else
        local rec_suffix=""
        [ "${LAND_RECOVERED:-false}" = "true" ] && rec_suffix=" recovered"
        subject="wip($LAND_TASK_ID): ${LAND_TITLE:-checkpoint} [status=${LAND_STATUS:-UNKNOWN} role=$ROLE cli-exit=${LAND_CLI_EXIT:-0}]$rec_suffix"
        body="Checkpoint via Moe $ROLE session; not a completion."
    fi
    printf '%s\n\n%s\n\nMoe-Task: %s\nMoe-Kind: %s\nMoe-Session: %s\nMoe-Status: %s\nMoe-Paths: %s\nMoe-Inferred: %s%s\n' \
        "$subject" "$body" "$LAND_TASK_ID" "$kind" "$MOE_SID" "${LAND_STATUS:-UNKNOWN}" "$n_paths" "$n_inferred" "$contested_lines" > "$out"
}

write_rescue_message() { # $1 reason, $2 out
    printf 'rescue(%s): %s [reason=%s]\n\nRescue snapshot via Moe %s session; recover with git checkout <ref> -- <path>.\n\nMoe-Task: %s\nMoe-Kind: rescue\nMoe-Session: %s\nMoe-Reason: %s\n' \
        "$LAND_TASK_ID" "${LAND_TITLE:-rescue snapshot}" "$1" "$ROLE" "$LAND_TASK_ID" "$MOE_SID" "$1" > "$2"
}

# ---- landing -----------------------------------------------------------------
# land_commit KIND -- §7: branch (peel), then plumbing (temp index +
# commit-tree + update-ref CAS, 3 attempts) or, for a completion with
# settings.commitHooks=true, the porcelain `git commit -- <specs>` so hooks
# run. Returns 0 committed, 2 nothing, 1 failed (rescue attempted),
# 3 peel-failed (rescue attempted; caller must stop the loop).
land_commit() {
    local kind="$1" work
    work="$(create_secure_temp)"
    LAND_STAGED_FILE="$work/land-staged-$$.z"
    LAND_DROPPED_FILE="$work/land-dropped-$$.z"
    : > "$LAND_STAGED_FILE"
    : > "$LAND_DROPPED_FILE"
    LAND_SHA=""
    LAND_TREE=""
    LAND_BRANCH=""
    LAND_N_PATHS=0
    LAND_N_INFERRED=0
    if ! ensure_safe_branch; then
        LAND_OUTCOME="failed"
        LAND_CODE="MOE_COMMIT_FAILED_PEEL"
        rescue_ref "peel-failed" "$ATTR_DIR/candidates" || true
        return 3
    fi
    LAND_BRANCH="$MOE_SHARED_BRANCH"
    if [ "$kind" = "completion" ] && [ "$CS_COMMIT_HOOKS" = "true" ]; then
        land_porcelain "$work/land-msg-$$.txt"
        return $?
    fi
    land_plumbing "$work/land-msg-$$.txt"
    return $?
}

land_plumbing() {
    local msgfile="$1" ref="refs/heads/$LAND_BRANCH" attempt old="" tree="" new="" rc err
    err="$(create_secure_temp)/land-err-$$.txt"
    for attempt in 1 2 3; do
        old=$(git -C "$MOE_TOP" rev-parse -q --verify "$ref" 2>/dev/null) || old=""
        if ! moe_temp_index_build "$old" "$ATTR_DIR/candidates" "$LAND_STAGED_FILE" "$LAND_DROPPED_FILE"; then
            moe_temp_index_drop
            LAND_OUTCOME="failed"
            LAND_CODE="MOE_COMMIT_FAILED"
            echo -e "${YELLOW}[WARN]${NC} $LAND_CODE: could not build the landing index for task $LAND_TASK_ID."
            return 1
        fi
        if ! moe_temp_index_has_changes "$old"; then
            moe_temp_index_drop
            LAND_OUTCOME="nothing"
            return 2
        fi
        write_commit_message "$LAND_KIND" "$msgfile" "$TI_N_STAGED" "$TI_N_INFERRED"
        tree=$(GIT_INDEX_FILE="$TI_INDEX" git -C "$MOE_TOP" write-tree 2>"$err") || tree=""
        if [ -n "$tree" ]; then
            if [ -n "$old" ]; then
                new=$(git -C "$MOE_TOP" commit-tree "$tree" -p "$old" -F "$msgfile" 2>"$err") || new=""
            else
                new=$(git -C "$MOE_TOP" commit-tree "$tree" -F "$msgfile" 2>"$err") || new=""
            fi
        fi
        if [ -z "$new" ]; then
            moe_temp_index_drop
            LAND_OUTCOME="failed"
            LAND_CODE="MOE_COMMIT_FAILED"
            LAND_MESSAGE="$(tail -n3 "$err" 2>/dev/null | tr '\n' ' ')"
            echo -e "${YELLOW}[WARN]${NC} $LAND_CODE: git commit-tree failed for task $LAND_TASK_ID (identity? gpg?): $LAND_MESSAGE"
            rescue_ref "commit-failed" "$ATTR_DIR/candidates" || true
            return 1
        fi
        # Test seam: runs once, between commit-tree and update-ref, so a
        # harness can move the branch and prove the CAS retry rebuilds.
        if [ -n "${MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF:-}" ]; then
            local hook="$MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF"
            unset MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF
            (cd "$MOE_TOP" && bash -c "$hook") >/dev/null 2>&1 || true
        fi
        if [ -n "$old" ]; then
            if git -C "$MOE_TOP" update-ref "$ref" "$new" "$old" >/dev/null 2>&1; then rc=0; else rc=1; fi
        else
            if git -C "$MOE_TOP" update-ref "$ref" "$new" "$MOE_ZERO_OID" >/dev/null 2>&1; then rc=0; else rc=1; fi
        fi
        moe_temp_index_drop
        if [ "$rc" -eq 0 ]; then
            LAND_SHA="$new"
            LAND_TREE="$tree"
            LAND_OUTCOME="committed"
            LAND_N_PATHS="$TI_N_STAGED"
            LAND_N_INFERRED="$TI_N_INFERRED"
            index_refresh "$LAND_STAGED_FILE" || true
            return 0
        fi
        echo -e "${YELLOW}[branch]${NC} $ref moved while landing task $LAND_TASK_ID (attempt $attempt/3); rebuilding on the new tip."
    done
    LAND_OUTCOME="failed"
    LAND_CODE="MOE_COMMIT_FAILED_REF_CONTENTION"
    echo -e "${YELLOW}[WARN]${NC} $LAND_CODE: $ref kept moving; keeping the snapshot on a rescue ref."
    RESCUE_STAGED_FILE="${LAND_STAGED_FILE:-}"
    rescue_ref_from_commit "$new" "ref-contention" || true
    return 1
}

# land_porcelain MSGFILE -- settings.commitHooks=true completion path: today's
# `git add -- :(literal)p` into the shared index + `git commit -- <specs>`
# (hooks run). rc != 0 -> rescue [commit-failed].
land_porcelain() {
    local msgfile="$1" rec reason rest blob p actual out="" rc=1 i
    local -a specs=()
    while IFS= read -r -d '' rec; do
        reason="${rec%%"$MOE_TAB"*}"
        rest="${rec#*"$MOE_TAB"}"
        blob="${rest%%"$MOE_TAB"*}"
        p="${rest#*"$MOE_TAB"}"
        [ -n "$p" ] || continue
        if ! git -C "$MOE_TOP" add -- ":(literal)$p" >/dev/null 2>&1; then
            printf 'MOE_ATTR_MISSING\t%s\0' "$p" >> "$LAND_DROPPED_FILE"
            continue
        fi
        actual=$(git -C "$MOE_TOP" ls-files -s -- ":(literal)$p" 2>/dev/null | head -n1 | awk '{print $2}') || actual=""
        if { [ "$blob" = "D" ] && [ -n "$actual" ]; } || { [ "$blob" != "D" ] && [ "$actual" != "$blob" ]; }; then
            git -C "$MOE_TOP" reset -q -- ":(literal)$p" >/dev/null 2>&1 || true
            printf 'MOE_ATTR_CONCURRENT\t%s\0' "$p" >> "$LAND_DROPPED_FILE"
            continue
        fi
        printf '%s\t%s\t%s\0' "$reason" "$blob" "$p" >> "$LAND_STAGED_FILE"
        specs+=(":(literal)$p")
        TI_N_STAGED=$((${TI_N_STAGED:-0} + 1))
        [ "$reason" = "MEASURED" ] && TI_N_INFERRED=$((${TI_N_INFERRED:-0} + 1))
    done < "$ATTR_DIR/candidates"
    if [ "${#specs[@]}" -eq 0 ] || git -C "$MOE_TOP" diff --cached --quiet -- "${specs[@]}" >/dev/null 2>&1; then
        LAND_OUTCOME="nothing"
        return 2
    fi
    write_commit_message "$LAND_KIND" "$msgfile" "${#specs[@]}" "${TI_N_INFERRED:-0}"
    for i in 1 2 3 4 5; do
        if out=$(git -C "$MOE_TOP" commit -F "$msgfile" -- "${specs[@]}" 2>&1); then rc=0; else rc=$?; fi
        [ "$rc" -ne 0 ] || break
        case "$out" in
            *index.lock*) sleep 2 ;;
            *) break ;;
        esac
    done
    printf '%s\n' "$out" | tail -3
    if [ "$rc" -ne 0 ]; then
        LAND_OUTCOME="failed"
        LAND_CODE="MOE_COMMIT_FAILED"
        LAND_MESSAGE="$(printf '%s' "$out" | tail -n3 | tr '\n' ' ')"
        echo -e "${YELLOW}[WARN]${NC} $LAND_CODE: git commit failed (pre-commit hook? identity?) for task $LAND_TASK_ID; keeping the snapshot on a rescue ref."
        rescue_ref "commit-failed" "$ATTR_DIR/candidates" || true
        return 1
    fi
    LAND_SHA=$(git -C "$MOE_TOP" rev-parse HEAD 2>/dev/null) || LAND_SHA=""
    LAND_TREE=$(git -C "$MOE_TOP" rev-parse 'HEAD^{tree}' 2>/dev/null) || LAND_TREE=""
    LAND_OUTCOME="committed"
    LAND_N_PATHS="${#specs[@]}"
    LAND_N_INFERRED="${TI_N_INFERRED:-0}"
    return 0
}

# ---- rescue refs -------------------------------------------------------------
# rescue_ref REASON CAND_FILE -- park the candidate snapshot on
# refs/moe/rescue/<taskId>/<utc-ts> (tree built exactly like §7.2 against
# HEAD; commit-tree -p HEAD, no parent when unborn). HEAD, the branch and the
# shared index are untouched; never pushed. Announced via MOE_RESCUE_REF in
# #general and recorded daemon-side (kind rescue). Returns 1 when there was
# nothing to rescue or the ref could not be written.
rescue_ref() {
    local reason="$1" cand="$2" work head="" tree="" sha="" ts ref msgfile
    LAND_RESCUE_REF=""
    LAND_RESCUE_SHA=""
    RESCUE_STAGED_FILE=""
    if [ ! -s "$cand" ]; then
        echo -e "${BLUE}[rescue]${NC} nothing to rescue for task $LAND_TASK_ID (no candidate paths) [reason=$reason]"
        return 1
    fi
    work="$(create_secure_temp)"
    head=$(git -C "$MOE_TOP" rev-parse -q --verify HEAD 2>/dev/null) || head=""
    if ! moe_temp_index_build "$head" "$cand" "$work/rescue-staged-$$.z" "$work/rescue-dropped-$$.z"; then
        moe_temp_index_drop
        echo -e "${YELLOW}[WARN]${NC} [rescue] could not build the rescue index for task $LAND_TASK_ID [reason=$reason]"
        return 1
    fi
    if ! moe_temp_index_has_changes "$head"; then
        moe_temp_index_drop
        echo -e "${BLUE}[rescue]${NC} nothing to rescue for task $LAND_TASK_ID (candidates match HEAD) [reason=$reason]"
        return 1
    fi
    tree=$(GIT_INDEX_FILE="$TI_INDEX" git -C "$MOE_TOP" write-tree 2>/dev/null) || tree=""
    moe_temp_index_drop
    [ -n "$tree" ] || return 1
    msgfile="$work/rescue-msg-$$.txt"
    write_rescue_message "$reason" "$msgfile"
    if [ -n "$head" ]; then
        sha=$(git -C "$MOE_TOP" commit-tree "$tree" -p "$head" -F "$msgfile" 2>/dev/null) || sha=""
    else
        sha=$(git -C "$MOE_TOP" commit-tree "$tree" -F "$msgfile" 2>/dev/null) || sha=""
    fi
    if [ -z "$sha" ]; then
        echo -e "${YELLOW}[WARN]${NC} [rescue] commit-tree failed; the snapshot could not be parked [reason=$reason]"
        return 1
    fi
    RESCUE_STAGED_FILE="$work/rescue-staged-$$.z"
    rescue_ref_from_commit "$sha" "$reason"
}

# rescue_ref_from_commit SHA REASON -- point a fresh rescue ref at an existing
# commit (the CAS-exhausted `new` on ref-contention, or the tree just built).
rescue_ref_from_commit() {
    local sha="$1" reason="$2" ts ref
    [ -n "$sha" ] || return 1
    ts=$(date -u +%Y%m%dT%H%M%SZ)
    ref="refs/moe/rescue/$LAND_TASK_ID/$ts"
    if git -C "$MOE_TOP" rev-parse -q --verify "$ref" >/dev/null 2>&1; then
        ref="$ref-$$"
    fi
    if ! git -C "$MOE_TOP" update-ref "$ref" "$sha" >/dev/null 2>&1; then
        echo -e "${YELLOW}[WARN]${NC} [rescue] update-ref $ref failed [reason=$reason]"
        return 1
    fi
    LAND_RESCUE_REF="$ref"
    LAND_RESCUE_SHA="$sha"
    echo -e "${YELLOW}[rescue]${NC} MOE_RESCUE_REF task=$LAND_TASK_ID ref=$ref sha=$sha reason=$reason"
    if [ -n "${GENERAL_CHANNEL_ID:-}" ]; then
        moe_rpc chat_send \
            "$($PYTHON_CMD -c "import json,sys; print(json.dumps({'channel':sys.argv[1],'workerId':sys.argv[2],'content':sys.argv[3]}))" \
                "$GENERAL_CHANNEL_ID" "$WORKER_ID" "MOE_RESCUE_REF task=$LAND_TASK_ID ref=$ref sha=$sha reason=$reason" 2>/dev/null)" \
            > /dev/null 2>&1 || true
    fi
    # The rescued paths travel in the ledger entry (same as the ps1 twin), and
    # the MOE_RESCUE_REF line rides in `message` for the daemon's re-emission.
    record_commit_rpc "committed" "rescue" "$sha" "$ref" "$reason" \
        "MOE_RESCUE_REF task=$LAND_TASK_ID ref=$ref sha=$sha reason=$reason" "false" "${RESCUE_STAGED_FILE:-}" "" || true
    return 0
}

# ---- push --------------------------------------------------------------------
announce_checkpoint_unpushed() { # $1 taskId, $2 branch
    local msg="CHECKPOINT-UNPUSHED task=$1 -- checkpoint committed locally only on $2; push when the remote is reachable"
    echo -e "${YELLOW}[WARN]${NC} $msg"
    if [ -n "${GENERAL_CHANNEL_ID:-}" ]; then
        moe_rpc chat_send \
            "$($PYTHON_CMD -c "import json,sys; print(json.dumps({'channel':sys.argv[1],'workerId':sys.argv[2],'content':sys.argv[3]}))" \
                "$GENERAL_CHANNEL_ID" "$WORKER_ID" "$msg" 2>/dev/null)" \
            > /dev/null 2>&1 || true
    fi
    return 0
}

# push_branch KIND -- today's push (`-u` on first push, one `pull --rebase`
# retry, `rebase --abort` on conflict). Banners per kind: completion ->
# `PUSH FAILED ... do not review until pushed`; checkpoint ->
# `CHECKPOINT-UNPUSHED task=<id>`. Note `pull --rebase` refuses in a tree with
# unstaged tracked changes, so the retry usually fails in a busy fleet --
# unpushed is a visibility problem, not a loss. Returns 0 when pushed.
push_branch() {
    local kind="$1" branch="$LAND_BRANCH" tid="$LAND_TASK_ID" PUSH_OUT="" REBASE_OUT="" ok=false
    [ -n "$branch" ] || return 1
    if git -C "$MOE_TOP" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' > /dev/null 2>&1; then
        if PUSH_OUT=$(git -C "$MOE_TOP" push 2>&1); then
            ok=true
        else
            printf '%s\n' "$PUSH_OUT" | tail -5
            echo -e "${YELLOW}[WARN]${NC} git push failed; trying git pull --rebase then re-push..."
            if REBASE_OUT=$(git -C "$MOE_TOP" pull --rebase 2>&1); then
                printf '%s\n' "$REBASE_OUT" | tail -5
                if PUSH_OUT=$(git -C "$MOE_TOP" push 2>&1); then
                    ok=true
                else
                    printf '%s\n' "$PUSH_OUT" | tail -5
                    echo -e "${YELLOW}[WARN]${NC} git push still failing (auth? network? conflict?) -- resolve and push manually."
                fi
            else
                printf '%s\n' "$REBASE_OUT" | tail -5
                git -C "$MOE_TOP" rebase --abort 2>/dev/null || true
                echo -e "${YELLOW}[WARN]${NC} git pull --rebase failed (conflict? unstaged changes?); aborted rebase to restore a clean tree -- resolve and push manually."
            fi
        fi
    else
        if PUSH_OUT=$(git -C "$MOE_TOP" push -u origin "$branch" 2>&1); then
            ok=true
        else
            printf '%s\n' "$PUSH_OUT" | tail -5
            echo -e "${YELLOW}[WARN]${NC} git push failed; trying git pull --rebase then re-push..."
            if REBASE_OUT=$(git -C "$MOE_TOP" pull --rebase origin "$branch" 2>&1); then
                printf '%s\n' "$REBASE_OUT" | tail -5
                if PUSH_OUT=$(git -C "$MOE_TOP" push -u origin "$branch" 2>&1); then
                    ok=true
                else
                    printf '%s\n' "$PUSH_OUT" | tail -5
                    echo -e "${YELLOW}[WARN]${NC} git push still failing (auth? network? conflict?) -- resolve and push manually."
                fi
            else
                printf '%s\n' "$REBASE_OUT" | tail -5
                git -C "$MOE_TOP" rebase --abort 2>/dev/null || true
                echo -e "${YELLOW}[WARN]${NC} git pull --rebase failed (conflict? unstaged changes?); aborted rebase to restore a clean tree -- resolve and push manually."
            fi
        fi
    fi
    if [ "$ok" = true ]; then
        printf '%s\n' "$PUSH_OUT" | tail -5
        echo -e "${GREEN}[OK]${NC} Pushed task $tid to $branch."
        return 0
    fi
    if [ "$kind" = "completion" ]; then
        announce_push_failure "$tid"
    else
        announce_checkpoint_unpushed "$tid" "$branch"
    fi
    return 1
}

# ---- daemon ledger -----------------------------------------------------------
# record_commit_rpc OUTCOME KIND SHA REF CODE MESSAGE PUSHED STAGED_FILE DROPPED_FILE
# Best-effort moe.record_commit with every outcome; never breaks the loop.
# Paths go back ROOT-relative (REL stripped); lists are capped daemon-side too.
record_commit_rpc() {
    local args=""
    args=$(MOE_RC_TASK="$LAND_TASK_ID" MOE_RC_OUTCOME="$1" MOE_RC_KIND="$2" MOE_RC_SHA="${3:-}" MOE_RC_REF="${4:-}" \
           MOE_RC_CODE="${5:-}" MOE_RC_MSG="${6:-}" MOE_RC_PUSHED="${7:-}" MOE_RC_STAGED="${8:-}" MOE_RC_DROPPED="${9:-}" \
           MOE_RC_SKIPPED="${ATTR_DIR:-}/skipped" MOE_RC_UNATTR="${ATTR_DIR:-}/unattributed" MOE_RC_CONTESTED="${ATTR_DIR:-}/contested" \
           MOE_RC_TOOL="${LAND_TOOL_FILE_EFFECTIVE:-}" MOE_RC_STATUS="${LAND_STATUS:-}" MOE_RC_ROLE="$ROLE" MOE_RC_WORKER="$WORKER_ID" \
           MOE_RC_SID="${MOE_SID:-}" MOE_RC_CLI_EXIT="${LAND_CLI_EXIT:-}" MOE_RC_TREE="${LAND_TREE:-}" MOE_GIT_REL="${MOE_REL:-}" \
           $PYTHON_CMD - <<'PYEOF' 2>/dev/null
import json, os, sys
e = os.environ
rel = e.get('MOE_GIT_REL') or ''
CI = sys.platform in ('win32', 'darwin')
def root_rel(p):
    if rel and (p.lower() if CI else p).startswith(rel.lower() if CI else rel):
        return p[len(rel):]
    return p
def recs(path):
    out = []
    if not path:
        return out
    try:
        with open(path, encoding='utf-8', errors='surrogateescape') as fh:
            data = fh.read()
    except Exception:
        return out
    for rec in data.split('\0'):
        if rec:
            out.append(rec.split('\t'))
    return out
def lines(path):
    out = []
    if not path:
        return out
    try:
        with open(path, encoding='utf-8', errors='surrogateescape') as fh:
            for line in fh:
                line = line.rstrip('\n').rstrip('\r')
                if line:
                    out.append(line)
    except Exception:
        pass
    return out
def dedupe(items):
    seen, out = set(), []
    for p in items:
        k = p.lower() if CI else p
        if k in seen:
            continue
        seen.add(k)
        out.append(p)
    return out
d = {'taskId': e['MOE_RC_TASK'], 'outcome': e['MOE_RC_OUTCOME'], 'kind': e['MOE_RC_KIND'], 'role': e['MOE_RC_ROLE'] or 'worker',
     'sessionId': e.get('MOE_RC_SID') or (e['MOE_RC_WORKER'] + '@unknown')}
if e.get('MOE_RC_WORKER'):
    d['workerId'] = e['MOE_RC_WORKER']
for k, name in (('sha', 'MOE_RC_SHA'), ('ref', 'MOE_RC_REF'), ('code', 'MOE_RC_CODE'), ('status', 'MOE_RC_STATUS'), ('treeId', 'MOE_RC_TREE')):
    v = e.get(name)
    if v:
        d[k] = v
msg = e.get('MOE_RC_MSG')
if msg:
    d['message'] = msg[:2000]
if e.get('MOE_RC_PUSHED') in ('true', 'false'):
    d['pushed'] = (e['MOE_RC_PUSHED'] == 'true')
try:
    d['cliExitCode'] = int(e.get('MOE_RC_CLI_EXIT') or '')
except Exception:
    pass
staged = recs(e.get('MOE_RC_STAGED'))
paths = dedupe([root_rel('\t'.join(r[2:])) for r in staged if len(r) >= 3])
inferred = dedupe([root_rel('\t'.join(r[2:])) for r in staged if len(r) >= 3 and r[0] == 'MEASURED'])
if paths:
    d['paths'] = paths[:500]
if inferred:
    d['inferredPaths'] = inferred[:500]
touched = dedupe([root_rel(p) for p in lines(e.get('MOE_RC_TOOL'))])
if touched:
    d['touchedPaths'] = touched[:500]
# unattributedPaths REPLACES the stored set daemon-side and an explicit []
# clears it -- send it only when attribution actually RAN this pass (the file
# exists; resolve_attribution always writes it, even empty, on success). A
# record from a path where attribution never ran must OMIT the field so the
# daemon keeps the stored evidence -- same as the ps1 twin's failure records.
unattr_f = e.get('MOE_RC_UNATTR')
if unattr_f and os.path.exists(unattr_f):
    unattr = dedupe([root_rel('\t'.join(r[1:])) for r in recs(unattr_f) if len(r) >= 2])
    d['unattributedPaths'] = unattr[:500]
skipped = []
for r in recs(e.get('MOE_RC_SKIPPED')) + recs(e.get('MOE_RC_DROPPED')):
    if len(r) >= 2 and r[0] != 'MOE_ATTR_EXCLUDED':
        skipped.append({'path': root_rel('\t'.join(r[1:])), 'code': r[0]})
if skipped:
    d['skipped'] = skipped[:100]
contested = [{'path': root_rel('\t'.join(r[1:])), 'taskId': r[0]} for r in recs(e.get('MOE_RC_CONTESTED')) if len(r) >= 2]
if contested:
    d['contested'] = contested[:100]
print(json.dumps(d))
PYEOF
    ) || args=""
    [ -n "$args" ] || return 0
    moe_rpc record_commit "$args" >/dev/null 2>&1 || true
    return 0
}

# baseline_after_landing TASKID B_FILE U_SRC STAGED_FILE LANDED -- remove the
# landed paths from B, replace U with this pass's unattributed set, keep the
# file (it lives until the task is DONE/ARCHIVED), refresh head.
baseline_after_landing() {
    local tid="$1" bfile="$2" unattr="$3" staged="$4" landed="$5" work head
    work="$(create_secure_temp)"
    $PYTHON_CMD - "$bfile" "$staged" "$unattr" "$work/bl-next-b-$$.tsv" "$work/bl-next-u-$$.tsv" <<'PYEOF' 2>/dev/null || return 0
import sys
b_f, staged_f, unattr_f, out_b, out_u = sys.argv[1:6]
CI = sys.platform in ('win32', 'darwin')
def key(p):
    return p.lower() if CI else p
landed = set()
try:
    with open(staged_f, encoding='utf-8', errors='surrogateescape') as fh:
        for rec in fh.read().split('\0'):
            parts = rec.split('\t')
            if len(parts) >= 3:
                landed.add(key('\t'.join(parts[2:])))
except Exception:
    pass
with open(out_b, 'w', encoding='utf-8', errors='surrogateescape', newline='') as out:
    try:
        with open(b_f, encoding='utf-8', errors='surrogateescape') as fh:
            for line in fh:
                line = line.rstrip('\n').rstrip('\r')
                parts = line.split('\t')
                if len(parts) < 2:
                    continue
                if key('\t'.join(parts[1:])) in landed:
                    continue
                out.write(line + '\n')
    except Exception:
        pass
with open(out_u, 'w', encoding='utf-8', errors='surrogateescape', newline='') as out:
    try:
        with open(unattr_f, encoding='utf-8', errors='surrogateescape') as fh:
            for rec in fh.read().split('\0'):
                parts = rec.split('\t')
                if len(parts) >= 2:
                    out.write(parts[0] + '\t' + '\t'.join(parts[1:]) + '\n')
    except Exception:
        pass
PYEOF
    head=$(git -C "$MOE_TOP" rev-parse -q --verify HEAD 2>/dev/null) || head=""
    baseline_write "$tid" "$head" "$work/bl-next-b-$$.tsv" "$work/bl-next-u-$$.tsv" "$landed" || true
    rm -f "$work/bl-next-b-$$.tsv" "$work/bl-next-u-$$.tsv" 2>/dev/null || true
    return 0
}

# ---- the landing driver ------------------------------------------------------
# run_landing -- inputs via LAND_* globals:
#   LAND_KIND completion|checkpoint, LAND_TASK_ID, LAND_TITLE, LAND_STATUS,
#   LAND_REOPEN, LAND_CLI_EXIT, LAND_RECOVERED, LAND_GATE_FAILED,
#   LAND_POLICY_OVERRIDE ('' | never), LAND_SNAPSHOT_FILE ('' = take one now),
#   LAND_TOOL_FILE ('' = none), LAND_SCOPE_FILE ('' = fetch postflight scope).
# Outputs: LAND_OUTCOME committed|nothing|refused|failed, LAND_SHA, LAND_CODE,
#   LAND_BRANCH, LAND_PUSHED, LAND_N_PATHS, LAND_N_INFERRED, LAND_RESCUE_REF,
#   LAND_SUMMARY_* for the session-ended chat line.
# Returns 0 (committed/nothing/refused), 1 failed, 3 peel-failed (stop the
# loop), 4 gate-failed (stop the loop). Sets MOE_LANDING_DONE on every path so
# the teardown rescue never double-parks a session that already landed.
run_landing() {
    local work rc=0 snap tool head_before head_after n_skipped
    work="$(create_secure_temp)/landing-$$"
    rm -rf "$work" 2>/dev/null || true
    mkdir -p "$work"
    ATTR_DIR="$work/attr"
    mkdir -p "$ATTR_DIR"
    LAND_OUTCOME="failed"; LAND_SHA=""; LAND_TREE=""; LAND_CODE=""; LAND_MESSAGE=""; LAND_BRANCH=""; LAND_PUSHED=""
    LAND_N_PATHS=0; LAND_N_INFERRED=0; LAND_RESCUE_REF=""; LAND_STAGED_FILE=""; LAND_DROPPED_FILE=""
    TI_N_STAGED=0; TI_N_INFERRED=0
    local policy_override="${LAND_POLICY_OVERRIDE:-}"
    if [ -z "${LAND_SCOPE_FILE:-}" ] || [ ! -f "$LAND_SCOPE_FILE" ]; then
        commit_scope postflight "$LAND_TASK_ID" "$work/scope.json"
        LAND_SCOPE_FILE="$work/scope.json"
    fi
    if [ "${MOE_SCOPE_FALLBACK:-0}" = "1" ]; then
        policy_override="never"
        echo -e "${YELLOW}[attribution]${NC} moe.get_commit_scope unavailable -- disk fallback (declared-only, peers assumed active)."
    fi
    if ! baseline_read "$LAND_TASK_ID" "$work/B.tsv" "$work/U.tsv"; then
        # Fail CLOSED on missing evidence: with no readable baseline every
        # pre-session dirty path would read as "changed since baseline" and the
        # MEASURED tier would sweep foreign debris into this task's commit. The
        # policy is forced to 'never' for this landing (undeclared paths are
        # reported, never committed); ASSERTED/TOOL/PLANNED/BOARD still land.
        policy_override="never"
        echo -e "${YELLOW}[attribution]${NC} no readable baseline for task $LAND_TASK_ID -- measured attribution disabled for this landing (undeclared paths are reported, never committed)."
    fi
    snap="${LAND_SNAPSHOT_FILE:-}"
    if [ -z "$snap" ] || [ ! -f "$snap" ]; then
        snap="$work/S.tsv"
        if ! git_dirty_snapshot "$snap"; then
            LAND_CODE="MOE_COMMIT_FAILED_ATTRIBUTION"
            echo -e "${YELLOW}[WARN]${NC} git status failed; cannot attribute the working tree for task $LAND_TASK_ID -- nothing committed, baseline kept."
            record_commit_rpc "failed" "$LAND_KIND" "" "" "$LAND_CODE" "" "" "" "" || true
            MOE_LANDING_DONE=true
            LAND_SUMMARY_SHA="none"; LAND_SUMMARY_KIND="$LAND_KIND"; LAND_SUMMARY_PATHS=0; LAND_SUMMARY_INFERRED=0; LAND_SUMMARY_UNATTR=0
            LAND_SUMMARY_OUTCOME="failed"; LAND_SUMMARY_CODE="$LAND_CODE"
            return 1
        fi
    fi
    tool="${LAND_TOOL_FILE:-}"
    if [ -z "$tool" ] || [ ! -f "$tool" ]; then
        tool="$work/tool.txt"
        : > "$tool"
    fi
    LAND_TOOL_FILE_EFFECTIVE="$tool"
    if ! resolve_attribution "$LAND_KIND" "$LAND_TASK_ID" "$snap" "$work/B.tsv" "$work/U.tsv" "$tool" "$LAND_SCOPE_FILE" "$ATTR_DIR" "$policy_override" \
        || ! attr_summary_load "$ATTR_DIR"; then
        LAND_CODE="MOE_COMMIT_FAILED_ATTRIBUTION"
        echo -e "${YELLOW}[WARN]${NC} $LAND_CODE: attribution failed for task $LAND_TASK_ID ($(tail -n1 "$ATTR_DIR/attr.err" 2>/dev/null)); nothing committed, baseline kept."
        record_commit_rpc "failed" "$LAND_KIND" "" "" "$LAND_CODE" "" "" "" "" || true
        MOE_LANDING_DONE=true
        LAND_SUMMARY_SHA="none"; LAND_SUMMARY_KIND="$LAND_KIND"; LAND_SUMMARY_PATHS=0; LAND_SUMMARY_INFERRED=0; LAND_SUMMARY_UNATTR=0
        LAND_SUMMARY_OUTCOME="failed"; LAND_SUMMARY_CODE="$LAND_CODE"
        return 1
    fi
    attr_print_skips "$ATTR_DIR"
    if [ "${ATTR_N_PREEXISTING:-0}" -gt 0 ]; then
        echo -e "${BLUE}[attribution]${NC} $ATTR_N_PREEXISTING pre-session dirty path(s) untouched"
    fi
    if [ "${ATTR_N_EXCLUDED:-0}" -gt 0 ]; then
        echo -e "${BLUE}[attribution]${NC} $ATTR_N_EXCLUDED excluded path(s) untouched (MOE_ATTR_EXCLUDED: .moe/, tool config, worktrees)"
    fi

    if [ "${LAND_GATE_FAILED:-false}" = "true" ]; then
        LAND_OUTCOME="failed"
        LAND_CODE="MOE_COMMIT_FAILED_GATE"
        rescue_ref "gate-failed" "$ATTR_DIR/candidates" || true
        record_commit_rpc "failed" "$LAND_KIND" "" "" "$LAND_CODE" "qualityGate failed" "" "" "" || true
        MOE_LANDING_DONE=true
        # Summary convention (same as the ps1 twin): kind = the ATTEMPTED
        # landing kind, sha = the rescue sha when one was parked.
        LAND_SUMMARY_SHA="${LAND_RESCUE_SHA:-none}"
        [ -n "$LAND_SUMMARY_SHA" ] || LAND_SUMMARY_SHA="none"
        LAND_SUMMARY_KIND="$LAND_KIND"; LAND_SUMMARY_PATHS=0; LAND_SUMMARY_INFERRED=0; LAND_SUMMARY_UNATTR="${ATTR_N_UNATTRIBUTED:-0}"
        LAND_SUMMARY_OUTCOME="failed"; LAND_SUMMARY_CODE="$LAND_CODE"
        return 4
    fi

    if [ "${ATTR_N_CANDIDATES:-0}" -gt 0 ]; then
        head_before=$(git -C "$MOE_TOP" rev-parse -q --verify HEAD 2>/dev/null) || head_before=""
        if land_commit "$LAND_KIND"; then rc=0; else rc=$?; fi
        if [ "$rc" -eq 0 ]; then
            head_after="$LAND_SHA"
        fi
    else
        rc=0
        if [ "$LAND_KIND" = "completion" ] && [ "${ATTR_N_DECLARED:-0}" -eq 0 ]; then
            LAND_OUTCOME="refused"
            LAND_CODE="MOE_COMMIT_REFUSED_NO_OWNED_PATHS"
        elif [ "${ATTR_ALL_ASSERTED_MISSING:-0}" = "1" ] && [ "${ATTR_N_TOOL:-0}" -eq 0 ]; then
            LAND_OUTCOME="refused"
            LAND_CODE="MOE_COMMIT_REFUSED_OWNED_PATH_MISSING"
        else
            LAND_OUTCOME="nothing"
        fi
        if [ "$LAND_KIND" = "completion" ]; then
            # Today's shape: peel happens before staging even when nothing is
            # staged, so pre-existing local commits still get pushed.
            if ! ensure_safe_branch; then
                LAND_OUTCOME="failed"
                LAND_CODE="MOE_COMMIT_FAILED_PEEL"
                rescue_ref "peel-failed" "$ATTR_DIR/candidates" || true
                rc=3
            else
                LAND_BRANCH="$MOE_SHARED_BRANCH"
            fi
        fi
    fi

    # A "nothing" outcome carries its code (the ps1 twin sets $res.Code on
    # every nothing branch): the session-ended chat line's outcome=/code=
    # suffix must read the same on both wrappers.
    if [ "$LAND_OUTCOME" = "nothing" ] && [ -z "${LAND_CODE:-}" ]; then
        LAND_CODE="MOE_COMMIT_NOTHING_TO_COMMIT"
    fi

    case "$LAND_OUTCOME" in
        committed)
            # Non-excluded attribution skips (incl. MISSING) plus staging-time
            # drops — same arithmetic as the ps1 twin's SkippedCount.
            local n_dropped=0
            if [ -n "${LAND_DROPPED_FILE:-}" ] && [ -f "$LAND_DROPPED_FILE" ]; then
                n_dropped=$(tr -cd '\0' < "$LAND_DROPPED_FILE" 2>/dev/null | wc -c | tr -d '[:space:]') || n_dropped=0
            fi
            n_skipped=$(( ${ATTR_N_SKIPPED:-0} - ${ATTR_N_EXCLUDED:-0} + ${ATTR_N_MISSING:-0} + ${n_dropped:-0} ))
            echo -e "${GREEN}[OK]${NC} Committed $LAND_KIND for task $LAND_TASK_ID on $LAND_BRANCH: $LAND_SHA ($LAND_N_PATHS paths, $LAND_N_INFERRED inferred, $n_skipped skipped, ${ATTR_N_UNATTRIBUTED:-0} unattributed)"
            ;;
        refused)
            echo -e "${YELLOW}[WARN]${NC} $LAND_CODE: task $LAND_TASK_ID -- refusing to auto-commit; there is no whole-tree fallback. Commit the task's own paths by hand: git commit -- <path> [<path>...]"
            ;;
        nothing)
            echo -e "${BLUE}[info]${NC} MOE_COMMIT_NOTHING_TO_COMMIT: task $LAND_TASK_ID -- no changed candidate paths (already landed, or the session changed nothing it may commit)."
            ;;
    esac
    if [ "${ATTR_N_UNATTRIBUTED:-0}" -gt 0 ]; then
        local unattr_list="" rec
        while IFS= read -r -d '' rec; do
            unattr_list="$unattr_list ${rec#*"$MOE_TAB"}"
        done < "$ATTR_DIR/unattributed"
        echo -e "${YELLOW}[attribution]${NC} MOE_ATTRIBUTION_UNRESOLVED task=$LAND_TASK_ID:$unattr_list"
        echo -e "${YELLOW}[attribution]${NC} these changed paths were neither declared by the task nor written by its tools while other workers were active; report them via complete_step.modifiedFiles or moe.declare_files."
    fi

    # Push policy: completion pushes as today (also after refusals/nothing AND
    # after a failed commit, so pre-existing local commits reach origin -- same
    # as the ps1 twin; push_branch itself announces PUSH FAILED when the push
    # cannot reach the remote). Checkpoints only when settings.checkpointPush.
    # Ref-contention skips the push: the branch is moving under a peer.
    LAND_PUSHED=""
    if [ "$rc" -ne 3 ]; then
        if [ "$LAND_KIND" = "completion" ]; then
            if [ "$LAND_OUTCOME" = "failed" ] && [ "${LAND_CODE:-}" = "MOE_COMMIT_FAILED_REF_CONTENTION" ]; then
                LAND_PUSHED=""
            elif push_branch "completion"; then
                LAND_PUSHED="true"
            else
                LAND_PUSHED="false"
            fi
        elif [ "$LAND_OUTCOME" = "committed" ]; then
            if [ "$CS_CHECKPOINT_PUSH" = "true" ]; then
                if push_branch "checkpoint"; then LAND_PUSHED="true"; else LAND_PUSHED="false"; fi
            else
                LAND_PUSHED="false"
                echo -e "${BLUE}[info]${NC} settings.checkpointPush=false -- checkpoint kept local on $LAND_BRANCH."
            fi
        fi
    fi

    # Record (rebase-safe sha lookup by the Moe-Session trailer).
    if [ "$LAND_OUTCOME" = "committed" ]; then
        local found
        found=$(git -C "$MOE_TOP" log -n1 --format=%H --fixed-strings --grep="Moe-Session: $MOE_SID" "$LAND_BRANCH" 2>/dev/null) || found=""
        if [ -n "$found" ]; then
            LAND_SHA="$found"
            LAND_TREE=$(git -C "$MOE_TOP" rev-parse "$found^{tree}" 2>/dev/null) || LAND_TREE=""
        fi
        record_commit_rpc "committed" "$LAND_KIND" "$LAND_SHA" "$LAND_BRANCH" "" "" "$LAND_PUSHED" "$LAND_STAGED_FILE" "$LAND_DROPPED_FILE" || true
        baseline_after_landing "$LAND_TASK_ID" "$work/B.tsv" "$ATTR_DIR/unattributed" "$LAND_STAGED_FILE" 1
    elif [ "$LAND_OUTCOME" = "nothing" ]; then
        record_commit_rpc "nothing" "$LAND_KIND" "" "$LAND_BRANCH" "MOE_COMMIT_NOTHING_TO_COMMIT" "" "" "" "" || true
        baseline_after_landing "$LAND_TASK_ID" "$work/B.tsv" "$ATTR_DIR/unattributed" "$work/none.z" 1
    elif [ "$LAND_OUTCOME" = "refused" ]; then
        record_commit_rpc "refused" "$LAND_KIND" "" "$LAND_BRANCH" "$LAND_CODE" "" "" "" "" || true
        baseline_after_landing "$LAND_TASK_ID" "$work/B.tsv" "$ATTR_DIR/unattributed" "$work/none.z" 1
    else
        record_commit_rpc "failed" "$LAND_KIND" "" "$LAND_BRANCH" "${LAND_CODE:-MOE_COMMIT_FAILED}" "${LAND_MESSAGE:-}" "" "" "$LAND_DROPPED_FILE" || true
    fi
    MOE_LANDING_DONE=true
    # Summary convention (same as the ps1 twin): sha falls back to the rescue
    # sha on a failed landing that parked its bytes on a rescue ref.
    LAND_SUMMARY_SHA="${LAND_SHA:-}"
    [ -n "$LAND_SUMMARY_SHA" ] || LAND_SUMMARY_SHA="${LAND_RESCUE_SHA:-}"
    [ -n "$LAND_SUMMARY_SHA" ] || LAND_SUMMARY_SHA="none"
    LAND_SUMMARY_KIND="$LAND_KIND"
    LAND_SUMMARY_PATHS="$LAND_N_PATHS"
    LAND_SUMMARY_INFERRED="$LAND_N_INFERRED"
    LAND_SUMMARY_UNATTR="${ATTR_N_UNATTRIBUTED:-0}"
    LAND_SUMMARY_OUTCOME="$LAND_OUTCOME"
    LAND_SUMMARY_CODE="${LAND_CODE:-}"
    if [ "$rc" -eq 3 ]; then return 3; fi
    if [ "$LAND_OUTCOME" = "failed" ]; then return 1; fi
    return 0
}

# ---- pre-flight --------------------------------------------------------------
# preflight_landing TASKID TITLE STATUS_HINT launch|idle
#   1. scope (preflight)  2. DONE/ARCHIVED/notFound -> drop baseline  3. lingering
#   baseline -> recovery checkpoint NOW (MOE_CHECKPOINT_RECOVERED)  [idle stops
#   here]  4. baseline merge  5. rescue-ref discovery  6. shared-checkout notice
#   (both go into MOE_PREFLIGHT_NOTICE for the dynamic context).
preflight_landing() {
    local tid="$1" title="$2" status_hint="$3" phase="$4"
    MOE_PREFLIGHT_NOTICE=""
    MOE_BASELINE_PATH=""
    [ "$CS_AUTO_COMMIT" = "true" ] || return 0
    git_top || return 0
    local work parsed scope_status="" scope_title="" scope_notfound="0" rc=0 known_mine bp
    work="$(create_secure_temp)/preflight-$$"
    rm -rf "$work" 2>/dev/null || true
    mkdir -p "$work"
    known_mine="$work/known-mine.txt"
    commit_scope preflight "$tid" "$work/scope.json"
    parsed=$($PYTHON_CMD - "$work/scope.json" "$known_mine" "$MOE_REL" <<'PYEOF' 2>/dev/null || echo ""
import json, re, sys
scope_f, out_f, rel = sys.argv[1:4]
def clean(s):
    return str(s or '').replace('\r', ' ').replace('\n', ' ').replace('\x1f', ' ')
try:
    with open(scope_f, encoding='utf-8') as fh:
        d = json.load(fh)
    if not isinstance(d, dict):
        d = {}
except Exception:
    d = {}
def norm(raw):
    if not isinstance(raw, str):
        return None
    p = raw.strip().replace('\\', '/')
    while p.startswith('./'):
        p = p[2:]
    if not p or p.startswith('/') or re.match(r'^[A-Za-z]:/', p) or any(s == '..' for s in p.split('/')):
        return None
    return rel + p.rstrip('/')
with open(out_f, 'w', encoding='utf-8', errors='surrogateescape', newline='') as out:
    for k in ('asserted', 'touchedFiles', 'unattributedPaths', 'inferredPaths'):
        for raw in (d.get(k) or []):
            n = norm(raw)
            if n:
                out.write(n + '\n')
sys.stdout.write(clean(d.get('status')) + '\x1f' + clean(d.get('title')) + '\x1f' + ('1' if d.get('notFound') else '0') + '\x1f')
PYEOF
    )
    if [ -n "$parsed" ]; then
        { IFS= read -r -d $'\x1f' scope_status
          IFS= read -r -d $'\x1f' scope_title
          IFS= read -r -d $'\x1f' scope_notfound
        } <<< "$parsed" 2>/dev/null || true
    fi
    bp="$(baseline_path "$tid")"
    if [ "${scope_notfound:-0}" = "1" ]; then
        echo -e "${YELLOW}[WARN]${NC} [attribution] task $tid not found in the daemon or on disk -- dropping its baseline."
        baseline_delete "$tid"
        return 0
    fi
    if [ "$scope_status" = "DONE" ] || [ "$scope_status" = "ARCHIVED" ]; then
        baseline_delete "$tid"
        return 0
    fi
    local status="${scope_status:-$status_hint}"
    [ -n "$status" ] || status="UNKNOWN"
    [ -n "$title" ] || title="$scope_title"

    # 3. Recovery: a baseline that never reached a completed landing means the
    # previous session ended without one (Ctrl+C, window close, crash, lookup
    # failure, CAS exhaustion). Land it as a checkpoint now.
    if [ -f "$bp" ] && ! baseline_landed "$tid"; then
        echo -e "${BLUE}[info]${NC} lingering baseline for $tid -- landing the previous session's work before this one starts."
        LAND_KIND="checkpoint"; LAND_TASK_ID="$tid"; LAND_TITLE="$title"; LAND_STATUS="$status"; LAND_REOPEN=0
        LAND_CLI_EXIT=0; LAND_RECOVERED=true; LAND_GATE_FAILED=false; LAND_POLICY_OVERRIDE=""
        LAND_SNAPSHOT_FILE=""; LAND_TOOL_FILE=""; LAND_SCOPE_FILE="$work/scope.json"
        if run_landing; then rc=0; else rc=$?; fi
        if [ "$LAND_OUTCOME" = "committed" ]; then
            echo -e "${GREEN}[OK]${NC} MOE_CHECKPOINT_RECOVERED task=$tid sha=$LAND_SHA"
        elif [ "$rc" -ne 0 ]; then
            echo -e "${YELLOW}[WARN]${NC} recovery landing for $tid did not complete (${LAND_CODE:-?}); baseline kept for the next attempt."
        fi
        MOE_SCOPE_FALLBACK=0
    fi
    [ "$phase" = "idle" ] && return 0

    # 4. Baseline merge: inter-session dirt is presumed foreign unless the task
    # is already known to own it (asserted/touched/unattributed/inferred/U).
    local spre="$work/S-pre.tsv" k_foreign="0" head=""
    if ! git_dirty_snapshot "$spre"; then
        echo -e "${YELLOW}[WARN]${NC} git status failed at pre-flight; no baseline written for $tid -- measured attribution is off for this session."
        return 0
    fi
    baseline_read "$tid" "$work/B-old.tsv" "$work/U.tsv" || true
    k_foreign=$($PYTHON_CMD - "$spre" "$work/B-old.tsv" "$known_mine" "$work/U.tsv" "$work/B-new.tsv" <<'PYEOF' 2>/dev/null || echo 0
import sys
spre_f, bold_f, mine_f, u_f, out_f = sys.argv[1:6]
CI = sys.platform in ('win32', 'darwin')
def key(p):
    return p.lower() if CI else p
def rows(path, min_parts):
    out = []
    try:
        with open(path, encoding='utf-8', errors='surrogateescape') as fh:
            for line in fh:
                line = line.rstrip('\n').rstrip('\r')
                parts = line.split('\t')
                if line and len(parts) >= min_parts:
                    out.append(parts)
    except Exception:
        pass
    return out
S = {}
for parts in rows(spre_f, 3):
    p = '\t'.join(parts[2:])
    S[key(p)] = (p, parts[0])
B = {}
for parts in rows(bold_f, 2):
    p = '\t'.join(parts[1:])
    B[key(p)] = (p, parts[0])
mine = set()
try:
    with open(mine_f, encoding='utf-8', errors='surrogateescape') as fh:
        for line in fh:
            line = line.rstrip('\n').rstrip('\r')
            if line:
                mine.add(key(line))
except Exception:
    pass
for parts in rows(u_f, 2):
    mine.add(key('\t'.join(parts[1:])))
had_baseline = bool(B)
new = {}
if not had_baseline:
    new = dict(S)
else:
    for k, (p, blob) in S.items():
        if k in B:
            new[k] = B[k]
        elif k not in mine:
            new[k] = (p, blob)
foreign = sum(1 for k in S if k not in mine)
with open(out_f, 'w', encoding='utf-8', errors='surrogateescape', newline='') as out:
    for k in sorted(new):
        p, blob = new[k]
        out.write(blob + '\t' + p + '\n')
sys.stdout.write(str(foreign))
PYEOF
    )
    head=$(git -C "$MOE_TOP" rev-parse -q --verify HEAD 2>/dev/null) || head=""
    # A dead merge (B-new.tsv absent) must NOT write a header-only baseline:
    # an empty B reads as "everything changed since baseline" and re-arms the
    # MEASURED sweep the landing's fail-closed guard exists to prevent.
    if [ -f "$work/B-new.tsv" ] && baseline_write "$tid" "$head" "$work/B-new.tsv" "$work/U.tsv" 0; then
        MOE_BASELINE_PATH="$bp"
        echo -e "${BLUE}[attribution]${NC} baseline written for $tid (${k_foreign:-0} dirty path(s) belong to other sessions or are pre-existing)"
    else
        echo -e "${YELLOW}[WARN]${NC} [attribution] could not write the baseline for $tid under $MOE_GITDIR/moe/baseline -- measured attribution is off for this session."
    fi

    # 5. Rescue-ref discovery.
    local rescue_list="" rescue_n=0 rescue_refs=""
    rescue_list=$(git -C "$MOE_TOP" for-each-ref --format='%(refname:short) %(objectname:short) %(subject)' "refs/moe/rescue/$tid/" 2>/dev/null) || rescue_list=""
    if [ -n "$rescue_list" ]; then
        rescue_n=$(printf '%s\n' "$rescue_list" | wc -l | tr -d '[:space:]')
        rescue_refs=$(printf '%s\n' "$rescue_list" | awk '{print $1}' | tr '\n' ' ' | sed 's/ *$//')
        echo -e "${YELLOW}[rescue]${NC} $rescue_n rescue ref(s) for $tid: $rescue_refs"
        MOE_PREFLIGHT_NOTICE="Earlier sessions of this task left rescue checkpoints: $rescue_refs. Recover with \`git show <ref> --stat\` / \`git checkout <ref> -- <path>\` before redoing work."
    fi

    # 6. Shared-checkout notice.
    local shared_branch
    shared_branch="$(current_branch_name)"
    case "$shared_branch" in main|master|HEAD|"") shared_branch="$(peel_target_branch)" ;; esac
    MOE_PREFLIGHT_NOTICE="${MOE_PREFLIGHT_NOTICE:+$MOE_PREFLIGHT_NOTICE
}This checkout is shared. ${k_foreign:-0} dirty path(s) belong to other sessions or are pre-existing debris. Never revert, stash, \`git add -A\`, or commit them, and never treat them as a stop condition -- note them in your step note and continue. Report every path you create or modify in \`complete_step.modifiedFiles\`. A prerequisite task has landed iff \`get_context.epicSiblings[*].landing.merged\` is true or \`git log $shared_branch --grep 'Moe-Task: <sibling>'\` finds it. BLOCKED is a wait state, never a terminal -- delivered work goes through \`complete_task\`."
    return 0
}

# ---- teardown ----------------------------------------------------------------
# teardown_rescue -- from the EXIT trap (Ctrl+C / SIGTERM / set -e abort),
# before deregister. If a task id + baseline exist and this session never
# completed a landing, park a single-snapshot rescue ref (policy never, no CAS
# loop, no push). Best-effort, idempotent; the persisted baseline stays the
# primary recovery (the next pre-flight lands it on the branch).
MOE_TEARDOWN_DONE=false
teardown_rescue() {
    [ "$MOE_TEARDOWN_DONE" = true ] && return 0
    MOE_TEARDOWN_DONE=true
    set +e
    local tid="${PREFLIGHT_TASK_ID:-}"
    [ -n "$tid" ] || return 0
    [ "${MOE_LANDING_DONE:-}" = "true" ] && return 0
    [ "${CS_AUTO_COMMIT:-true}" = "true" ] || return 0
    [ -n "${MOE_TOP:-}" ] && [ -n "${MOE_GITDIR:-}" ] || return 0
    [ -f "$(baseline_path "$tid")" ] || return 0
    [ "$(type -t run_landing)" = "function" ] || return 0
    echo ""
    echo -e "${YELLOW}[rescue]${NC} session ending with task $tid unlanded -- taking a rescue snapshot before deregistering."
    local work
    work="$(create_secure_temp)/teardown-$$"
    rm -rf "$work" 2>/dev/null
    mkdir -p "$work" 2>/dev/null || return 0
    ATTR_DIR="$work/attr"
    mkdir -p "$ATTR_DIR" 2>/dev/null || return 0
    LAND_KIND="rescue"; LAND_TASK_ID="$tid"; LAND_TITLE="${PREFLIGHT_TASK_TITLE:-}"; LAND_STATUS="${LAND_STATUS:-UNKNOWN}"
    LAND_CLI_EXIT="${CLI_EXIT_CODE:-}"; LAND_TREE=""; TI_N_STAGED=0; TI_N_INFERRED=0
    commit_scope postflight "$tid" "$work/scope.json"
    baseline_read "$tid" "$work/B.tsv" "$work/U.tsv" || true
    git_dirty_snapshot "$work/S.tsv" || return 0
    local tool="${MOE_TOOL_WRITES_FILE:-}"
    if [ -z "$tool" ] || [ ! -f "$tool" ]; then tool="$work/tool.txt"; : > "$tool"; fi
    LAND_TOOL_FILE_EFFECTIVE="$tool"
    resolve_attribution "rescue" "$tid" "$work/S.tsv" "$work/B.tsv" "$work/U.tsv" "$tool" "$work/scope.json" "$ATTR_DIR" "never" || return 0
    rescue_ref "teardown" "$ATTR_DIR/candidates" || true
    MOE_LANDING_DONE=true
    return 0
}

FIRST_RUN=true

# Consecutive-resume tracking for the alreadyAssigned resume path (pre-flight
# below). Wrapper-scope: survives loop iterations, resets whenever the held
# task changes or clears. MOE_RESUME_MAX_ATTEMPTS caps how many fresh CLIs we
# relaunch onto the same still-assigned task before escalating to #general and
# idling -- a CLI that keeps dying on one task should page the governor, not
# burn sessions forever.
RESUME_TRACK_TASK_ID=""
RESUME_ATTEMPTS=0
RESUME_ESCALATED=false
RESUME_MAX_ATTEMPTS="${MOE_RESUME_MAX_ATTEMPTS:-5}"
case "$RESUME_MAX_ATTEMPTS" in
    ''|*[!0-9]*) RESUME_MAX_ATTEMPTS=5 ;;
esac

# --- Self-restart when this script's own bytes change on disk -----------------
# The shell reads this file incrementally, so an edit to a running script can
# even corrupt the current execution; either way a long-lived loop keeps serving
# whatever it already parsed. A fix can therefore be correct, installed, and
# still unreachable for days. Measured 2026-08-18 (task-965c37da): four
# whole-tree commits -- 9b9e44e, 76e7396, 39a1b2c and ceb0370, the last of which
# captured a peer's live mutation drill into HEAD -- were produced by wrappers
# launched BEFORE the pathspec fix landed, while every copy on disk had the fix.
#
# The hash is captured ONCE, here, so one on-disk change triggers exactly one
# restart: the re-exec'd process captures the new hash and cannot thrash.
MOE_WRAPPER_PATH="${BASH_SOURCE[0]:-$0}"
MOE_WRAPPER_LAUNCH_HASH=""
if [ -f "$MOE_WRAPPER_PATH" ]; then
    # FAIL-OPEN: a wrapper that dies because it could not hash itself is a fleet
    # outage; a stale wrapper is merely the status quo this guard improves on.
    MOE_WRAPPER_LAUNCH_HASH="$(sha256sum "$MOE_WRAPPER_PATH" 2>/dev/null | cut -d' ' -f1 || true)"
fi
MOE_WRAPPER_ARGV=("$@")

while [ "$LOOP_RUNNING" = true ]; do
    if [ "$FIRST_RUN" = false ]; then
        echo ""
        echo -e "${YELLOW}Agent idle, checking for tasks in ${POLL_INTERVAL} seconds... (Ctrl+C to stop)${NC}"
        # Honor --poll-interval (PS parity); a hardcoded 2s near-busy-spins a
        # full CLI relaunch every 2s on an idle worker.
        sleep "$POLL_INTERVAL"
        echo -e "${BLUE}Relaunching agent...${NC}"
    fi

    # Top of the iteration, AFTER the poll sleep and BEFORE any task dispatch, so
    # a restart can never interleave with a half-done completion.
    if [ -n "$MOE_WRAPPER_LAUNCH_HASH" ]; then
        MOE_WRAPPER_CURRENT_HASH="$(sha256sum "$MOE_WRAPPER_PATH" 2>/dev/null | cut -d' ' -f1 || true)"
        if [ -n "$MOE_WRAPPER_CURRENT_HASH" ] &&            [ "$MOE_WRAPPER_CURRENT_HASH" != "$MOE_WRAPPER_LAUNCH_HASH" ]; then
            echo "wrapper source changed on disk; restarting to load it"
            # `exec` replaces this process WITHOUT running the EXIT trap, so
            # do its two must-haves by hand (ps1 parity): stop the sidecar and
            # deregister -- the re-exec'd wrapper registers afresh and any
            # held task is released for it (or a peer) to re-claim. The
            # previous post-flight already ran, so nothing is left to land.
            stop_heartbeat_sidecar
            if [ -n "${WORKER_ID:-}" ] && [ -n "${PROJECT:-}" ] && [ -f "$SCRIPT_DIR/moe-call.sh" ]; then
                bash "$SCRIPT_DIR/moe-call.sh" deregister_worker \
                    "{\"workerId\":\"$WORKER_ID\",\"reason\":\"wrapper_restart\"}" \
                    --project "$PROJECT" >/dev/null 2>&1 || true
            fi
            if [ -n "$SECURE_TEMP_DIR" ] && [ -d "$SECURE_TEMP_DIR" ]; then
                rm -rf "$SECURE_TEMP_DIR" 2>/dev/null || true
            fi
            exec "$MOE_WRAPPER_PATH" "${MOE_WRAPPER_ARGV[@]}"
            echo "wrapper relaunch failed; continuing on current bytes"
        fi
    fi

    IS_FIRST_ITERATION="$FIRST_RUN"
    FIRST_RUN=false

    CLI_EXIT_CODE=0

    # -------- Pre-flight: perform startup rituals BEFORE spawning the CLI --------
    # Claim the next task, fetch context, read chat backlog.
    # Results are baked into SYSTEM_APPEND/PROMPT below so the agent starts
    # already initialized instead of being told to do these via prompt.
    PREFLIGHT_TASK_ID=""
    PREFLIGHT_TASK_TITLE=""
    PREFLIGHT_TASK_CHANNEL=""
    PREFLIGHT_CONTEXT=""
    PREFLIGHT_GENERAL_UNREAD=""
    PREFLIGHT_TASK_UNREAD=""
    PREFLIGHT_PENDING=""
    PREFLIGHT_SKILL_NAME=""
    PREFLIGHT_SKILL_REASON=""
    PREFLIGHT_SKILL_NEXT_TOOL=""
    PREFLIGHT_NO_TASK=false
    PREFLIGHT_OK=false
    PREFLIGHT_IS_RESUME=false
    PREFLIGHT_ROUTED_MENTIONS_JSON=""
    PREFLIGHT_ROUTED_MENTIONS_COUNT=0
    # Landing state is per-iteration: a previous task's baseline, snapshot or
    # tool-write harvest must never leak into this task's attribution.
    MOE_PREFLIGHT_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    MOE_SID="$WORKER_ID@$MOE_PREFLIGHT_ISO"
    MOE_TOP=""
    MOE_REL=""
    MOE_GITDIR=""
    MOE_BASELINE_PATH=""
    MOE_LANDING_DONE=""
    MOE_PREFLIGHT_NOTICE=""
    MOE_TOOL_WRITES_FILE="$(create_secure_temp)/tool-writes-$$.txt"
    : > "$MOE_TOOL_WRITES_FILE"
    LAND_STATUS=""
    LAND_SUMMARY_SHA="none"; LAND_SUMMARY_KIND="none"; LAND_SUMMARY_PATHS=0; LAND_SUMMARY_INFERRED=0; LAND_SUMMARY_UNATTR=0; LAND_SUMMARY_OUTCOME=""; LAND_SUMMARY_CODE=""
    POSTFLIGHT_SNAPSHOT=""
    read_commit_settings

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

        # 1. Join #general (only on first iteration; daemon-side join is idempotent
        #    and re-joining every loop iteration is wasted RPC). Read unread each
        #    iteration so routed mentions for THIS task surface in <routed_mentions>.
        if [ -n "$GENERAL_CHANNEL_ID" ]; then
            if [ "$IS_FIRST_ITERATION" = true ]; then
                moe_rpc chat_join \
                    "$($PYTHON_CMD -c "import json,sys; print(json.dumps({'channel':sys.argv[1],'workerId':sys.argv[2]}))" "$GENERAL_CHANNEL_ID" "$WORKER_ID" 2>/dev/null)" \
                    > /dev/null 2>&1 || true
            fi

            # 2. Read unread #general messages
            PREFLIGHT_GENERAL_UNREAD=$(moe_rpc chat_read \
                "$($PYTHON_CMD -c "import json,sys; print(json.dumps({'channel':sys.argv[1],'workerId':sys.argv[2]}))" "$GENERAL_CHANNEL_ID" "$WORKER_ID" 2>/dev/null)" \
                2>/dev/null || echo "")
        fi

        # 3. Check pending questions
        PREFLIGHT_PENDING=$(moe_rpc get_pending_questions "{}" 2>/dev/null || echo "")

        # 4. Claim next task (auto-registers the worker).
        # Governors do NOT claim tasks. They enter governance mode once per
        # session and then live in chat_wait / mention loops. See
        # docs/roles/governor.md -- claim_next_task would reject the governor
        # workerId and is semantically wrong here. Synthesize a hasNext:false
        # claim result so downstream code routes through the no-task banner
        # (which the role doc remaps to the chat_wait loop).
        if [ "$ROLE" = "governor" ]; then
            GOV_ARGS=$($PYTHON_CMD -c "import json,sys; print(json.dumps({'workerId':sys.argv[1]}))" "$WORKER_ID" 2>/dev/null || echo "{}")
            if moe_rpc enter_governance "$GOV_ARGS" > /dev/null 2>&1; then
                echo -e "${GREEN}[OK]${NC} Entered governance mode as $WORKER_ID."
            else
                echo -e "${YELLOW}[WARN]${NC} enter_governance failed -- continuing; agent can retry from inside the CLI."
            fi
            CLAIM_RESULT='{"hasNext":false}'
        else
            CLAIM_RESULT=$(moe_rpc claim_next_task "$CLAIM_JSON" 2>/dev/null || echo "")
        fi
        if [ -n "$CLAIM_RESULT" ]; then
            HAS_NEXT=$($PYTHON_CMD -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    print('true' if d.get('hasNext') else 'false')
except Exception:
    print('error')
" <<< "$CLAIM_RESULT" 2>/dev/null || echo "error")

            # Resume signal: hasNext:false + alreadyAssigned means THIS worker
            # still holds an active task from a previous CLI session that died
            # mid-task (crash, or a one-shot session ending its turn early).
            # Treat it as a claim and relaunch the CLI onto the held task.
            # Ignoring it strands the task: it is never claimable by anyone
            # else while this wrapper's polling keeps the worker record alive,
            # and the wrapper would idle-loop on "No claimable task" forever.
            RESUME_TASK_ID=""
            RESUME_TASK_TITLE=""
            RESUME_TASK_STATUS=""
            RESUME_TASK_BLOCKED_RESOURCE=""
            RESUME_TASK_BLOCKED_REASON=""
            if [ "$HAS_NEXT" = "false" ]; then
                # Unit-separator (\x1f) fields, newlines sanitized: bash
                # command substitution strips NUL bytes, so a '\0' separator
                # would silently concatenate the fields.
                PARSED_RESUME=$($PYTHON_CMD -c "
import json, sys
def clean(s):
    return (s or '').replace('\r', ' ').replace('\n', ' ')
try:
    d = json.loads(sys.stdin.read())
    aa = d.get('alreadyAssigned') or {}
    tid = clean(aa.get('taskId'))
    if tid:
        sys.stdout.write(tid + '\x1f' + clean(aa.get('title')) + '\x1f' + clean(aa.get('status')) + '\x1f' + clean(aa.get('blockedResourceId')) + '\x1f' + clean(aa.get('blockedReason')))
except Exception:
    pass
" <<< "$CLAIM_RESULT" 2>/dev/null || echo "")
                if [ -n "$PARSED_RESUME" ]; then
                    IFS=$'\x1f' read -r RESUME_TASK_ID RESUME_TASK_TITLE RESUME_TASK_STATUS RESUME_TASK_BLOCKED_RESOURCE RESUME_TASK_BLOCKED_REASON <<< "$PARSED_RESUME" || true
                    RESUME_TASK_ID="${RESUME_TASK_ID:-}"
                    RESUME_TASK_TITLE="${RESUME_TASK_TITLE:-}"
                    RESUME_TASK_STATUS="${RESUME_TASK_STATUS:-}"
                    RESUME_TASK_BLOCKED_RESOURCE="${RESUME_TASK_BLOCKED_RESOURCE:-}"
                    RESUME_TASK_BLOCKED_REASON="${RESUME_TASK_BLOCKED_REASON:-}"
                fi
            fi
            # BLOCKED hold: the daemon parked this worker's task via
            # moe.report_blocked while it waits on a shared-resource lease,
            # and the grant path will auto-flip it back to its pre-block
            # status (returning it to THIS parked worker by design). With
            # daemon seat-freeing, an assignee-reported non-resource
            # report_blocked releases the seat instead (task
            # BLOCKED-unassigned, worker IDLE claims other work), so
            # alreadyAssigned{status:BLOCKED} now happens only for resource
            # blocks and third-party (workerId-less) blocks on an assigned
            # task. Relaunching a CLI onto it is pure waste -- nothing can be
            # done until the lease is granted / a human clears it -- and every
            # relaunch would burn one of the MOE_RESUME_MAX_ATTEMPTS budget.
            # Suppress the resume entirely (no chat escalation: a BLOCKED
            # hold is expected daemon state, not a dying CLI) and clear the
            # tracker so the eventual unblock starts the resume path fresh
            # with its full attempt budget. Clearing RESUME_TASK_ID routes
            # this iteration into the existing no-task path (same mechanism
            # as the cap path).
            if [ -n "$RESUME_TASK_ID" ] && [ "$RESUME_TASK_STATUS" = "BLOCKED" ]; then
                BLOCKED_DETAIL="no reason given"
                if [ -n "$RESUME_TASK_BLOCKED_RESOURCE" ]; then
                    BLOCKED_DETAIL="resource $RESUME_TASK_BLOCKED_RESOURCE"
                elif [ -n "$RESUME_TASK_BLOCKED_REASON" ]; then
                    BLOCKED_DETAIL="$RESUME_TASK_BLOCKED_REASON"
                fi
                echo -e "${YELLOW}[blocked]${NC} $RESUME_TASK_ID is BLOCKED ($BLOCKED_DETAIL) -- suppressing auto-resume; only resource-lease waits and third-party blocks hold a seat now (an assignee-reported non-resource block frees it), so idling until the daemon un-blocks it."
                # Land-on-every-exit (A5): the held BLOCKED task may carry a
                # lingering baseline from the session that blocked it. Recover
                # it onto the branch NOW so a blocked task's files reach git
                # with no CLI launched (steps 1-3 of the pre-flight landing).
                preflight_landing "$RESUME_TASK_ID" "$RESUME_TASK_TITLE" "$RESUME_TASK_STATUS" idle || true
                RESUME_TRACK_TASK_ID=""
                RESUME_ATTEMPTS=0
                RESUME_ESCALATED=false
                RESUME_TASK_ID=""
            fi
            if [ -n "$RESUME_TASK_ID" ]; then
                if [ "$RESUME_TRACK_TASK_ID" != "$RESUME_TASK_ID" ]; then
                    RESUME_TRACK_TASK_ID="$RESUME_TASK_ID"
                    RESUME_ATTEMPTS=0
                    RESUME_ESCALATED=false
                fi
                RESUME_ATTEMPTS=$((RESUME_ATTEMPTS + 1))
                if [ "$RESUME_ATTEMPTS" -gt "$RESUME_MAX_ATTEMPTS" ]; then
                    # The CLI keeps dying on this task without finishing it.
                    # Stop burning sessions: escalate once to #general (governor
                    # or human can release_task / investigate) and idle.
                    if [ "$RESUME_ESCALATED" = false ] && [ -n "$GENERAL_CHANNEL_ID" ]; then
                        ESCALATION_MSG="@governors $WORKER_ID: CLI session ended $((RESUME_ATTEMPTS - 1)) times in a row while still holding $RESUME_TASK_ID (${RESUME_TASK_STATUS:-?}); wrapper is pausing auto-resume. release_task to reassign, or investigate why sessions keep dying mid-task."
                        moe_rpc chat_send \
                            "$($PYTHON_CMD -c "import json,sys; print(json.dumps({'channel':sys.argv[1],'workerId':sys.argv[2],'content':sys.argv[3]}))" "$GENERAL_CHANNEL_ID" "$WORKER_ID" "$ESCALATION_MSG" 2>/dev/null)" \
                            > /dev/null 2>&1 || true
                        RESUME_ESCALATED=true
                    fi
                    echo -e "${RED}[resume]${NC} Auto-resume cap reached ($RESUME_MAX_ATTEMPTS) for $RESUME_TASK_ID -- escalated to #general; idling until released."
                    # Land-on-every-exit (A6): same recovery landing as the
                    # BLOCKED hold -- the dying sessions' edits reach the
                    # branch before this wrapper idles on the held task.
                    preflight_landing "$RESUME_TASK_ID" "$RESUME_TASK_TITLE" "$RESUME_TASK_STATUS" idle || true
                    RESUME_TASK_ID=""
                fi
            else
                # No held task this iteration -- clear the consecutive-resume tracker.
                RESUME_TRACK_TASK_ID=""
                RESUME_ATTEMPTS=0
                RESUME_ESCALATED=false
            fi

            if [ "$HAS_NEXT" = "true" ] || [ -n "$RESUME_TASK_ID" ]; then
                if [ -n "$RESUME_TASK_ID" ]; then
                    PREFLIGHT_IS_RESUME=true
                    PREFLIGHT_TASK_ID="$RESUME_TASK_ID"
                    PREFLIGHT_TASK_TITLE="$RESUME_TASK_TITLE"
                    echo -e "${YELLOW}[resume]${NC} $WORKER_ID already holds $PREFLIGHT_TASK_ID (${RESUME_TASK_STATUS:-?}) from a previous session (attempt $RESUME_ATTEMPTS/$RESUME_MAX_ATTEMPTS) -- relaunching CLI to resume it."
                fi
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
                fi

                # 5. Fetch context for the claimed task
                if [ -n "$PREFLIGHT_TASK_ID" ]; then
                    PREFLIGHT_CONTEXT=$(moe_rpc get_context \
                        "$($PYTHON_CMD -c "import json,sys; print(json.dumps({'taskId':sys.argv[1]}))" "$PREFLIGHT_TASK_ID" 2>/dev/null)" \
                        2>/dev/null || echo "")
                    # alreadyAssigned carries no chatChannel -- recover it from
                    # the full context on the resume path (the trim below drops it).
                    if [ -z "$PREFLIGHT_TASK_CHANNEL" ] && [ -n "$PREFLIGHT_CONTEXT" ] && [ -n "$PYTHON_CMD" ]; then
                        PREFLIGHT_TASK_CHANNEL=$($PYTHON_CMD -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    print((d.get('task') or {}).get('chatChannel') or '')
except Exception:
    pass
" <<< "$PREFLIGHT_CONTEXT" 2>/dev/null || echo "")
                    fi
                    # Trim the get_context payload before injection. Full JSON is
                    # 5-30KB; agents only need a working subset. Comments are
                    # dropped (re-fetch via moe.get_context if needed); plan notes
                    # are capped to 300 chars per step.
                    if [ -n "$PREFLIGHT_CONTEXT" ] && [ -n "$PYTHON_CMD" ]; then
                        PREFLIGHT_CONTEXT_TRIMMED=$("$PYTHON_CMD" -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    proj = d.get('project') or {}
    epic = d.get('epic') or {}
    tk = d.get('task') or {}
    plan = []
    for s in (tk.get('implementationPlan') or []):
        note = s.get('note') or ''
        if isinstance(note, str) and len(note) > 300:
            note = note[:300] + '...'
        plan.append({
            'stepId': s.get('stepId'),
            'title': s.get('title'),
            'description': s.get('description'),
            'status': s.get('status'),
            'note': note,
            'modifiedFiles': s.get('modifiedFiles'),
        })
    out = {
        'project': ({'id': proj.get('id'), 'name': proj.get('name'), 'globalRails': proj.get('globalRails')} if proj else None),
        'epic': ({'id': epic.get('id'), 'title': epic.get('title'), 'epicRails': epic.get('epicRails')} if epic else None),
        'task': ({
            'id': tk.get('id'),
            'title': tk.get('title'),
            'description': tk.get('description'),
            'status': tk.get('status'),
            'reopenCount': tk.get('reopenCount'),
            'reopenReason': tk.get('reopenReason'),
            'rejectionDetails': tk.get('rejectionDetails'),
            'definitionOfDone': tk.get('definitionOfDone'),
            'implementationPlan': plan,
            'taskRails': tk.get('taskRails'),
        } if tk else None),
        'allRails': d.get('allRails'),
        'planningNotes': d.get('planningNotes'),
        'nextAction': d.get('nextAction'),
    }
    sys.stdout.write(json.dumps(out, separators=(',', ':')))
except Exception:
    pass
" <<< "$PREFLIGHT_CONTEXT" 2>/dev/null || true)
                        if [ -n "$PREFLIGHT_CONTEXT_TRIMMED" ]; then
                            PREFLIGHT_CONTEXT="$PREFLIGHT_CONTEXT_TRIMMED"
                        fi
                    fi
                fi

                # 6. Read task channel backlog
                if [ -n "$PREFLIGHT_TASK_CHANNEL" ]; then
                    PREFLIGHT_TASK_UNREAD=$(moe_rpc chat_read \
                        "$($PYTHON_CMD -c "import json,sys; print(json.dumps({'channel':sys.argv[1],'workerId':sys.argv[2]}))" "$PREFLIGHT_TASK_CHANNEL" "$WORKER_ID" 2>/dev/null)" \
                        2>/dev/null || echo "")
                fi

                # 7. Cross-session memory lives in Serena now: the agent pulls prior
                #    knowledge with Serena list_memories / read_memory on task start.
                #    The wrapper does no memory preflight.

                # 8. Extract phase-recommended skill from context.nextAction. We
                #    DO NOT inline the body -- the agent loads it via the Skill tool.
                #    We only pull name + reason + the tool it gates, to emit a short
                #    JIT reminder further down in SYSTEM_APPEND.
                #
                #    The three fields are emitted \x1f-separated with newlines
                #    sanitized to spaces: bash command substitution strips NUL
                #    bytes, so the previous '\0' separator silently concatenated
                #    name+reason+tool into PREFLIGHT_SKILL_NAME.
                if [ -n "$PREFLIGHT_CONTEXT" ]; then
                    PARSED_SKILL=$($PYTHON_CMD -c "
import json, sys
def clean(s):
    return (s or '').replace('\r', ' ').replace('\n', ' ')
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
    sys.stdout.write(clean(name) + '\x1f' + clean(reason) + '\x1f' + clean(na.get('tool')))
except Exception:
    pass
" <<< "$PREFLIGHT_CONTEXT" 2>/dev/null || echo "")
                    IFS=$'\x1f' read -r PREFLIGHT_SKILL_NAME PREFLIGHT_SKILL_REASON PREFLIGHT_SKILL_NEXT_TOOL <<< "$PARSED_SKILL" || true
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
                if [ "$PREFLIGHT_IS_RESUME" = true ]; then
                    echo -e "${GREEN}[OK]${NC} Pre-flight complete. Resuming: $PREFLIGHT_TASK_ID ($PREFLIGHT_TASK_TITLE)"
                else
                    echo -e "${GREEN}[OK]${NC} Pre-flight complete. Claimed: $PREFLIGHT_TASK_ID ($PREFLIGHT_TASK_TITLE)"
                fi

                # Announce "online" once per wrapper-process lifetime. Per-task
                # starts/completions are conveyed by post-flight session-end and
                # the daemon's task-state events.
                if [ -n "$GENERAL_CHANNEL_ID" ] && [ "$IS_FIRST_ITERATION" = true ]; then
                    ANNOUNCE_VERB="starting"
                    if [ "$PREFLIGHT_IS_RESUME" = true ]; then ANNOUNCE_VERB="resuming held task"; fi
                    moe_rpc chat_send \
                        "$($PYTHON_CMD -c "import json,sys; print(json.dumps({'channel':sys.argv[1],'workerId':sys.argv[2],'content':sys.argv[3]+' online, '+sys.argv[4]+' '+sys.argv[5]+': '+sys.argv[6]}))" "$GENERAL_CHANNEL_ID" "$WORKER_ID" "$ROLE" "$ANNOUNCE_VERB" "$PREFLIGHT_TASK_ID" "$PREFLIGHT_TASK_TITLE" 2>/dev/null)" \
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
                governor)  ROLE_GROUP_TAG="governors" ;;
            esac
            # Exit code is captured SEPARATELY instead of being swallowed by
            # `|| true`: that swallow is exactly the habit being removed here.
            # A routed mention that vanishes is the same harm class as one whose
            # body was replaced, so an extraction failure must reach the
            # recipient as a marker, not as an empty block.
            set +e
            MENTIONS_RESULT=$(PREFLIGHT_GENERAL_UNREAD="$PREFLIGHT_GENERAL_UNREAD" \
                              PREFLIGHT_TASK_UNREAD="$PREFLIGHT_TASK_UNREAD" \
                              MOE_PROJECT_DIR="$PROJECT" \
                              "$PYTHON_CMD" - "$WORKER_ID" "$ROLE_GROUP_TAG" <<'PYEOF' 2>/dev/null
import sys, json, os, re
worker_id  = sys.argv[1]
role_group = sys.argv[2]
project    = os.environ.get("MOE_PROJECT_DIR", "")

# A routed @mention body is text written by someone else that gets injected
# into a teammate's session context, so the delivery path is an injection
# surface. Confirmed 11+ times: the delivered body was replaced with unrelated
# instruction-shaped content while the at-rest record stayed correct. The RPC
# response is therefore NOT authoritative for the body -- the jsonl is. Reason
# codes below are spelled IDENTICALLY in moe-agent.ps1.
MARKER = "MOE_MENTION_DELIVERY_FAILED"
# Whitelisted, not sanitised: the channel id reaches a path join, and a crafted
# id like "../../secrets" must be refused outright rather than rewritten.
SAFE_CHANNEL = re.compile(r"^[A-Za-z0-9_-]+$")
_store_cache = {}

def load_store(channel):
    if channel in _store_cache:
        return _store_cache[channel]
    recs = {}
    path = os.path.join(project, ".moe", "messages", channel + ".jsonl")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    # A partial trailing line from a concurrent append simply
                    # fails to parse and is skipped -- the mention then fails
                    # CLOSED to a marker rather than being served half a body.
                    continue
                if isinstance(obj, dict) and isinstance(obj.get("id"), str):
                    recs[obj["id"]] = obj
    except Exception:
        recs = None
    _store_cache[channel] = recs
    return recs

def stored_record(channel, mid):
    if not mid:
        return (False, "MOE_MENTION_ID_MISSING", None)
    if not channel or not SAFE_CHANNEL.match(channel):
        return (False, "MOE_MENTION_CHANNEL_UNSAFE", None)
    recs = load_store(channel)
    if recs is None:
        return (False, "MOE_MENTION_STORE_UNREADABLE", None)
    rec = recs.get(mid)
    if rec is None:
        return (False, "MOE_MENTION_ID_NOT_IN_STORE", None)
    if not isinstance(rec.get("content"), str):
        return (False, "MOE_MENTION_CONTENT_MISSING", None)
    return (True, "", rec)

def verified_mention(msg, mid):
    ok, reason, rec = stored_record(msg.get("channel"), mid)
    if not ok:
        return {
            "id": mid, "channel": msg.get("channel"), "sender": msg.get("sender"),
            "content": "%s reason=%s id=%s channel=%s" % (MARKER, reason, mid, msg.get("channel")),
            "provenance": reason,
        }
    # Identity comes from the store too, not just the body. An RPC response that
    # lied about `sender` could otherwise put words in a named teammate's mouth
    # while every byte of the body verified clean.
    body = rec["content"]
    sender = rec.get("sender") if isinstance(rec.get("sender"), str) else msg.get("sender")
    channel = rec.get("channel") if isinstance(rec.get("channel"), str) else msg.get("channel")
    rpc = msg.get("content")
    rpc = rpc if isinstance(rpc, str) else ""
    if body == rpc:
        prov = "VERIFIED"
    elif rpc and body.startswith(rpc):
        # chat_read truncates at maxContentChars. Legitimate, but delivering
        # silently truncated bytes as "the message" is the same defect wearing a
        # different hat -- deliver the FULL stored body and label the RPC copy.
        prov = "VERIFIED_RPC_TRUNCATED"
    else:
        prov = "MOE_MENTION_CONTENT_DIVERGED"
    return {
        "id": mid, "channel": channel, "sender": sender,
        "content": body, "provenance": prov,
    }

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
            hits.append(verified_mention(msg, mid))
            if mid is not None:
                seen.add(mid)
out = json.dumps({"count": len(hits), "messages": hits}, ensure_ascii=True)
# JSON's structural syntax uses no '<' and no '>', so those can only have come
# from a string VALUE. Escaping them is lossless -- a JSON reader decodes them
# back -- but it stops a body containing "</routed_mentions>" from closing the
# fence and landing instruction text OUTSIDE the block (measured: it did).
# ensure_ascii above does the same for non-ASCII, which crosses an environment
# variable on Windows.
print(out.replace("<", "\\u003c").replace(">", "\\u003e"))
PYEOF
            )
            MENTIONS_RC=$?
            set -e
            MENTION_FAIL_REASON=""
            if [ "$MENTIONS_RC" -ne 0 ] || [ -z "$MENTIONS_RESULT" ]; then
                MENTION_FAIL_REASON="MOE_MENTION_EXTRACTION_FAILED"
            else
                PREFLIGHT_ROUTED_MENTIONS_JSON="$MENTIONS_RESULT"
                set +e
                PREFLIGHT_ROUTED_MENTIONS_COUNT=$("$PYTHON_CMD" -c "import json,sys; print(json.loads(sys.stdin.read()).get('count',0))" <<<"$MENTIONS_RESULT" 2>/dev/null)
                COUNT_RC=$?
                set -e
                # `|| echo 0` used to turn an unparseable count into "no
                # mentions" -- a silent drop dressed as a quiet inbox.
                if [ "$COUNT_RC" -ne 0 ] || ! [ "${PREFLIGHT_ROUTED_MENTIONS_COUNT:-x}" -ge 0 ] 2>/dev/null; then
                    MENTION_FAIL_REASON="MOE_MENTION_COUNT_UNPARSEABLE"
                fi
            fi
            if [ -n "$MENTION_FAIL_REASON" ]; then
                echo -e "${YELLOW:-\033[1;33m}[WARN]${NC} $MENTION_FAIL_REASON: routed-mention delivery failed; surfacing a marker instead of an empty block."
                PREFLIGHT_ROUTED_MENTIONS_JSON="{\"count\":1,\"messages\":[{\"id\":\"unknown\",\"channel\":\"unknown\",\"sender\":\"moe-agent\",\"content\":\"MOE_MENTION_DELIVERY_FAILED reason=$MENTION_FAIL_REASON id=unknown channel=unknown\",\"provenance\":\"$MENTION_FAIL_REASON\"}]}"
                PREFLIGHT_ROUTED_MENTIONS_COUNT=1
            fi
            if [ "$PREFLIGHT_ROUTED_MENTIONS_COUNT" -gt 0 ] 2>/dev/null; then
                echo -e "${MAGENTA:-\033[0;35m}[mention]${NC} $PREFLIGHT_ROUTED_MENTIONS_COUNT unread message(s) tagging $WORKER_ID -- will surface in system prompt."
            fi
            unset MENTIONS_RESULT ROLE_GROUP_TAG MENTIONS_RC COUNT_RC MENTION_FAIL_REASON
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
        governor)
            ROLE_STATUS_DESC="You govern in-flight work via moe.enter_governance + chat_wait. You do NOT claim tasks."
            ;;
    esac
    SYSTEM_APPEND="Role: $ROLE. $ROLE_STATUS_DESC Always use Moe MCP tools."
    if [ "$AUTO_CLAIM" = true ]; then
        SYSTEM_APPEND="$SYSTEM_APPEND Start by claiming the next task for your role."
    fi

    # Tool-name mapping, stated once in the stable (cache-friendly) prefix:
    # role docs and prompts write moe.<name> as shorthand, but the wire-level
    # MCP tool is moe_<name> on the server named "moe" -- without this line
    # every fresh per-task session burns a discovery round-trip re-learning
    # the prefix.
    SYSTEM_APPEND="$SYSTEM_APPEND

Tool naming: moe.<name> in docs/prompts is shorthand for MCP tool moe_<name> on the server named 'moe' (Claude Code exposes it as mcp__moe__moe_<name>, e.g. moe.submit_plan -> mcp__moe__moe_submit_plan). Serena tools are on the server named 'serena'. If tool schemas are deferred, batch-load every tool you need in ONE ToolSearch select call - do not guess tool names."

    # Append approval mode
    if [ -n "$APPROVAL_MODE" ]; then
        SYSTEM_APPEND="$SYSTEM_APPEND

# Project Settings
Approval mode: $APPROVAL_MODE"
    fi

    # Append role doc (re-read each iteration to pick up daemon-side upgrades)
    load_role_doc
    if [ -n "$ROLE_DOC" ]; then
        SYSTEM_APPEND="$SYSTEM_APPEND

$ROLE_DOC"
    fi

    # The daemon surfaces a phase-recommended skill via nextAction.recommendedSkill
    # on every MCP response -- the agent invokes it via the host's Skill tool when
    # present. Full manifest is on disk at .moe/skills/manifest.json if the agent
    # ever needs to browse what's available; we don't dump it into the prompt.

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

    # Pending-question handling: pre-flight already calls get_pending_questions
    # and the no-task banner instructs how to answer them when wait_for_task
    # wakes with hasPendingQuestion:true. No standalone block needed.

    # Fallback CLI helper: only inject when MOE_FALLBACK_CLI=1 (rare edge case).
    moe_call="$SCRIPT_DIR/moe-call.sh"
    if [ "${MOE_FALLBACK_CLI:-}" = "1" ] && [ -f "$moe_call" ]; then
        SYSTEM_APPEND="$SYSTEM_APPEND

# Fallback CLI
If MCP tools (moe.*) are not available, use: bash $moe_call <tool> '<json_args>' --project $PROJECT
Run: bash $moe_call --help for full list."
    fi

    # System prompt stays byte-identical across iterations so Anthropic's
    # prompt cache (5min/1h TTL) can hit on the stable prefix. Per-task and
    # per-iteration content (claimed_task_context, inbox, routed_mentions,
    # skill JIT) goes into DYNAMIC_CONTEXT and is prepended to the user
    # prompt -- NOT appended to SYSTEM_APPEND.
    DYNAMIC_CONTEXT=""
    if [ "$PREFLIGHT_OK" = true ]; then
        # Compute compact unread counts so we don't embed the full chat-read
        # responses (each one can be several KB of token-burning JSON).
        PREFLIGHT_GENERAL_COUNT=0
        if [ -n "$PREFLIGHT_GENERAL_UNREAD" ] && [ -n "$PYTHON_CMD" ]; then
            PREFLIGHT_GENERAL_COUNT=$("$PYTHON_CMD" -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    print(len(d.get('messages', []) or []))
except Exception:
    print(0)
" <<< "$PREFLIGHT_GENERAL_UNREAD" 2>/dev/null || echo 0)
        fi
        PREFLIGHT_TASK_COUNT=0
        if [ -n "$PREFLIGHT_TASK_UNREAD" ] && [ -n "$PYTHON_CMD" ]; then
            PREFLIGHT_TASK_COUNT=$("$PYTHON_CMD" -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    print(len(d.get('messages', []) or []))
except Exception:
    print(0)
" <<< "$PREFLIGHT_TASK_UNREAD" 2>/dev/null || echo 0)
        fi

        # Bounded Serena memory-name preload, read straight off disk (no Serena
        # call). The corpus grows unbounded on long-running projects (1700+
        # files observed), so never inline the full list: total count, names
        # containing THIS task id (prior handoffs), and the 20 most recently
        # updated. Names only -- the agent pulls content via Serena read_memory.
        # SERENA_PROJECT is exported by ensure_mcp_config; fall back to PROJECT
        # if that path was skipped.
        MEMORIES_DIR="${SERENA_PROJECT:-$PROJECT}/.serena/memories"
        MEM_TOTAL=0
        MEM_TASK_NAMES="none"
        MEM_RECENT_NAMES="none"
        if [ -d "$MEMORIES_DIR" ]; then
            MEM_TOTAL=$(find "$MEMORIES_DIR" -maxdepth 1 -type f -name '*.md' 2>/dev/null | wc -l | tr -d '[:space:]')
            [ -n "$MEM_TOTAL" ] || MEM_TOTAL=0
            if [ "$MEM_TOTAL" -gt 0 ] 2>/dev/null; then
                if [ -n "$PREFLIGHT_TASK_ID" ]; then
                    MEM_TASK_NAMES=$(cd "$MEMORIES_DIR" && ls -1 -- *.md 2>/dev/null | grep -F -- "$PREFLIGHT_TASK_ID" | sed 's/\.md$//' | tr '\n' ' ' | sed 's/ *$//' || true)
                    [ -n "$MEM_TASK_NAMES" ] || MEM_TASK_NAMES="none"
                fi
                MEM_RECENT_NAMES=$(cd "$MEMORIES_DIR" && ls -1t -- *.md 2>/dev/null | head -20 | sed 's/\.md$//' | tr '\n' ' ' | sed 's/ *$//' || true)
                [ -n "$MEM_RECENT_NAMES" ] || MEM_RECENT_NAMES="none"
            fi
        fi

        DYNAMIC_CONTEXT="# Pre-flight Complete (runtime-injected -- do not repeat)
You ARE: $ROLE agent, workerId=$WORKER_ID.
The wrapper has claimed your task and surfaced unread counts in <inbox> below. Fetch the full content via moe.chat_read when it is relevant; prior-knowledge memory names are preloaded in <inbox> - read the relevant ones via Serena read_memory. Routed mentions tagging you are listed verbatim further down -- those are mandatory replies before any other planned tool call.

DO NOT re-call at session start: moe.chat_join, moe.claim_next_task, moe.get_context. They are done.

Claimed task id: $PREFLIGHT_TASK_ID

<claimed_task_context>
$PREFLIGHT_CONTEXT
</claimed_task_context>

<inbox>
unread_general=$PREFLIGHT_GENERAL_COUNT
unread_task=$PREFLIGHT_TASK_COUNT
mentions=$PREFLIGHT_ROUTED_MENTIONS_COUNT (see <routed_mentions> below if > 0)
memory_total=$MEM_TOTAL Serena memories (content via read_memory; names below are preloaded from disk - call list_memories only if they don't cover your area)
memory_this_task=$MEM_TASK_NAMES
memory_recent=$MEM_RECENT_NAMES
</inbox>

<pending_questions>
$PREFLIGHT_PENDING
</pending_questions>"

        # JIT reminder: point the agent at the phase-recommended skill. We do
        # NOT inline the body -- the agent loads it itself via the Skill tool.
        if [ -n "$PREFLIGHT_SKILL_NAME" ]; then
            JIT_NEXT_TOOL="${PREFLIGHT_SKILL_NEXT_TOOL:-your next Moe tool}"
            JIT_REASON="${PREFLIGHT_SKILL_REASON:-Phase-recommended for this task.}"
            DYNAMIC_CONTEXT="$DYNAMIC_CONTEXT

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
        DYNAMIC_CONTEXT="# Pre-flight Complete: no claimable task
The daemon reports no claimable task for role $ROLE right now.
Your FIRST action MUST be moe.wait_for_task with statuses=$STATUSES, workerId=$WORKER_ID.
When it returns hasNext:true, call moe.claim_next_task, then moe.get_context.
If moe.wait_for_task returns hasChatMessage:true, your NEXT calls MUST be moe.chat_read on chatMessage.channel, then moe.chat_send with your reply, THEN moe.wait_for_task again. Do not claim a new task while a routed mention is unanswered.
If hasPendingQuestion:true, call moe.get_pending_questions and answer with moe.add_comment."
    fi

    # Priority banner for unread messages routed at THIS worker. Goes LAST in
    # the dynamic context so it's the most recent text before the role-specific
    # PROMPT body -- maximizes the chance the model replies before any other
    # planned tool call.
    if [ "$PREFLIGHT_ROUTED_MENTIONS_COUNT" -gt 0 ] 2>/dev/null; then
        DYNAMIC_CONTEXT="$DYNAMIC_CONTEXT

<system-reminder>
# Incoming @mentions targeting you ($WORKER_ID)

You have $PREFLIGHT_ROUTED_MENTIONS_COUNT unread message(s) that named you directly, via @all, or via your role group. Before ANY other planned tool call (moe.start_step, moe.submit_plan, moe.qa_approve, moe.claim_next_task, etc.), you MUST reply to each via moe.chat_send in the same channel. Replies are substantive -- answer the question, confirm the handoff, or say why you can't. The Loop Guard (max 4 agent-to-agent hops per channel) is the system's throttle; you don't need your own.

<routed_mentions>
$PREFLIGHT_ROUTED_MENTIONS_JSON
</routed_mentions>
</system-reminder>"
    fi

    PROMPT_BODY=""
    if [ "$AUTO_CLAIM" = true ]; then
        if [ "$PREFLIGHT_OK" = true ]; then
            # Lean per-role prompt body -- DYNAMIC_CONTEXT (above) carries the
            # per-task content; system prompt stays stable for cache hits.
            case $ROLE in
                architect)
                    PROMPT_BODY="Task $PREFLIGHT_TASK_ID is claimed and its full context is above (<claimed_task_context>). If a <routed_mentions> block is present, reply to each tagged message via moe.chat_send FIRST. Read prior knowledge via Serena read_memory on the memory names preloaded in <inbox> (call list_memories only if they don't cover your area). Then study the implementationPlan, rails, and definitionOfDone, and call moe.submit_plan with a complete plan. After submission, poll moe.check_approval. Once approved, use Serena write_memory to record a 'task-$PREFLIGHT_TASK_ID-handoff' note (and any reusable 'decision-<area>' learnings), then moe.wait_for_task to pick up the next PLANNING task. If moe.wait_for_task wakes with hasChatMessage:true, moe.chat_read + moe.chat_send reply BEFORE claiming a new task."
                    ;;
                worker)
                    PROMPT_BODY="Task $PREFLIGHT_TASK_ID is claimed and its full context is above (<claimed_task_context>). If a <routed_mentions> block is present, reply to each tagged message via moe.chat_send FIRST. Read prior knowledge via Serena read_memory on the memory names preloaded in <inbox> (call list_memories only if they don't cover your area). Then execute the approved implementationPlan: call moe.start_step for step 0, implement it (write/edit code, run tests), call moe.complete_step, and repeat through the final step. Then call moe.complete_task. Before waiting for the next task, use Serena write_memory to record a 'task-$PREFLIGHT_TASK_ID-handoff' note plus any non-obvious 'gotcha-<area>' learnings. Finally call moe.wait_for_task. If moe.wait_for_task wakes with hasChatMessage:true, moe.chat_read + moe.chat_send reply BEFORE claiming a new task."
                    ;;
                qa)
                    PROMPT_BODY="Task $PREFLIGHT_TASK_ID is claimed and its full context is above (<claimed_task_context>). If a <routed_mentions> block is present, reply to each tagged message via moe.chat_send FIRST. Read prior knowledge via Serena read_memory on the memory names preloaded in <inbox> (call list_memories only if they don't cover your area). Then verify the implementation against definitionOfDone and rails. Run the tests. If it passes, call moe.qa_approve. If it fails, call moe.qa_reject with a detailed list of issues. Then use Serena write_memory to record a 'task-$PREFLIGHT_TASK_ID-handoff' note (and any 'gotcha-<area>' failure pattern), and call moe.wait_for_task. If moe.wait_for_task wakes with hasChatMessage:true, moe.chat_read + moe.chat_send reply BEFORE claiming a new task."
                    ;;
            esac
            if [ "$PREFLIGHT_IS_RESUME" = true ] && [ -n "$PROMPT_BODY" ]; then
                # A previous CLI session died while holding this task (see the
                # resume path in pre-flight). Tell the fresh session to treat
                # that session's in-flight state as untrusted and finish the job.
                PROMPT_BODY="RESUME: you are workerId $WORKER_ID and you already claimed task $PREFLIGHT_TASK_ID in a previous CLI session that ended before the task was finished. Anything that session left running (background builds, tests, jobs) is DEAD. Do not trust its in-flight claims: re-verify current state from the task context above, the files on disk, and git, then finish the remaining work in THIS session. $PROMPT_BODY"
            fi
        elif [ "$ROLE" = "governor" ]; then
            # Governor: enter_governance was already invoked in the preflight
            # short-circuit. Now subscribe to #governors and #general via
            # chat_wait — never call claim_next_task.
            PROMPT_BODY="You are in governance mode. Read the backlog: moe.chat_channels, find #governors, moe.chat_read it (last 50 messages), then moe.chat_read #general. After catching up, enter the loop: moe.chat_wait with channels=['#governors','#general'] and a long timeout. When it wakes, triage per docs/roles/governor.md (the role doc is appended to your system prompt). Reply via moe.chat_send. Use moe.set_task_status, moe.release_task, moe.propose_rail, or moe.submit_plan_critique when the signal calls for action. On stale-worker alerts: quiet is not dead (long builds/tests are silent) — ping the worker first and NEVER call moe.release_task on idle time alone; release needs a confirmed crash plus the human's nod. Loop forever. Do NOT call moe.claim_next_task."
        elif [ "$PREFLIGHT_NO_TASK" = true ]; then
            PROMPT_BODY="No claimable task right now. Call moe.wait_for_task with statuses=$STATUSES, workerId=\"$WORKER_ID\". When it wakes with hasNext:true, call moe.claim_next_task with the same args, then moe.get_context. If it wakes with hasChatMessage:true, your next calls MUST be moe.chat_read on chatMessage.channel, then moe.chat_send with your reply, THEN moe.wait_for_task again. If it wakes with hasPendingQuestion:true, call moe.chat_read on that task's channel and answer the question. Do not claim a new task while a routed mention is unanswered."
        else
            # Pre-flight was skipped or failed -- fall back to the legacy multi-step prompt
            PROMPT_BODY="First call moe.chat_channels to find #general, then moe.chat_join and moe.chat_send to announce yourself as $ROLE. Then call moe.chat_read to catch up on any unread messages from other agents or human. Then call moe.get_pending_questions to check for unanswered questions. Answer any you find using moe.add_comment. Then use the MCP tool moe.claim_next_task with args $CLAIM_JSON. Do NOT read .moe/ files directly - only use moe.* MCP tools. If hasNext is false, call moe.wait_for_task with the same statuses and workerId. When it returns hasNext:true, call moe.claim_next_task again. If it returns hasChatMessage:true, call moe.chat_read to read and respond, then call moe.wait_for_task again. If it returns hasPendingQuestion:true, call moe.get_pending_questions, answer them with moe.add_comment, then call moe.wait_for_task again. If it returns timedOut:true, call moe.wait_for_task again. After claiming a task and calling moe.get_context, use Serena list_memories / read_memory to pick up prior knowledge for this task/area. Before calling moe.wait_for_task, use Serena write_memory to record a 'task-<id>-handoff' note (and any gotcha-<area> learnings) so the next agent benefits. Keep waiting until you get a task."
        fi
    else
        echo "Suggested first call:"
        echo "  moe.claim_next_task $CLAIM_JSON"
        echo ""
    fi

    # One-shot (--print) sessions exit the moment the model ends its turn,
    # killing any background jobs with the process — and the wrapper loop, not
    # the model, owns claiming the next task. Override the wait_for_task chain
    # baked into the role bodies above and forbid ending the turn "to wait".
    # Governor is excluded: its prompt is a chat_wait loop, not a finish-and-
    # stop task (and governors default to interactive anyway).
    if [ "$CLI_TYPE" = "claude" ] && [ "$CLAUDE_INTERACTIVE" = false ] && [ "$ROLE" != "governor" ] && [ -n "$PROMPT_BODY" ]; then
        PROMPT_BODY="$PROMPT_BODY CRITICAL (one-shot session): this CLI process exits the moment you end your turn, and any background jobs/builds/tests die with it — a completion notification can NEVER arrive after you stop. Run verification in the foreground or poll it to completion. Do NOT call moe.wait_for_task at the end of the task: end your turn once your terminal moe.* call for this task (submit_plan / complete_task / qa_approve / qa_reject / report_blocked) has succeeded — the wrapper respawns a fresh session for the next task."
    fi

    # -------- Pre-flight landing: recovery, baseline, rescue-ref discovery --------
    # Runs once the task id is known and before the CLI starts (fresh claim
    # and resume alike). Gated on settings.autoCommit and on $PROJECT being a
    # git repo (both inside preflight_landing). The notice it produces goes
    # into the dynamic context so the model knows which dirt is not its own.
    if [ "$AUTO_CLAIM" = true ] && [ "$PREFLIGHT_OK" = true ] && [ -n "$PREFLIGHT_TASK_ID" ]; then
        preflight_landing "$PREFLIGHT_TASK_ID" "$PREFLIGHT_TASK_TITLE" "${RESUME_TASK_STATUS:-}" launch || true
        # A recovery landing in there belongs to the PREVIOUS session; this
        # session's own landing is still ahead of us.
        MOE_LANDING_DONE=""
        LAND_SUMMARY_SHA="none"; LAND_SUMMARY_KIND="none"; LAND_SUMMARY_PATHS=0; LAND_SUMMARY_INFERRED=0; LAND_SUMMARY_UNATTR=0; LAND_SUMMARY_OUTCOME=""; LAND_SUMMARY_CODE=""
        if [ -n "$MOE_PREFLIGHT_NOTICE" ]; then
            DYNAMIC_CONTEXT="$DYNAMIC_CONTEXT

<system-reminder>
$MOE_PREFLIGHT_NOTICE
</system-reminder>"
        fi
    fi

    # Compose final PROMPT = DYNAMIC_CONTEXT (per-iteration) + PROMPT_BODY (role).
    # Order: dynamic context first (sets the per-task scene), role body last (latest user instruction).
    if [ -n "$PROMPT_BODY" ]; then
        if [ -n "$DYNAMIC_CONTEXT" ]; then
            PROMPT="$DYNAMIC_CONTEXT

$PROMPT_BODY"
        else
            PROMPT="$PROMPT_BODY"
        fi
    elif [ -n "$DYNAMIC_CONTEXT" ]; then
        PROMPT="$DYNAMIC_CONTEXT"
    else
        PROMPT=""
    fi

    start_heartbeat_sidecar "$WORKER_ID"

    if [ "$CLI_TYPE" = "codex" ]; then
        # Check codex is available
        if ! command -v "$COMMAND_BIN" &> /dev/null; then
            echo -e "${RED}[ERROR]${NC} Codex command not found: $COMMAND_BIN. Install codex CLI first."
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
                architect) ROLE_WORKFLOW="Workflow: join chat → read messages → claim task → get_context → read Serena memory → explore codebase → submit_plan → write Serena memory (handoff + learnings) → announce in chat" ;;
                worker)    ROLE_WORKFLOW="Workflow: join chat → read messages → claim task → read task chat → get_context → read Serena memory → start_step → implement → complete_step → complete_task → write Serena memory (handoff + learnings) → announce in chat" ;;
                qa)        ROLE_WORKFLOW="Workflow: join chat → read messages → claim task → read task chat → get_context → read Serena memory → review code and tests → qa_approve or qa_reject → write Serena memory (handoff + learnings) → announce in chat" ;;
                *)         ROLE_WORKFLOW="Workflow: claim task → get_context → read Serena memory → complete task → write Serena memory handoff" ;;
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
            echo "Command: $COMMAND_BIN ${COMMAND_ARGV[*]} exec -C \"$PROJECT\" --full-auto --sandbox workspace-write \"<prompt>\""
            set +e

            "$COMMAND_BIN" "${COMMAND_ARGV[@]}" exec -C "$PROJECT" --full-auto --sandbox workspace-write "$SHORT_PROMPT"

            CLI_EXIT_CODE=$?

            set -e
        else
            # Interactive TUI mode
            echo "Starting Codex (interactive TUI)..."
            echo ""
            echo "Command: $COMMAND_BIN ${COMMAND_ARGV[*]} -C \"$PROJECT\" \"<prompt>\""
            set +e

            "$COMMAND_BIN" "${COMMAND_ARGV[@]}" -C "$PROJECT" "$SHORT_PROMPT"

            CLI_EXIT_CODE=$?

            set -e
        fi
    elif [ "$CLI_TYPE" = "gemini" ]; then
        # Check gemini is available
        if ! command -v "$COMMAND_BIN" &> /dev/null; then
            echo -e "${RED}[ERROR]${NC} Gemini command not found: $COMMAND_BIN. Install Gemini CLI first (npm install -g @anthropic-ai/gemini-cli or see https://github.com/google-gemini/gemini-cli)."
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
                architect) ROLE_WORKFLOW="Workflow: join chat → read messages → claim task → get_context → read Serena memory → explore codebase → submit_plan → write Serena memory (handoff + learnings) → announce in chat" ;;
                worker)    ROLE_WORKFLOW="Workflow: join chat → read messages → claim task → read task chat → get_context → read Serena memory → start_step → implement → complete_step → complete_task → write Serena memory (handoff + learnings) → announce in chat" ;;
                qa)        ROLE_WORKFLOW="Workflow: join chat → read messages → claim task → read task chat → get_context → read Serena memory → review code and tests → qa_approve or qa_reject → write Serena memory (handoff + learnings) → announce in chat" ;;
                *)         ROLE_WORKFLOW="Workflow: claim task → get_context → read Serena memory → complete task → write Serena memory handoff" ;;
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
            echo "Command: $COMMAND_BIN ${COMMAND_ARGV[*]} --prompt \"<prompt>\" --yolo"
            set +e

            (cd "$PROJECT" && "$COMMAND_BIN" "${COMMAND_ARGV[@]}" --prompt "$SHORT_PROMPT" --yolo)

            CLI_EXIT_CODE=$?

            set -e
        else
            # Interactive mode
            echo "Starting Gemini (interactive)..."
            echo ""
            echo "Command: $COMMAND_BIN ${COMMAND_ARGV[*]} --prompt-interactive \"<prompt>\""
            set +e

            (cd "$PROJECT" && "$COMMAND_BIN" "${COMMAND_ARGV[@]}" --prompt-interactive "$SHORT_PROMPT")

            CLI_EXIT_CODE=$?

            set -e
        fi
    else
        # Enable Claude Code subagents for all Moe roles by default. Architects
        # benefit hugely from Explore-style parallel research; workers fan out
        # test runs; QA spawns a code-reviewer subagent. Opt-out via
        # project.json settings.enableAgentTeams=false.
        unset CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
        if [ "$ENABLE_AGENT_TEAMS" = "true" ]; then
            export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
        fi

        # Write system prompt to a temp file to avoid command-line size/quoting issues
        # (system prompt contains XML tags, backticks, and JSON that can break arg passing)
        SYSTEM_PROMPT_FILE=$(create_secure_temp)/system-prompt.md
        printf '%s' "$SYSTEM_APPEND" > "$SYSTEM_PROMPT_FILE"

        # Token-budget debug: set MOE_DEBUG_PROMPT_SIZE=1 to print final
        # SYSTEM_APPEND size before launching the agent. Used to measure
        # token-cut wins; not on by default.
        if [ "${MOE_DEBUG_PROMPT_SIZE:-}" = "1" ]; then
            PROMPT_BYTES=$(printf '%s' "$SYSTEM_APPEND" | wc -c | tr -d ' ')
            echo -e "${BLUE}[prompt-size]${NC} SYSTEM_APPEND = ${PROMPT_BYTES} bytes ($((PROMPT_BYTES / 4)) tokens approx)"
        fi

        # Only the `claude` CLI honors --model; codex/gemini pick their own.
        MODEL_ARGS=()
        if [ "$CLI_TYPE" = "claude" ] && [ -n "$RESOLVED_MODEL" ]; then
            MODEL_ARGS=(--model "$RESOLVED_MODEL")
        fi

        # Prompt-cache stability. The default Claude Code system prompt bakes
        # in per-launch / per-machine sections (cwd, env info, memory paths,
        # git status) AHEAD of our --append-system-prompt-file content, so
        # the volatile bits sit at the front of the prefix and invalidate the
        # cache on every launch. This flag moves them into the first user
        # message, leaving the stable default system prompt + our role /
        # CLAUDE.md / skills as a contiguous cacheable prefix. Safe with
        # --append-system-prompt-file (only ignored if --system-prompt is
        # set, which we never pass). Opt out via MOE_NO_DYNAMIC_PROMPT_EXCLUDE=1.
        CACHE_ARGS=()
        if [ "$CLI_TYPE" = "claude" ] && [ -z "${MOE_NO_DYNAMIC_PROMPT_EXCLUDE:-}" ]; then
            CACHE_ARGS=(--exclude-dynamic-system-prompt-sections)
        fi

        # Per-task one-shot mode (parity with moe-agent.ps1). --print runs
        # claude non-interactively: the model executes tool calls until it
        # produces an end_turn without a tool call, then the process exits —
        # combined with the polling loop this caps each CLI invocation at one
        # task and resets context (and standards-compliance decay) per task.
        # Workers/QA default to it; architect/governor default to interactive;
        # --interactive / --no-interactive override (see INTERACTIVE above).
        # stream-json + the parser below keep tool activity visible — without
        # it --print is silent for minutes during tool phases, which is
        # indistinguishable from a hang.
        PRINT_ARGS=()
        if [ "$CLI_TYPE" = "claude" ] && [ "$CLAUDE_INTERACTIVE" = false ]; then
            PRINT_ARGS=(--print --permission-mode bypassPermissions --output-format stream-json --include-partial-messages --verbose)
        fi

        # Inline stream-json pretty-printer for --print mode (mirrors the
        # PowerShell launcher's parser): terse per-event lines for init /
        # tool_use / text / rate-limit / result; non-JSON lines pass through.
        # It ALSO harvests the paths the model's editing tools wrote (Edit /
        # Write / MultiEdit / NotebookEdit file_path|notebook_path, the Serena
        # edit tools' relative_path, complete_step.modifiedFiles) into
        # $MOE_TOOL_WRITES_FILE, TOP-relative -- the TOOL tier of the
        # post-flight attribution: a path this session's tools wrote is the
        # session's own even when a peer's plan also names it and even with
        # other workers active. Absolute paths outside the repo are dropped
        # with a WARN. Codex/gemini have no such stream: their TOOL set is
        # empty (documented).
        STREAM_JSON_PARSER=$(cat <<'PYEOF'
import json, os, re, sys
tool_json = ''
tool_name = ''
in_text = False
harvest_path = os.environ.get('MOE_TOOL_WRITES_FILE') or ''
top = (os.environ.get('MOE_GIT_TOP') or '').replace('\\', '/').rstrip('/')
rel = os.environ.get('MOE_GIT_REL') or ''
serena_root = (os.environ.get('MOE_SERENA_PROJECT_ROOT') or '').replace('\\', '/').rstrip('/')
CI = sys.platform in ('win32', 'darwin')
WRITE_TOOLS = ('Edit', 'Write', 'MultiEdit', 'NotebookEdit')
SERENA_TOOLS = ('replace_symbol_body', 'insert_after_symbol', 'insert_before_symbol', 'create_text_file', 'replace_regex')
def w(s):
    sys.stdout.write(s); sys.stdout.flush()
def base_name(n):
    n = n or ''
    return n.split('__')[-1] if n.startswith('mcp__') else n
def to_top_rel(raw):
    if not isinstance(raw, str) or not raw.strip():
        return None
    p = raw.strip().replace('\\', '/')
    if sys.platform == 'win32':
        m = re.match(r'^/([A-Za-z])/(.*)$', p)
        if m:
            p = m.group(1).upper() + ':/' + m.group(2)
    if p.startswith('/') or re.match(r'^[A-Za-z]:/', p):
        if not top:
            return None
        a = p.lower() if CI else p
        t = top.lower() if CI else top
        if not a.startswith(t + '/'):
            return None
        return p[len(top) + 1:]
    while p.startswith('./'):
        p = p[2:]
    if not p or any(seg == '..' for seg in p.split('/')):
        return None
    return rel + p
def harvest(name, inp):
    if not harvest_path or not isinstance(inp, dict):
        return
    n = base_name(name)
    if n in WRITE_TOOLS:
        raws = [inp.get('file_path'), inp.get('notebook_path')]
    elif n in SERENA_TOOLS:
        # Serena resolves relative_path against ITS project root (the
        # serenaProject override can point outside this Moe project): join it
        # there first so the harvest maps the REAL file -- exactly what the
        # ps1 twin's Add-MoeToolWrittenPath does. Absolute results outside the
        # repo are then dropped by to_top_rel with the usual WARN.
        raws = []
        for raw0 in [inp.get('relative_path')]:
            if isinstance(raw0, str) and raw0.strip() and serena_root:
                p0 = raw0.strip().replace('\\', '/')
                if not (p0.startswith('/') or re.match(r'^[A-Za-z]:/', p0)):
                    raw0 = serena_root + '/' + p0
            raws.append(raw0)
    elif n in ('moe_complete_step', 'complete_step'):
        mf = inp.get('modifiedFiles')
        raws = mf if isinstance(mf, list) else []
    else:
        return
    for raw in raws:
        if not isinstance(raw, str) or not raw.strip():
            continue
        r = to_top_rel(raw)
        if r is None:
            w('  [WARN] tool write outside the repo not harvested: %s\n' % raw)
            continue
        try:
            with open(harvest_path, 'a', encoding='utf-8') as fh:
                fh.write(r + '\n')
        except Exception:
            pass
for line in sys.stdin:
    line = line.rstrip('\n')
    if not line.strip():
        continue
    try:
        evt = json.loads(line)
    except Exception:
        w(line + '\n'); continue
    t = evt.get('type')
    if t == 'system' and evt.get('subtype') == 'init':
        w('  [init] %d tools, %d MCP server(s), model=%s\n' % (len(evt.get('tools') or []), len(evt.get('mcp_servers') or []), evt.get('model')))
    elif t == 'stream_event':
        e = evt.get('event') or {}
        et = e.get('type')
        if et == 'content_block_start':
            cb = e.get('content_block') or {}
            if cb.get('type') == 'tool_use':
                tool_json = ''
                tool_name = cb.get('name') or ''
                in_text = False
                w('  -> %s' % cb.get('name'))
            elif cb.get('type') == 'text':
                in_text = True
                w('  ')
            else:
                in_text = False
        elif et == 'content_block_delta':
            d = e.get('delta') or {}
            if d.get('type') == 'text_delta':
                w(d.get('text') or '')
            elif d.get('type') == 'input_json_delta':
                tool_json += d.get('partial_json') or ''
        elif et == 'content_block_stop':
            if tool_json:
                j = tool_json if len(tool_json) <= 140 else tool_json[:140] + '...'
                w(' %s\n' % j)
                try:
                    harvest(tool_name, json.loads(tool_json))
                except Exception:
                    pass
                tool_json = ''
            elif in_text:
                w('\n')
                in_text = False
    elif t == 'assistant':
        # Non-streamed assistant turns carry the full tool_use.input.
        msg = evt.get('message') or {}
        for blk in (msg.get('content') or []):
            if isinstance(blk, dict) and blk.get('type') == 'tool_use':
                try:
                    harvest(blk.get('name'), blk.get('input'))
                except Exception:
                    pass
    elif t == 'rate_limit_event':
        rl = evt.get('rate_limit_info') or {}
        tag = 'OVERAGE' if rl.get('isUsingOverage') else rl.get('status')
        w('  [rate-limit %s %s]\n' % (tag, rl.get('rateLimitType')))
    elif t == 'result':
        dur = evt.get('duration_ms')
        dur_s = ('%.1fs' % (dur / 1000.0)) if dur else '?'
        w('  [result] turns=%s dur=%s stop=%s\n' % (evt.get('num_turns'), dur_s, evt.get('stop_reason')))
PYEOF
)

        # No-task fast path (parity with moe-agent.ps1): when the pre-flight
        # reports no claimable task, skip launching the CLI entirely. The
        # outer polling loop will sleep POLL_INTERVAL seconds and retry
        # pre-flight. Avoids paying for a CLI session whose only job would be
        # to call moe.wait_for_task.
        #
        # Governor is excluded: governors never claim tasks (PREFLIGHT_NO_TASK
        # is synthesized true on every iteration), but they DO need an
        # interactive Claude session so the human can drive governance
        # decisions. Skipping the launch would leave the governor terminal
        # dead. The interactive TUI is likewise never skipped -- the operator
        # owns that session; only the one-shot --print mode is skippable.
        #
        # Gated on LOOP_ENABLED: with --no-loop (or --poll-interval 0) there is
        # no next iteration -- skipping would print "will poll again" and then
        # exit without ever launching, a silent no-op. Single-shot runs must
        # still launch the CLI, which parks in moe.wait_for_task.
        #
        # Gated on routed mentions: pre-flight chat_read already consumed the
        # unread messages and baked @mentions into the prompt; skipping the
        # launch would discard them permanently. If anything tagged this
        # worker, launch so the CLI can reply.
        LAUNCH_SKIPPED=false
        if [ "$AUTO_CLAIM" = true ] && [ "$PREFLIGHT_NO_TASK" = true ] && [ "$ROLE" != "governor" ] && [ "$CLAUDE_INTERACTIVE" = false ] \
            && [ "$LOOP_ENABLED" = true ] && [ "${PREFLIGHT_ROUTED_MENTIONS_COUNT:-0}" -eq 0 ] 2>/dev/null; then
            echo "[no-task] Skipping CLI launch -- wrapper will poll again in ${POLL_INTERVAL} s."
            CLI_EXIT_CODE=0
            LAUNCH_SKIPPED=true
        fi

        if [ "$LAUNCH_SKIPPED" = true ]; then
            : # CLI spawn skipped this iteration; post-flight + loop continue below.
        elif [ "$AUTO_CLAIM" = true ]; then
            if [ ${#PRINT_ARGS[@]} -gt 0 ]; then
                echo "Starting ${CLI_TYPE} with auto-claim (one-shot --print)..."
            else
                echo "Starting ${CLI_TYPE} with auto-claim (interactive TUI)..."
            fi
            echo ""
            set +e

            if [ ${#PRINT_ARGS[@]} -gt 0 ]; then
                # Pipe through the parser; the subshell's exit (the CLI's) is
                # PIPESTATUS[0] — the parser's own status is irrelevant.
                (cd "$PROJECT" && "$COMMAND_BIN" "${COMMAND_ARGV[@]}" "${MODEL_ARGS[@]}" --append-system-prompt-file "$SYSTEM_PROMPT_FILE" "${CACHE_ARGS[@]}" --effort max "${PRINT_ARGS[@]}" "$PROMPT" 2>&1) | MOE_TOOL_WRITES_FILE="$MOE_TOOL_WRITES_FILE" MOE_GIT_TOP="$MOE_TOP" MOE_GIT_REL="$MOE_REL" MOE_SERENA_PROJECT_ROOT="${SERENA_PROJECT:-$PROJECT}" $PYTHON_CMD -u -c "$STREAM_JSON_PARSER"
                CLI_EXIT_CODE=${PIPESTATUS[0]}
            else
                (cd "$PROJECT" && "$COMMAND_BIN" "${COMMAND_ARGV[@]}" "${MODEL_ARGS[@]}" --append-system-prompt-file "$SYSTEM_PROMPT_FILE" "${CACHE_ARGS[@]}" --effort max "$PROMPT")
                CLI_EXIT_CODE=$?
            fi

            set -e
        else
            set +e

            if [ ${#PRINT_ARGS[@]} -gt 0 ]; then
                (cd "$PROJECT" && "$COMMAND_BIN" "${COMMAND_ARGV[@]}" "${MODEL_ARGS[@]}" --append-system-prompt-file "$SYSTEM_PROMPT_FILE" "${CACHE_ARGS[@]}" --effort max "${PRINT_ARGS[@]}" 2>&1) | MOE_TOOL_WRITES_FILE="$MOE_TOOL_WRITES_FILE" MOE_GIT_TOP="$MOE_TOP" MOE_GIT_REL="$MOE_REL" MOE_SERENA_PROJECT_ROOT="${SERENA_PROJECT:-$PROJECT}" $PYTHON_CMD -u -c "$STREAM_JSON_PARSER"
                CLI_EXIT_CODE=${PIPESTATUS[0]}
            else
                (cd "$PROJECT" && "$COMMAND_BIN" "${COMMAND_ARGV[@]}" "${MODEL_ARGS[@]}" --append-system-prompt-file "$SYSTEM_PROMPT_FILE" "${CACHE_ARGS[@]}" --effort max)
                CLI_EXIT_CODE=$?
            fi

            set -e
        fi
    fi

    stop_heartbeat_sidecar

    # -------- Post-flight: shutdown rituals after CLI exits --------
    # Dirty snapshot FIRST: after the CLI exits and before any daemon RPC, so
    # the blobs the attribution compares are exactly what the session left.
    POSTFLIGHT_SNAPSHOT=""
    if [ "$AUTO_CLAIM" = true ] && [ -n "$PREFLIGHT_TASK_ID" ] && [ "$CS_AUTO_COMMIT" = "true" ] && [ -n "$MOE_TOP" ]; then
        POSTFLIGHT_SNAPSHOT="$(create_secure_temp)/S-post-$$.tsv"
        git_dirty_snapshot "$POSTFLIGHT_SNAPSHOT" || POSTFLIGHT_SNAPSHOT=""
    fi
    # The session-ended chat line (post_flight) runs AFTER the landing now so
    # it can carry commit=<sha> kind=<k> paths=<n> -- see the end of the block.
    POSTFLIGHT_BREAK=false

    if [ "$AUTO_CLAIM" = true ] && [ -n "$PREFLIGHT_TASK_ID" ]; then
        # Check task's final status and reopenCount (agent may have completed,
        # paused, or bailed; reopenCount drives commit-message wording below).
        # Resolve the status by EXACT task id. This used to be an unscoped
        # `list_tasks '{}'` filtered client-side, which the daemon caps at
        # DEFAULT_TASK_LIST_LIMIT (100) -- so once the project outgrew one page
        # the completed task simply wasn't in the rows, FINAL_STATUS stayed
        # empty, the REVIEW guard below was false, and the ENTIRE auto-commit
        # block (including every diagnostic in it) was skipped with no output.
        # get_context keys on the task id and cannot be paginated away.
        # Do NOT "fix" this by raising the limit: MAX_TASK_LIST_LIMIT is 500,
        # which only moves the same silent cliff further out.
        POSTFLIGHT_CTX=$(moe_rpc get_context \
            "$($PYTHON_CMD -c "import json,sys; print(json.dumps({'taskId':sys.argv[1]}))" "$PREFLIGHT_TASK_ID" 2>/dev/null)" \
            2>/dev/null || echo "")
        FINAL_STATUS=""
        FINAL_REOPEN_COUNT="0"
        IS_EPIC_FINAL="true"
        TASK_EPIC_ID=""
        STATUS_LOOKUP_ERROR=""
        PARSED_POSTFLIGHT=""
        if [ -n "$POSTFLIGHT_CTX" ]; then
            # getContext.ts falls back to the CALLER's currentTaskId when the
            # requested id resolves to nothing (deleted/archived/wrong project),
            # and moe-proxy injects MOE_WORKER_ID on every call -- so a stale id
            # comes back as some OTHER task's status. Committing on that would be
            # worse than not committing at all, hence the id equality check.
            # The task projection carries no epicId/order, but get_context
            # returns the resolved epic alongside it.
            PARSED_POSTFLIGHT=$($PYTHON_CMD -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    t = d.get('task') or {}
    e = d.get('epic') or {}
    if not t.get('id'):
        sys.stdout.write('NOTASK\x1f\x1f\x1f\x1f')
    elif t.get('id') != sys.argv[1]:
        sys.stdout.write('MISMATCH\x1f' + str(t.get('id')) + '\x1f\x1f\x1f')
    else:
        # \x1f-separated so we don't collide with whitespace in fields
        # (NOT NUL: command substitution strips NUL bytes).
        # isEpicFinal: newer daemons compute epic-final board-side and serve
        # it in get_context (task-level, else top-level). Serialize only an
        # exact JSON boolean; anything else stays '' = absent (old daemon).
        ief = t.get('isEpicFinal')
        if ief is None:
            ief = d.get('isEpicFinal')
        ief_s = 'true' if ief is True else ('false' if ief is False else '')
        sys.stdout.write(
            'OK\x1f'
            + (t.get('status') or '') + '\x1f'
            + str(t.get('reopenCount') or 0) + '\x1f'
            + (e.get('id') or '') + '\x1f'
            + ief_s + '\x1f'
        )
except Exception:
    pass
" "$PREFLIGHT_TASK_ID" <<< "$POSTFLIGHT_CTX" 2>/dev/null || echo "")
        fi
        LOOKUP_OUTCOME=""
        LOOKUP_DETAIL=""
        DAEMON_IS_EPIC_FINAL=""
        if [ -n "$PARSED_POSTFLIGHT" ]; then
            { IFS= read -r -d $'\x1f' LOOKUP_OUTCOME
              IFS= read -r -d $'\x1f' LOOKUP_DETAIL
              IFS= read -r -d $'\x1f' FINAL_REOPEN_COUNT
              IFS= read -r -d $'\x1f' TASK_EPIC_ID
              IFS= read -r -d $'\x1f' DAEMON_IS_EPIC_FINAL
            } <<< "$PARSED_POSTFLIGHT" 2>/dev/null || true
        fi
        case "${LOOKUP_OUTCOME:-}" in
            OK)
                FINAL_STATUS="${LOOKUP_DETAIL:-}"
                FINAL_REOPEN_COUNT="${FINAL_REOPEN_COUNT:-0}"
                TASK_EPIC_ID="${TASK_EPIC_ID:-}"
                ;;
            MISMATCH)
                STATUS_LOOKUP_ERROR="get_context resolved a different task (${LOOKUP_DETAIL:-?}) -- the requested id no longer exists"
                DAEMON_IS_EPIC_FINAL=""
                ;;
            *)
                # The RPC failed, returned nothing, or carried no task. That is
                # NOT the same as "the task isn't in REVIEW" -- see below.
                STATUS_LOOKUP_ERROR="get_context returned no task"
                DAEMON_IS_EPIC_FINAL=""
                ;;
        esac
        FINAL_REOPEN_COUNT="${FINAL_REOPEN_COUNT:-0}"
        # Epic-final = highest 'order' among this epic's tasks (ties count).
        # Drives the qualityGate scope: the epic's integration-and-hardening
        # task owns the full gate; mid-epic tasks stay lean. Newer daemons
        # compute the same rule board-side and serve it as get_context
        # isEpicFinal -- prefer that value (and skip the sibling RPC); the
        # list_tasks+python fallback below stays for old daemons that don't
        # serve the field. Missing epicId or unparsable orders default to
        # final (gate on the safe side). The fallback asks epic-SCOPED: one
        # epic's siblings is a legitimately bounded collection, unlike the
        # whole project, so a limit is safe here -- and the page is
        # guaranteed to contain this task, so it also supplies MY_ORDER.
        if [ "$DAEMON_IS_EPIC_FINAL" = "true" ] || [ "$DAEMON_IS_EPIC_FINAL" = "false" ]; then
            IS_EPIC_FINAL="$DAEMON_IS_EPIC_FINAL"
        elif [ -z "$STATUS_LOOKUP_ERROR" ] && [ -n "$TASK_EPIC_ID" ]; then
            SIBLING_STATE=$(moe_rpc list_tasks \
                "$($PYTHON_CMD -c "import json,sys; print(json.dumps({'epicId':sys.argv[1],'limit':500}))" "$TASK_EPIC_ID" 2>/dev/null)" \
                2>/dev/null || echo "")
            if [ -n "$SIBLING_STATE" ]; then
                IS_EPIC_FINAL=$($PYTHON_CMD -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    tasks = d.get('tasks', [])
    my_order = 0.0
    for s in tasks:
        if s.get('id') == sys.argv[1]:
            my_order = float(s.get('order') or 0)
            break
    sibling_max = max(
        (float(s.get('order') or 0) for s in tasks),
        default=my_order,
    )
    print('true' if my_order >= sibling_max else 'false')
except Exception:
    print('true')
" "$PREFLIGHT_TASK_ID" <<< "$SIBLING_STATE" 2>/dev/null || echo "true")
            fi
        fi
        IS_EPIC_FINAL="${IS_EPIC_FINAL:-true}"
        # A lookup that FAILED and a task that genuinely isn't in REVIEW are two
        # different things, and collapsing them into one silent no-op is what
        # made this defect invisible. A real non-REVIEW status stays quiet (the
        # agent simply didn't finish); an unresolved status is loud on stdout
        # AND in chat. Best-effort throughout: it must never abort the loop.
        if [ -n "$STATUS_LOOKUP_ERROR" ]; then
            echo -e "${YELLOW}[WARN]${NC} post-flight status lookup failed for task $PREFLIGHT_TASK_ID: $STATUS_LOOKUP_ERROR. Cannot tell whether it reached REVIEW, so auto-commit+push is being skipped -- check the working tree and commit manually."
            if [ -n "${GENERAL_CHANNEL_ID:-}" ]; then
                moe_rpc chat_send \
                    "$($PYTHON_CMD -c "import json,sys; print(json.dumps({'channel':sys.argv[1],'workerId':sys.argv[2],'content':sys.argv[3]}))" \
                        "$GENERAL_CHANNEL_ID" "$WORKER_ID" \
                        "PUSH-BLOCKED: post-flight status lookup failed for task $PREFLIGHT_TASK_ID ($STATUS_LOOKUP_ERROR); auto-commit skipped and the work may be sitting uncommitted" 2>/dev/null)" \
                    > /dev/null 2>&1 || true
            fi
        fi

        # -------- Landing: every exit path lands (land-on-every-exit) --------
        # Mode selection replaces the old `worker && REVIEW` guard. That guard
        # let every non-REVIEW exit (BLOCKED, WORKING after a CLI death, a
        # PLANNING flip, the DONE race with QA), every architect/qa session and
        # every Ctrl+C leave the session's edits dirty in the shared tree, where
        # the next session found them as foreign debris (measured: the moe-next
        # stranded sources). Now:
        #   autoCommit=false    -> none (logged, no longer silent; the master
        #                          switch also disables the UNKNOWN checkpoint)
        #   statusLookupError   -> checkpoint status=UNKNOWN (the task id is
        #                          certain; only its status is not)
        #   worker + REVIEW|DONE -> completion (DONE = QA raced ahead)
        #   worker|architect|qa + checkpointCommits -> checkpoint
        # Commits use whatever git identity the user has configured -- no
        # Claude/Codex attribution. Everything is best-effort: a failure logs
        # and parks the bytes on a rescue ref, it never aborts the loop.
        LANDING_MODE="none"
        LANDING_STATUS=""
        if [ "$CS_AUTO_COMMIT" != "true" ]; then
            echo -e "${BLUE}[info]${NC} settings.autoCommit=false -- no git activity for task $PREFLIGHT_TASK_ID (no completion, checkpoint or rescue); baseline deleted."
            baseline_delete "$PREFLIGHT_TASK_ID"
        elif [ -n "$STATUS_LOOKUP_ERROR" ]; then
            LANDING_MODE="checkpoint"
            LANDING_STATUS="UNKNOWN"
        elif [ "$ROLE" = "worker" ] && { [ "$FINAL_STATUS" = "REVIEW" ] || [ "$FINAL_STATUS" = "DONE" ]; }; then
            LANDING_MODE="completion"
            LANDING_STATUS="$FINAL_STATUS"
        elif { [ "$ROLE" = "worker" ] || [ "$ROLE" = "architect" ] || [ "$ROLE" = "qa" ]; } \
            && [ "$CS_CHECKPOINT_COMMITS" = "true" ] && [ "${MOE_DISABLE_CHECKPOINT:-0}" != "1" ]; then
            LANDING_MODE="checkpoint"
            LANDING_STATUS="${FINAL_STATUS:-UNKNOWN}"
        else
            echo -e "${BLUE}[info]${NC} no landing for task $PREFLIGHT_TASK_ID (role=$ROLE status=${FINAL_STATUS:-?} checkpointCommits=$CS_CHECKPOINT_COMMITS MOE_DISABLE_CHECKPOINT=${MOE_DISABLE_CHECKPOINT:-0})."
            # A DELIBERATE no-landing exit (checkpointCommits=false / a role
            # with no landing) must not arm the recovery checkpoint: mark the
            # baseline landed so the next pre-flight does not land this
            # session's edits as a wip(...) recovered commit the operator
            # turned off. Same as the ps1 twin's Set-MoeBaselineLanded.
            if [ -n "$MOE_TOP" ] || git_top; then
                baseline_mark_landed "$PREFLIGHT_TASK_ID"
            fi
        fi
        if [ "$LANDING_MODE" != "none" ]; then
            if [ -z "$MOE_TOP" ] && ! git_top; then
                echo -e "${YELLOW}[info]${NC} $PROJECT is not a git repo -- skipping auto-commit+push."
            else
                echo -e "${BLUE}Post-flight: auto-commit+push (settings.autoCommit=true, mode=$LANDING_MODE, status=$LANDING_STATUS)...${NC}"
                GATE_FAILED=false
                GATE_RC=0
                GATE_OUT=""
                QUALITY_GATE=""
                QUALITY_GATE_SCOPE="epicFinal"
                if [ "$LANDING_MODE" = "completion" ]; then
                    # Quality gate: settings.qualityGate is an optional shell
                    # command (lint/typecheck/tests) that must pass before the
                    # post-flight may commit+push a completion. The task already
                    # flipped to REVIEW, so a failing gate can't un-transition
                    # it -- it blocks the ship instead: the session's edits go
                    # to a rescue ref (never a branch commit, never pushed), a
                    # loud announce (chat + task comment with the output tail so
                    # QA rejects with evidence), and the worker loop hard-stops
                    # so the failed tree is handled by a human, not absorbed by
                    # the next task. Opt out per-run via MOE_DISABLE_QUALITY_GATE=1.
                    if [ "${MOE_DISABLE_QUALITY_GATE:-0}" != "1" ]; then
                        QUALITY_GATE=$($PYTHON_CMD -c "
import json, os, sys
p = os.path.join(sys.argv[1], 'project.json')
try:
    d = json.load(open(p))
    v = (d.get('settings') or {}).get('qualityGate')
    print(v.strip() if isinstance(v, str) else '')
except Exception:
    print('')
" "$MOE_DIR" 2>/dev/null || echo "")
                        QUALITY_GATE_SCOPE=$($PYTHON_CMD -c "
import json, os, sys
p = os.path.join(sys.argv[1], 'project.json')
try:
    d = json.load(open(p))
    v = (d.get('settings') or {}).get('qualityGateScope')
    print(v if v in ('epicFinal', 'everyTask') else 'epicFinal')
except Exception:
    print('epicFinal')
" "$MOE_DIR" 2>/dev/null || echo "epicFinal")
                    fi
                    # The full gate is deliberately NOT per-task: verification is
                    # concentrated on the epic's final integration-and-hardening
                    # task (same doctrine as the skills). Mid-epic tasks already
                    # carry their narrow plan-named verification via complete_task.
                    if [ -n "$QUALITY_GATE" ] && [ "$QUALITY_GATE_SCOPE" = "epicFinal" ] && [ "$IS_EPIC_FINAL" != "true" ]; then
                        echo -e "${BLUE}[info]${NC} qualityGate deferred: task $PREFLIGHT_TASK_ID is mid-epic (scope=epicFinal; the epic-final task runs the full gate)."
                        QUALITY_GATE=""
                    fi
                    if [ -n "$QUALITY_GATE" ]; then
                        echo -e "${BLUE}Post-flight: quality gate: $QUALITY_GATE${NC}"
                        # Capture output AND exit code separately so `set -e`
                        # can't abort on a failing gate.
                        if GATE_OUT=$(cd "$PROJECT" && bash -c "$QUALITY_GATE" 2>&1); then
                            GATE_RC=0
                        else
                            GATE_RC=$?
                        fi
                        if [ "$GATE_RC" -ne 0 ]; then
                            echo "$GATE_OUT" | tail -15
                            echo -e "${YELLOW}[WARN]${NC} qualityGate failed (exit $GATE_RC); skipping commit+push for task $PREFLIGHT_TASK_ID."
                            echo -e "${YELLOW}[WARN]${NC} task $PREFLIGHT_TASK_ID will be parked on a rescue ref (never a branch commit) -- stopping the worker loop after the rescue so the failed tree can't be absorbed by a later task."
                            GATE_FAILED=true
                        else
                            echo -e "${GREEN}[OK]${NC} qualityGate passed."
                        fi
                    fi
                fi
                LAND_KIND="$LANDING_MODE"
                LAND_TASK_ID="$PREFLIGHT_TASK_ID"
                LAND_TITLE="$PREFLIGHT_TASK_TITLE"
                LAND_STATUS="$LANDING_STATUS"
                LAND_REOPEN="${FINAL_REOPEN_COUNT:-0}"
                LAND_CLI_EXIT="${CLI_EXIT_CODE:-0}"
                LAND_RECOVERED=false
                LAND_GATE_FAILED="$GATE_FAILED"
                LAND_POLICY_OVERRIDE=""
                LAND_SNAPSHOT_FILE="$POSTFLIGHT_SNAPSHOT"
                LAND_TOOL_FILE="$MOE_TOOL_WRITES_FILE"
                LAND_SCOPE_FILE=""
                # A gate that ran may have rewritten files (formatters): the
                # pre-gate snapshot would then drop every touched path as
                # MOE_ATTR_CONCURRENT, so re-snapshot after it.
                if [ -n "$QUALITY_GATE" ]; then
                    LAND_SNAPSHOT_FILE=""
                fi
                if run_landing; then LAND_RC=0; else LAND_RC=$?; fi
                if [ "$GATE_FAILED" = true ]; then
                    announce_gate_failure "$PREFLIGHT_TASK_ID" "$QUALITY_GATE" "$GATE_RC" "$GATE_OUT"
                    echo -e "${YELLOW}[WARN]${NC} task $PREFLIGHT_TASK_ID parked on ${LAND_RESCUE_REF:-no rescue ref (nothing to rescue)} -- stopping the worker loop."
                    POSTFLIGHT_BREAK=true
                elif [ "$LAND_RC" -eq 3 ]; then
                    # Could not peel off main/master/detached: the bytes are on
                    # the rescue ref; hard-stop in BOTH modes (and both
                    # wrappers) so nothing later can sweep the tree.
                    # No PUSH FAILED chat here (nothing was committed): the
                    # MOE_RESCUE_REF chat line + the daemon's #governors alert
                    # from record_commit{outcome:failed} carry the signal —
                    # identical to the ps1 twin.
                    echo -e "${YELLOW}[WARN]${NC} task $PREFLIGHT_TASK_ID could not be landed on a safe branch; its edits are parked on ${LAND_RESCUE_REF:-no rescue ref (nothing to rescue)} -- stopping the worker loop."
                    POSTFLIGHT_BREAK=true
                fi
            fi
        fi
        # Whatever happened above, this session's bytes have been handled
        # (committed, parked on a rescue ref, refused, nothing to land, or a
        # deliberate policy skip): the teardown rescue in the EXIT trap must
        # not run a second pass. Same as the ps1 twin's unconditional
        # $moeLandingDone after its landing selection.
        MOE_LANDING_DONE=true
    fi
    # Session-ended chat line (carries commit=<sha|none> kind=<k> paths=<n>).
    # Best-effort -- any RPC failure does not block loop continuation.
    post_flight || true
    if [ "$POSTFLIGHT_BREAK" = true ]; then
        break
    fi
    # -------- End post-flight --------

    if [ "$LOOP_ENABLED" = false ]; then
        break
    fi
done
