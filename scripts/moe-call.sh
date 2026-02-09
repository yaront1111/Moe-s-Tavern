#!/usr/bin/env bash
# moe-call.sh - CLI helper for calling Moe daemon tools via the proxy
# Usage: moe-call.sh <tool_name> [json_arguments] [--project <path>]
#
# Examples:
#   moe-call.sh claim_next_task '{"statuses":["PLANNING"],"workerId":"architect-abc"}'
#   moe-call.sh get_context '{"workerId":"worker-1234"}'
#   moe-call.sh list_tasks '{"statuses":["BACKLOG","PLANNING"]}'
#   moe-call.sh submit_plan '{"taskId":"task-xxx","plan":[...]}'
#   moe-call.sh wait_for_task '{"statuses":["PLANNING"],"workerId":"architect-abc","timeoutMs":300000}'
#   moe-call.sh add_comment '{"taskId":"task-xxx","content":"my question","workerId":"architect-abc"}'

set -euo pipefail

TOOL_NAME=""
TOOL_ARGS="{}"
PROJECT=""

# Parse arguments
while [ $# -gt 0 ]; do
    case "$1" in
        --project)
            PROJECT="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: moe-call.sh <tool_name> [json_arguments] [--project <path>]"
            echo ""
            echo "Calls a Moe daemon tool via the proxy and prints the result."
            echo "Tool name can omit the 'moe.' prefix (e.g., 'claim_next_task' or 'moe.claim_next_task')."
            echo ""
            echo "Available tools:"
            echo "  get_context        - Get project context for a worker"
            echo "  list_tasks         - List tasks by status"
            echo "  search_tasks       - Search tasks by keyword"
            echo "  claim_next_task    - Claim the next available task"
            echo "  wait_for_task      - Wait for a task to become available"
            echo "  submit_plan        - Submit implementation plan for a task"
            echo "  check_approval     - Check if a task plan is approved"
            echo "  start_step         - Mark a step as in-progress"
            echo "  complete_step      - Mark a step as done"
            echo "  complete_task      - Mark a task as done"
            echo "  report_blocked     - Report a task as blocked"
            echo "  add_comment        - Add a comment to a task"
            echo "  create_task        - Create a new task"
            echo "  set_task_status    - Change task status"
            echo "  get_next_task      - Get next task without claiming"
            echo "  get_activity_log   - Get activity log entries"
            echo "  init_project       - Initialize a new Moe project"
            exit 0
            ;;
        *)
            if [ -z "$TOOL_NAME" ]; then
                TOOL_NAME="$1"
            elif [ "$TOOL_ARGS" = "{}" ]; then
                TOOL_ARGS="$1"
            fi
            shift
            ;;
    esac
done

if [ -z "$TOOL_NAME" ]; then
    echo "Error: tool name required" >&2
    echo "Usage: moe-call.sh <tool_name> [json_arguments] [--project <path>]" >&2
    exit 1
fi

# Add moe. prefix if not present
if [[ "$TOOL_NAME" != moe.* ]]; then
    TOOL_NAME="moe.$TOOL_NAME"
fi

# Resolve project path
if [ -z "$PROJECT" ]; then
    if [ -n "${MOE_PROJECT_PATH:-}" ]; then
        PROJECT="$MOE_PROJECT_PATH"
    else
        PROJECT="$(pwd)"
    fi
fi

# Find node
find_node() {
    if command -v node &> /dev/null; then
        echo "node"
        return
    fi
    for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.nvm/current/bin/node"; do
        if [ -x "$candidate" ]; then
            echo "$candidate"
            return
        fi
    done
    # Try nvm versions
    if [ -d "$HOME/.nvm/versions/node" ]; then
        local latest
        latest=$(ls -1 "$HOME/.nvm/versions/node/" 2>/dev/null | sort -V | tail -1)
        if [ -n "$latest" ] && [ -x "$HOME/.nvm/versions/node/$latest/bin/node" ]; then
            echo "$HOME/.nvm/versions/node/$latest/bin/node"
            return
        fi
    fi
    echo ""
}

NODE_CMD=$(find_node)
if [ -z "$NODE_CMD" ]; then
    echo "Error: node not found" >&2
    exit 1
fi

# Find moe-proxy
find_proxy() {
    # 1. MOE_PROXY_PATH env var
    if [ -n "${MOE_PROXY_PATH:-}" ] && [ -f "$MOE_PROXY_PATH" ]; then
        echo "$MOE_PROXY_PATH"
        return
    fi

    # 2. Sibling to this script (repo layout)
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local repo_proxy="$script_dir/../packages/moe-proxy/dist/index.js"
    if [ -f "$repo_proxy" ]; then
        echo "$repo_proxy"
        return
    fi

    # 3. Global install config
    local config_file="$HOME/.moe/config.json"
    if [ -f "$config_file" ]; then
        local install_path
        install_path=$(python3 -c "import json; print(json.load(open('$config_file')).get('installPath',''))" 2>/dev/null || true)
        if [ -n "$install_path" ]; then
            local global_proxy="$install_path/packages/moe-proxy/dist/index.js"
            if [ -f "$global_proxy" ]; then
                echo "$global_proxy"
                return
            fi
        fi
    fi

    # 4. Bundled in plugin
    local plugin_dir="$HOME/Library/Application Support/JetBrains"
    if [ -d "$plugin_dir" ]; then
        local found
        found=$(find "$plugin_dir" -path "*/moe-jetbrains/proxy/index.js" -print -quit 2>/dev/null || true)
        if [ -n "$found" ] && [ -f "$found" ]; then
            echo "$found"
            return
        fi
    fi

    echo ""
}

PROXY_PATH=$(find_proxy)
if [ -z "$PROXY_PATH" ]; then
    echo "Error: moe-proxy not found. Set MOE_PROXY_PATH or install Moe." >&2
    exit 1
fi

# Verify daemon is running
DAEMON_FILE="$PROJECT/.moe/daemon.json"
if [ ! -f "$DAEMON_FILE" ]; then
    echo "Error: daemon not running (no $DAEMON_FILE). Start with: moe-daemon start --project $PROJECT" >&2
    exit 1
fi

# Build JSON-RPC request
REQUEST=$(python3 -c "
import json, sys
tool = '$TOOL_NAME'
args = json.loads('$TOOL_ARGS')
req = {
    'jsonrpc': '2.0',
    'id': 1,
    'method': 'tools/call',
    'params': {
        'name': tool,
        'arguments': args
    }
}
print(json.dumps(req))
" 2>/dev/null)

if [ -z "$REQUEST" ]; then
    echo "Error: failed to build JSON-RPC request. Check your arguments are valid JSON." >&2
    exit 1
fi

# Call proxy with the request, pipe stdin and capture stdout
RESULT=$(echo "$REQUEST" | MOE_PROJECT_PATH="$PROJECT" "$NODE_CMD" "$PROXY_PATH" 2>/dev/null)

if [ -z "$RESULT" ]; then
    echo "Error: no response from daemon" >&2
    exit 1
fi

# Extract the result content from JSON-RPC response
python3 -c "
import json, sys

for line in '''$RESULT'''.strip().split('\n'):
    line = line.strip()
    if not line:
        continue
    try:
        resp = json.loads(line)
        if 'error' in resp:
            print(json.dumps(resp['error'], indent=2))
            sys.exit(1)
        if 'result' in resp:
            result = resp['result']
            # MCP tool results have content array
            if isinstance(result, dict) and 'content' in result:
                for item in result['content']:
                    if item.get('type') == 'text':
                        try:
                            parsed = json.loads(item['text'])
                            print(json.dumps(parsed, indent=2))
                        except:
                            print(item['text'])
                sys.exit(0)
            print(json.dumps(result, indent=2))
            sys.exit(0)
    except json.JSONDecodeError:
        continue

print('Error: could not parse response')
sys.exit(1)
" 2>/dev/null
