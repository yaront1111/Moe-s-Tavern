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

# Find python: python3 on Unix, `py -3` on Windows, or plain python if 3.x.
# Actually runs `--version` since `command -v python3` on Windows can resolve
# to the Microsoft Store shim that prints "Python was not found" when executed.
find_python() {
    if command -v python3 &> /dev/null && python3 --version &> /dev/null 2>&1; then
        echo "python3"
        return 0
    fi
    if command -v py &> /dev/null && py -3 --version &> /dev/null 2>&1; then
        echo "py -3"
        return 0
    fi
    if command -v python &> /dev/null; then
        local v
        v=$(python --version 2>&1)
        if [[ "$v" == *"Python 3."* ]]; then
            echo "python"
            return 0
        fi
    fi
    echo ""
    return 1
}
PYTHON_CMD=$(find_python)
if [ -z "$PYTHON_CMD" ]; then
    echo "Error: python3 (or py -3) not found on PATH" >&2
    exit 1
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
        install_path=$($PYTHON_CMD -c "import json; print(json.load(open('$config_file')).get('installPath',''))" 2>/dev/null || true)
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

# Build JSON-RPC request (node handles JSON/shell quoting more robustly than python+heredoc)
REQUEST=$("$NODE_CMD" -e "
const tool = process.argv[1];
const args = JSON.parse(process.argv[2]);
process.stdout.write(JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'tools/call',
  params: { name: tool, arguments: args }
}));
" "$TOOL_NAME" "$TOOL_ARGS" 2>/dev/null)

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

# Extract the result content from JSON-RPC response via stdin
printf '%s' "$RESULT" | "$NODE_CMD" -e "
let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  const lines = input.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    let resp;
    try { resp = JSON.parse(line); } catch { continue; }
    if (resp.error) {
      process.stdout.write(JSON.stringify(resp.error, null, 2) + '\n');
      process.exit(1);
    }
    if (resp.result) {
      const r = resp.result;
      if (r && typeof r === 'object' && Array.isArray(r.content)) {
        for (const item of r.content) {
          if (item.type === 'text') {
            let text = item.text;
            try {
              const parsed = JSON.parse(text);
              process.stdout.write(JSON.stringify(parsed, null, 2) + '\n');
            } catch {
              process.stdout.write(text + '\n');
            }
          }
        }
        process.exit(0);
      }
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      process.exit(0);
    }
  }
  process.stderr.write('Error: could not parse response\n');
  process.exit(1);
});
"
