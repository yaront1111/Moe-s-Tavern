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

# Parse arguments
GLOBAL_INSTALL=false
INSTALL_LAUNCHD=false
SKIP_MCP=false

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
        --help|-h)
            echo "Moe Installation Script"
            echo ""
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --global, -g     Install daemon and proxy globally via npm"
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

# Run doctor check first
echo -e "${YELLOW}Step 1: Checking prerequisites...${NC}"
if ! "$SCRIPT_DIR/doctor.sh"; then
    echo -e "${RED}Prerequisites check failed. Please fix the issues above.${NC}"
    exit 1
fi
echo ""

# Build daemon
echo -e "${YELLOW}Step 2: Building moe-daemon...${NC}"
cd "$ROOT_DIR/packages/moe-daemon"
npm install
npm run build
echo -e "${GREEN}[OK]${NC} moe-daemon built"
echo ""

# Build proxy
echo -e "${YELLOW}Step 3: Building moe-proxy...${NC}"
cd "$ROOT_DIR/packages/moe-proxy"
npm install
npm run build
echo -e "${GREEN}[OK]${NC} moe-proxy built"
echo ""

# Global install (optional)
if [ "$GLOBAL_INSTALL" = true ]; then
    echo -e "${YELLOW}Step 4: Installing globally...${NC}"
    cd "$ROOT_DIR/packages/moe-daemon"
    npm link
    cd "$ROOT_DIR/packages/moe-proxy"
    npm link
    echo -e "${GREEN}[OK]${NC} Installed moe-daemon and moe-proxy globally"
    echo ""
fi

# Setup MCP configuration
if [ "$SKIP_MCP" = false ]; then
    echo -e "${YELLOW}Step 5: Setting up MCP configuration...${NC}"

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
            PROXY_CMD="node $ROOT_DIR/packages/moe-proxy/dist/index.js"
        fi

        cat > "$MCP_CONFIG_FILE" << EOF
{
  "moe": {
    "command": "$PROXY_CMD",
    "env": {}
  }
}
EOF
        echo -e "${GREEN}[OK]${NC} Created MCP config at $MCP_CONFIG_FILE"
    fi
    echo ""
fi

# Setup launchd (Mac only, optional)
if [ "$INSTALL_LAUNCHD" = true ] && [ "$(uname -s)" = "Darwin" ]; then
    echo -e "${YELLOW}Step 6: Setting up launchd auto-start...${NC}"

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

# Create ~/.moe directory
echo -e "${YELLOW}Step 7: Creating Moe config directory...${NC}"
mkdir -p "$HOME/.moe"
if [ ! -f "$HOME/.moe/projects.json" ]; then
    echo "[]" > "$HOME/.moe/projects.json"
fi
echo -e "${GREEN}[OK]${NC} Created ~/.moe directory"
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
echo "   $SCRIPT_DIR/moe-agent.sh --role architect --project /path/to/your/project"
echo ""
echo "3. Or use Claude Code directly with MCP:"
echo "   MOE_PROJECT_PATH=/path/to/project claude"
echo ""
