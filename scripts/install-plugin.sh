#!/bin/bash
# Install JetBrains Plugin for Mac/Linux
# Installs the Moe plugin to PyCharm/IntelliJ plugin directory

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PLUGIN_ZIP=""
IDE_VERSION=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --plugin-zip|-p)
            PLUGIN_ZIP="$2"
            shift 2
            ;;
        --ide-version|-v)
            IDE_VERSION="$2"
            shift 2
            ;;
        --help|-h)
            echo "Install JetBrains Plugin"
            echo ""
            echo "Usage: $0 --plugin-zip <path> [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  -p, --plugin-zip PATH    Path to plugin zip file (required)"
            echo "  -v, --ide-version VER    IDE version folder (e.g., PyCharm2025.2)"
            echo "  --help, -h               Show this help"
            echo ""
            echo "Supported IDEs: PyCharm, IntelliJIdea, WebStorm, GoLand, etc."
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

if [ -z "$PLUGIN_ZIP" ]; then
    echo -e "${RED}Error: --plugin-zip is required${NC}"
    echo "Usage: $0 --plugin-zip <path>"
    exit 1
fi

if [ ! -f "$PLUGIN_ZIP" ]; then
    echo -e "${RED}Plugin zip not found: $PLUGIN_ZIP${NC}"
    exit 1
fi

# Detect OS and set JetBrains config path
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    JB_ROOT="$HOME/Library/Application Support/JetBrains"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux
    JB_ROOT="$HOME/.config/JetBrains"
else
    echo -e "${RED}Unsupported OS: $OSTYPE${NC}"
    exit 1
fi

if [ ! -d "$JB_ROOT" ]; then
    echo -e "${RED}JetBrains config directory not found: $JB_ROOT${NC}"
    echo "Make sure you have a JetBrains IDE installed and run it at least once."
    exit 1
fi

# Find IDE version directory
if [ -n "$IDE_VERSION" ]; then
    PLUGIN_ROOT="$JB_ROOT/$IDE_VERSION"
else
    # Auto-detect: prefer PyCharm, then IntelliJ, then others
    for pattern in "PyCharm*" "IntelliJIdea*" "WebStorm*" "GoLand*" "*"; do
        CANDIDATES=$(ls -d "$JB_ROOT"/$pattern 2>/dev/null | sort -r | head -1)
        if [ -n "$CANDIDATES" ]; then
            PLUGIN_ROOT="$CANDIDATES"
            break
        fi
    done
fi

if [ -z "$PLUGIN_ROOT" ] || [ ! -d "$PLUGIN_ROOT" ]; then
    echo -e "${RED}No JetBrains IDE config found in $JB_ROOT${NC}"
    echo "Available directories:"
    ls -la "$JB_ROOT" 2>/dev/null || echo "  (none)"
    exit 1
fi

PLUGINS_DIR="$PLUGIN_ROOT/plugins"
mkdir -p "$PLUGINS_DIR"

DEST_DIR="$PLUGINS_DIR/moe-jetbrains"

# Remove existing installation
if [ -d "$DEST_DIR" ]; then
    echo -e "${YELLOW}Removing existing plugin installation...${NC}"
    rm -rf "$DEST_DIR"
fi

# Extract plugin
echo -e "${YELLOW}Installing plugin to $DEST_DIR...${NC}"
mkdir -p "$DEST_DIR"
unzip -q "$PLUGIN_ZIP" -d "$DEST_DIR"

# Flatten if zip contained a top-level folder
if [ ! -d "$DEST_DIR/lib" ]; then
    NESTED=$(ls -d "$DEST_DIR"/*/ 2>/dev/null | head -1)
    if [ -n "$NESTED" ] && [ -d "$NESTED" ]; then
        mv "$NESTED"/* "$DEST_DIR/" 2>/dev/null || true
        rmdir "$NESTED" 2>/dev/null || rm -rf "$NESTED"
    fi
fi

echo ""
echo -e "${GREEN}Plugin installed successfully!${NC}"
echo "Location: $DEST_DIR"
echo ""
echo "Restart your JetBrains IDE to load the plugin."
