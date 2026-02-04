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
            echo "  -c, --command CMD        Claude command (default: claude)"
            echo "  -l, --list-projects      List registered projects"
            echo "  --no-start-daemon        Don't auto-start daemon"
            echo "  --no-auto-claim          Don't auto-claim a task on start"
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
        echo "$registry" | python3 -c "
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
        PROJECT=$(echo "$registry" | python3 -c "
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

# Resolve to absolute path
PROJECT=$(cd "$PROJECT" 2>/dev/null && pwd || echo "$PROJECT")
if [ ! -d "$PROJECT" ]; then
    echo -e "${RED}Project path not found: $PROJECT${NC}"
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
    WORKER_ID="$ROLE"
fi
export MOE_WORKER_ID="$WORKER_ID"

# Start daemon if needed
if [ "$NO_START_DAEMON" = false ]; then
    DAEMON_INFO="$MOE_DIR/daemon.json"
    RUNNING=false

    if [ -f "$DAEMON_INFO" ]; then
        PID=$(python3 -c "import json; print(json.load(open('$DAEMON_INFO')).get('pid', ''))" 2>/dev/null || echo "")
        if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
            RUNNING=true
        fi
    fi

    if [ "$RUNNING" = false ]; then
        echo -e "${YELLOW}Starting Moe daemon...${NC}"

        # Find daemon script
        if command -v moe-daemon &> /dev/null; then
            DAEMON_CMD="moe-daemon"
        else
            DAEMON_SCRIPT="$ROOT_DIR/packages/moe-daemon/dist/index.js"
            if [ ! -f "$DAEMON_SCRIPT" ]; then
                echo -e "${RED}Daemon not found. Run install-mac.sh first.${NC}"
                exit 1
            fi
            DAEMON_CMD="node $DAEMON_SCRIPT"
        fi

        # Start daemon in background
        $DAEMON_CMD start --project "$PROJECT" &
        sleep 1
        echo -e "${GREEN}[OK]${NC} Daemon started"
    else
        echo -e "${GREEN}[OK]${NC} Daemon already running"
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
echo -e "${BLUE}================================${NC}"
echo ""

# Build claim command
CLAIM_JSON="{\"statuses\":$STATUSES,\"workerId\":\"$WORKER_ID\"}"

if [ "$AUTO_CLAIM" = true ]; then
    SYSTEM_APPEND="Role: $ROLE. Always use Moe MCP tools. Start by claiming the next task for your role."
    PROMPT="Call moe.claim_next_task $CLAIM_JSON. If hasNext is false, say: 'No tasks in $ROLE queue' and wait."

    echo "Starting Claude with auto-claim..."
    echo ""

    $COMMAND --append-system-prompt "$SYSTEM_APPEND" "$PROMPT"
else
    echo "Suggested first call:"
    echo "  moe.claim_next_task $CLAIM_JSON"
    echo ""

    $COMMAND
fi
