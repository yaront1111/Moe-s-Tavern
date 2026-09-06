#!/bin/bash
# Moe Installation Script for Mac/Linux
# Usage: ./install-mac.sh [--global] [--with-launchd] [--skip-mcp]

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Cleanup function for trap
TEMP_FILES_TO_CLEANUP=()
cleanup() {
    local exit_code=$?
    for f in "${TEMP_FILES_TO_CLEANUP[@]}"; do
        if [ -e "$f" ]; then
            rm -rf "$f" 2>/dev/null || true
        fi
    done
    # Clean up partial gradle wrapper download if incomplete
    if [ -f "$ROOT_DIR/moe-jetbrains/gradle/wrapper/gradle-wrapper.jar.tmp" ]; then
        rm -f "$ROOT_DIR/moe-jetbrains/gradle/wrapper/gradle-wrapper.jar.tmp" 2>/dev/null || true
    fi
    exit $exit_code
}
trap cleanup EXIT INT TERM

# Parse arguments
GLOBAL_INSTALL=false
INSTALL_LAUNCHD=false
SKIP_MCP=false
BUILD_PLUGIN=false
AGENT_COMMAND=claude

while [[ $# -gt 0 ]]; do
    case $1 in
        --global|-g)
            GLOBAL_INSTALL=true
            shift
            ;;
        --with-launchd)
            INSTALL_LAUNCHD=true
            shift
            ;;
        --skip-mcp)
            SKIP_MCP=true
            shift
            ;;
        --with-plugin)
            BUILD_PLUGIN=true
            shift
            ;;
        --agent|--agent-command)
            [ "$#" -ge 2 ] || { echo 'Missing agent after --agent' >&2; exit 1; }
            AGENT_COMMAND=$2
            shift 2
            ;;
        --help|-h)
            echo "Moe Installation Script"
            echo ""
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --global, -g     Install daemon and proxy globally via npm"
            echo "  --with-plugin    Install JDK 17 if needed and build the JetBrains plugin"
            echo "  --agent NAME     Install claude (default), codex, gemini, or none"
            echo "  --with-launchd   Install launchd plist for auto-start (Mac only)"
            echo "  --skip-mcp       Skip MCP configuration setup"
            echo "  --help, -h       Show this help"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

echo -e "${BLUE}================================${NC}"
echo -e "${BLUE}   Moe Installation for Mac${NC}"
echo -e "${BLUE}================================${NC}"
echo ""

# Install prerequisites before checking them. Source preserves the new tool PATH.
source "$SCRIPT_DIR/install-dependencies.sh"
moe_install_dependencies "$AGENT_COMMAND" "$BUILD_PLUGIN"

# Run doctor check after dependency installation
echo -e "${YELLOW}Step 1: Checking prerequisites...${NC}"
if ! bash "$SCRIPT_DIR/doctor.sh"; then
    echo -e "${RED}Prerequisites check failed. Please fix the issues above.${NC}"
    exit 1
fi
echo ""

# Fix script permissions
echo -e "${YELLOW}Step 2: Fixing script permissions...${NC}"
# Use find to safely handle paths with special characters
find "$SCRIPT_DIR" -maxdepth 1 -name "*.sh" -exec chmod +x {} \; 2>/dev/null || true
if [ -d "$ROOT_DIR/moe-jetbrains" ]; then
    chmod +x "$ROOT_DIR/moe-jetbrains/gradlew" 2>/dev/null || true
    if [ -d "$ROOT_DIR/moe-jetbrains/scripts" ]; then
        find "$ROOT_DIR/moe-jetbrains/scripts" -maxdepth 1 -name "*.sh" -exec chmod +x {} \; 2>/dev/null || true
    fi
fi
echo -e "${GREEN}[OK]${NC} Script permissions fixed"
echo ""

# Build daemon
echo -e "${YELLOW}Step 3: Building moe-daemon...${NC}"
cd "$ROOT_DIR/packages/moe-daemon"
if ! npm install; then
    echo -e "${RED}[ERROR]${NC} npm install failed for moe-daemon"
    exit 1
fi
if ! npm run build; then
    echo -e "${RED}[ERROR]${NC} npm run build failed for moe-daemon"
    exit 1
fi
echo -e "${GREEN}[OK]${NC} moe-daemon built"
echo ""

# Build proxy
echo -e "${YELLOW}Step 4: Building moe-proxy...${NC}"
cd "$ROOT_DIR/packages/moe-proxy"
if ! npm install; then
    echo -e "${RED}[ERROR]${NC} npm install failed for moe-proxy"
    exit 1
fi
if ! npm run build; then
    echo -e "${RED}[ERROR]${NC} npm run build failed for moe-proxy"
    exit 1
fi
echo -e "${GREEN}[OK]${NC} moe-proxy built"
echo ""

# Global install (optional)
if [ "$GLOBAL_INSTALL" = true ]; then
    echo -e "${YELLOW}Step 5: Installing globally...${NC}"
    cd "$ROOT_DIR/packages/moe-daemon"
    npm link
    cd "$ROOT_DIR/packages/moe-proxy"
    npm link
    echo -e "${GREEN}[OK]${NC} Installed moe-daemon and moe-proxy globally"
    echo ""
fi

# Build JetBrains plugin (optional)
if [ "$BUILD_PLUGIN" = true ]; then
    echo -e "${YELLOW}Step 6: Building JetBrains plugin...${NC}"

    cd "$ROOT_DIR/moe-jetbrains"

    # Dependency bootstrap selected JDK 17. Use the repository's pinned wrapper.
    if [ ! -f "gradle/wrapper/gradle-wrapper.jar" ]; then
        echo '[ERROR] Gradle wrapper is missing. Download a complete source ZIP or clone of Moe.' >&2
        exit 1
    fi

    # Build plugin
    ./gradlew buildPlugin

    PLUGIN_ZIP=$(ls -t build/distributions/*.zip 2>/dev/null | head -n1)
    if [ -n "$PLUGIN_ZIP" ]; then
        echo -e "${GREEN}[OK]${NC} Plugin built: $PLUGIN_ZIP"
        echo ""
        echo -e "${YELLOW}To install the plugin:${NC}"
        echo "  1. Open your JetBrains IDE"
        echo "  2. Settings → Plugins → ⚙️ → Install Plugin from Disk"
        echo "  3. Select: $PLUGIN_ZIP"
    else
        echo -e "${RED}[ERROR]${NC} Plugin build failed"
        exit 1
    fi
    echo ""
fi

# Setup MCP configuration
if [ "$SKIP_MCP" = false ]; then
    echo -e "${YELLOW}Step 7: Setting up MCP configuration...${NC}"

    MCP_CONFIG_DIR="$HOME/.config/claude"
    MCP_CONFIG_FILE="$MCP_CONFIG_DIR/mcp_servers.json"

    mkdir -p "$MCP_CONFIG_DIR"

    if [ -f "$MCP_CONFIG_FILE" ]; then
        echo -e "${YELLOW}[INFO]${NC} MCP config exists at $MCP_CONFIG_FILE"
        echo "       You may need to manually add the moe server entry."
    else
        # Determine the proxy command path
        if [ "$GLOBAL_INSTALL" = true ] && command -v moe-proxy &> /dev/null; then
            PROXY_CMD="moe-proxy"
        else
            PROXY_CMD="node"
        fi

        node - "$MCP_CONFIG_FILE" "$PROXY_CMD" "$ROOT_DIR/packages/moe-proxy/dist/index.js" <<'NODE'
const fs = require('node:fs');
const [configPath, command, proxyPath] = process.argv.slice(2);
const args = command === 'node' ? [proxyPath] : [];
fs.writeFileSync(configPath, JSON.stringify({ moe: { command, args, env: {} } }, null, 2) + '\n');
NODE
        echo -e "${GREEN}[OK]${NC} Created MCP config at $MCP_CONFIG_FILE"
    fi
    echo ""
fi

# Setup launchd (Mac only, optional)
if [ "$INSTALL_LAUNCHD" = true ] && [ "$(uname -s)" = "Darwin" ]; then
    echo -e "${YELLOW}Step 8: Setting up launchd auto-start...${NC}"

    LAUNCHD_DIR="$HOME/Library/LaunchAgents"
    PLIST_FILE="$LAUNCHD_DIR/com.moe.daemon.plist"

    mkdir -p "$LAUNCHD_DIR"

    if [ "$GLOBAL_INSTALL" = true ] && command -v moe-daemon &> /dev/null; then
        DAEMON_CMD=$(which moe-daemon)
    else
        DAEMON_CMD="$ROOT_DIR/packages/moe-daemon/dist/index.js"
    fi

    cat > "$PLIST_FILE" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.moe.daemon</string>
    <key>Comment</key>
    <string>Moe Daemon - Started on demand by moe-agent.sh</string>
    <key>Disabled</key>
    <true/>
</dict>
</plist>
EOF

    echo -e "${GREEN}[OK]${NC} Created launchd plist at $PLIST_FILE"
    echo -e "${YELLOW}[INFO]${NC} Daemon will be started on-demand by moe-agent.sh"
    echo ""
fi

# Create ~/.moe directory and write global config
echo -e "${YELLOW}Step 9: Creating Moe config directory...${NC}"
mkdir -p "$HOME/.moe"
if [ ! -f "$HOME/.moe/projects.json" ]; then
    echo "[]" > "$HOME/.moe/projects.json"
fi

# Write global install config so other projects can find this installation
node - "$HOME/.moe/config.json" "$ROOT_DIR" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [configPath, installPath] = process.argv.slice(2);
const { version } = JSON.parse(fs.readFileSync(path.join(installPath, 'packages/moe-daemon/package.json'), 'utf8'));
fs.writeFileSync(configPath, JSON.stringify({ installPath, version, updatedAt: new Date().toISOString() }, null, 2) + '\n');
NODE
echo -e "${GREEN}[OK]${NC} Created ~/.moe directory and config.json"
echo ""

# Done
echo -e "${BLUE}================================${NC}"
echo -e "${GREEN}   Installation Complete!${NC}"
echo -e "${BLUE}================================${NC}"
echo ""
echo "Next steps:"
echo ""
echo "1. Start the daemon for your project:"
if [ "$GLOBAL_INSTALL" = true ]; then
    echo "   moe-daemon start --project /path/to/your/project"
else
    echo "   node $ROOT_DIR/packages/moe-daemon/dist/index.js start --project /path/to/your/project"
fi
echo ""
echo "2. Run an AI agent:"
if [ "$AGENT_COMMAND" != none ]; then
    printf '   bash "%s/moe-agent.sh" --role architect --command %s --project /path/to/your/project\n' "$SCRIPT_DIR" "$AGENT_COMMAND"
else
    echo '   Choose and install an agent CLI before launching one (--agent claude, codex, or gemini).'
fi
echo ""
echo "   Tip: If agents can't find node, set MOE_NODE_COMMAND:"
echo "     export MOE_NODE_COMMAND=/path/to/node"
echo ""
echo '3. Open the board, create an epic and task, and move the task to Planning.'
echo ""
