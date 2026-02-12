#!/bin/bash
# Build Installer Assets for Mac/Linux
# Prepares daemon, proxy, and plugin for distribution

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

PLUGIN_ZIP=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --plugin-zip)
            PLUGIN_ZIP="$2"
            shift 2
            ;;
        --help|-h)
            echo "Build Installer Assets"
            echo ""
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --plugin-zip PATH    Use prebuilt plugin zip"
            echo "  --help, -h           Show this help"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

echo -e "${GREEN}Building Moe Installer Assets${NC}"
echo ""

# Build daemon
echo -e "${YELLOW}Building moe-daemon...${NC}"
cd "$ROOT_DIR/packages/moe-daemon"
npm install
npm run build

# Build proxy
echo -e "${YELLOW}Building moe-proxy...${NC}"
cd "$ROOT_DIR/packages/moe-proxy"
npm install
npm run build

# Build plugin unless prebuilt zip provided
if [ -n "$PLUGIN_ZIP" ]; then
    if [ ! -f "$PLUGIN_ZIP" ]; then
        echo -e "${RED}Plugin zip not found at $PLUGIN_ZIP${NC}"
        exit 1
    fi
    ZIP_PATH="$PLUGIN_ZIP"
else
    echo -e "${YELLOW}Building JetBrains plugin...${NC}"
    cd "$ROOT_DIR/moe-jetbrains"

    if [ -f "./gradlew" ]; then
        chmod +x ./gradlew
        ./gradlew buildPlugin
    elif command -v gradle &> /dev/null; then
        gradle buildPlugin
    else
        echo -e "${RED}Gradle not found. Install gradle or use gradlew.${NC}"
        exit 1
    fi

    ZIP_PATH=$(ls -t "$ROOT_DIR/moe-jetbrains/build/distributions/"*.zip 2>/dev/null | head -1)
    if [ -z "$ZIP_PATH" ]; then
        echo -e "${RED}Plugin zip not found after build.${NC}"
        exit 1
    fi
fi

# Prepare assets directory
ASSETS_DIR="$ROOT_DIR/installer/assets"
mkdir -p "$ASSETS_DIR"

# Copy daemon dist
DAEMON_DEST="$ASSETS_DIR/moe-daemon"
rm -rf "$DAEMON_DEST"
cp -r "$ROOT_DIR/packages/moe-daemon/dist" "$DAEMON_DEST"

# Copy proxy dist
PROXY_DEST="$ASSETS_DIR/moe-proxy"
rm -rf "$PROXY_DEST"
cp -r "$ROOT_DIR/packages/moe-proxy/dist" "$PROXY_DEST"

# Add helper start script for daemon
cat > "$DAEMON_DEST/start-daemon.sh" << 'SCRIPT'
#!/bin/bash
PROJECT_PATH="${1:-$(pwd)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/index.js" start --project "$PROJECT_PATH"
SCRIPT
chmod +x "$DAEMON_DEST/start-daemon.sh"

# Copy plugin zip
cp "$ZIP_PATH" "$ASSETS_DIR/moe-jetbrains.zip"

echo ""
echo -e "${GREEN}Installer assets prepared in $ASSETS_DIR${NC}"
echo ""
echo "Contents:"
ls -la "$ASSETS_DIR"
