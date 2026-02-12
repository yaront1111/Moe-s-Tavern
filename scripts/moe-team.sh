#!/bin/bash
# Moe Agent Team Launcher for Mac/Linux
# Launches worker, qa, and architect agents in separate terminal windows

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Defaults
PROJECT=""
PROJECT_NAME=""
DELAY_BETWEEN=1
TEAM=""
NO_TEAM=false
NO_WORKER=false
NO_QA=false
NO_ARCHITECT=false
TERMINAL=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -p|--project)
            PROJECT="$2"
            shift 2
            ;;
        -n|--project-name)
            PROJECT_NAME="$2"
            shift 2
            ;;
        -d|--delay)
            DELAY_BETWEEN="$2"
            shift 2
            ;;
        --team)
            TEAM="$2"
            shift 2
            ;;
        --no-team)
            NO_TEAM=true
            shift
            ;;
        --no-worker)
            NO_WORKER=true
            shift
            ;;
        --no-qa)
            NO_QA=true
            shift
            ;;
        --no-architect)
            NO_ARCHITECT=true
            shift
            ;;
        -t|--terminal)
            TERMINAL="$2"
            shift 2
            ;;
        --help|-h)
            echo "Moe Agent Team Launcher"
            echo ""
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  -p, --project PATH       Project path"
            echo "  -n, --project-name NAME  Project name from registry"
            echo "  -d, --delay SECONDS      Delay between agent launches (default: 1)"
            echo "  --team NAME              Team name for agents (default: project folder name)"
            echo "  --no-team                Disable team mode"
            echo "  --no-worker              Don't start worker agent"
            echo "  --no-qa                  Don't start QA agent"
            echo "  --no-architect           Don't start architect agent"
            echo "  -t, --terminal TERM      Terminal to use (auto-detected)"
            echo "                           Options: gnome-terminal, konsole, xterm,"
            echo "                           iTerm, Terminal.app, tmux"
            echo "  --help, -h               Show this help"
            echo ""
            echo "Examples:"
            echo "  $0 --project ~/myproject"
            echo "  $0 -n myproject --no-architect"
            echo "  $0 -p . --terminal tmux"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

# Validate project argument
if [ -z "$PROJECT" ] && [ -z "$PROJECT_NAME" ]; then
    echo -e "${RED}Error: Provide --project or --project-name${NC}"
    exit 1
fi

resolve_team_name() {
    local team=""
    if [ -n "$PROJECT" ]; then
        local resolved=""
        resolved=$(cd "$PROJECT" 2>/dev/null && pwd || true)
        if [ -n "$resolved" ]; then
            team=$(basename "$resolved")
        else
            team=$(basename "$PROJECT")
        fi
    elif [ -n "$PROJECT_NAME" ]; then
        local registry_file="$HOME/.moe/projects.json"
        if [ -f "$registry_file" ] && command -v python3 >/dev/null 2>&1; then
            local path
            path=$(PROJECT_NAME="$PROJECT_NAME" REGISTRY_FILE="$registry_file" python3 - <<'PY'
import json
import os

name = os.environ.get("PROJECT_NAME", "")
registry_file = os.environ.get("REGISTRY_FILE", "")
path = ""
try:
    with open(registry_file, "r", encoding="utf-8") as f:
        data = json.load(f)
    for entry in data:
        if entry.get("name") == name:
            path = entry.get("path", "")
            break
except Exception:
    path = ""

if path:
    print(path)
PY
)
            if [ -n "$path" ]; then
                team=$(basename "$path")
            fi
        fi
    fi

    if [ -z "$team" ]; then
        team="Moe Team"
    fi
    echo "$team"
}

# Build project argument for moe-agent.sh (shell-escaped to handle special chars)
if [ -n "$PROJECT" ]; then
    PROJECT_ARG="--project $(printf '%q' "$PROJECT")"
else
    PROJECT_ARG="--project-name $(printf '%q' "$PROJECT_NAME")"
fi
if [ "$NO_TEAM" = true ]; then
    TEAM_ARG=""
else
    if [ -z "$TEAM" ]; then
        TEAM=$(resolve_team_name)
    fi
    TEAM_ARG="--team $(printf '%q' "$TEAM")"
fi

# Auto-detect terminal emulator
detect_terminal() {
    if [ -n "$TERMINAL" ]; then
        echo "$TERMINAL"
        return
    fi

    # macOS
    if [[ "$OSTYPE" == "darwin"* ]]; then
        if [ -d "/Applications/iTerm.app" ]; then
            echo "iterm"
        else
            echo "terminal.app"
        fi
        return
    fi

    # Linux - check common terminals
    if command -v gnome-terminal &> /dev/null; then
        echo "gnome-terminal"
    elif command -v konsole &> /dev/null; then
        echo "konsole"
    elif command -v xfce4-terminal &> /dev/null; then
        echo "xfce4-terminal"
    elif command -v xterm &> /dev/null; then
        echo "xterm"
    elif [ -n "$TMUX" ]; then
        echo "tmux"
    else
        echo "background"
    fi
}

# Launch agent in new terminal window
launch_agent() {
    local role="$1"
    local color="$2"
    local terminal=$(detect_terminal)
    local safe_script_dir
    safe_script_dir=$(printf '%q' "$SCRIPT_DIR")
    local cmd="$safe_script_dir/moe-agent.sh --role $role $PROJECT_ARG $TEAM_ARG"

    echo -e "${color}Starting $role agent...${NC}"

    case "$terminal" in
        gnome-terminal)
            gnome-terminal --title="Moe $role" -- bash -c "$cmd; exec bash"
            ;;
        konsole)
            konsole --new-tab -e bash -c "$cmd; exec bash" &
            ;;
        xfce4-terminal)
            xfce4-terminal --title="Moe $role" -e "bash -c '$cmd; exec bash'" &
            ;;
        xterm)
            xterm -title "Moe $role" -e "bash -c '$cmd; exec bash'" &
            ;;
        iterm)
            osascript <<EOF
tell application "iTerm"
    create window with default profile
    tell current session of current window
        write text "cd $safe_script_dir && $cmd"
    end tell
end tell
EOF
            ;;
        terminal.app)
            osascript <<EOF
tell application "Terminal"
    do script "cd $safe_script_dir && $cmd"
    activate
end tell
EOF
            ;;
        tmux)
            tmux new-window -n "moe-$role" "$cmd"
            ;;
        background)
            echo -e "${YELLOW}No terminal found, running in background${NC}"
            nohup bash -c "$cmd" > "/tmp/moe-$role.log" 2>&1 &
            echo "  PID: $!, Log: /tmp/moe-$role.log"
            ;;
    esac
}

echo -e "${CYAN}=== Moe Agent Team Launcher ===${NC}"
echo "Delay between windows: ${DELAY_BETWEEN}s"
echo "Terminal: $(detect_terminal)"
echo ""

LAUNCHED=0

# Launch Worker
if [ "$NO_WORKER" = false ]; then
    launch_agent "worker" "$GREEN"
    LAUNCHED=$((LAUNCHED + 1))

    if [ "$NO_QA" = false ] || [ "$NO_ARCHITECT" = false ]; then
        echo -e "${BLUE}Waiting ${DELAY_BETWEEN}s before next agent...${NC}"
        sleep "$DELAY_BETWEEN"
    fi
fi

# Launch QA
if [ "$NO_QA" = false ]; then
    launch_agent "qa" "$YELLOW"
    LAUNCHED=$((LAUNCHED + 1))

    if [ "$NO_ARCHITECT" = false ]; then
        echo -e "${BLUE}Waiting ${DELAY_BETWEEN}s before next agent...${NC}"
        sleep "$DELAY_BETWEEN"
    fi
fi

# Launch Architect
if [ "$NO_ARCHITECT" = false ]; then
    launch_agent "architect" "$MAGENTA"
    LAUNCHED=$((LAUNCHED + 1))
fi

echo ""
echo -e "${CYAN}Launched $LAUNCHED agent(s)${NC}"
