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
        --help|-h)
            echo "Moe Installation Script"
            echo ""
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --global, -g     Install daemon and proxy globally via npm"
            echo "  --with-plugin    Build JetBrains plugin (requires JDK 17+)"
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

    # Check for Java and find a compatible version (17-23, not 24+)
    JAVA_CMD=""

    # Check for Homebrew Java installations first
    for v in 21 17 20 19 18; do
        if [ -d "/opt/homebrew/opt/openjdk@$v" ]; then
            export JAVA_HOME="/opt/homebrew/opt/openjdk@$v"
            JAVA_CMD="$JAVA_HOME/bin/java"
            echo -e "${GREEN}[OK]${NC} Using Homebrew OpenJDK $v"
            break
        elif [ -d "/usr/local/opt/openjdk@$v" ]; then
            export JAVA_HOME="/usr/local/opt/openjdk@$v"
            JAVA_CMD="$JAVA_HOME/bin/java"
            echo -e "${GREEN}[OK]${NC} Using Homebrew OpenJDK $v (Intel)"
            break
        fi
    done

    # Fall back to system Java
    if [ -z "$JAVA_CMD" ]; then
        if ! command -v java &> /dev/null; then
            echo -e "${RED}[ERROR]${NC} Java not found. Install JDK 17-21: brew install openjdk@21"
            exit 1
        fi
        JAVA_CMD="java"
    fi

    # Check Java version (must be 17-23, Gradle doesn't support 24+ yet)
    JAVA_VERSION=$($JAVA_CMD -version 2>&1 | head -n1 | sed -n 's/.*version "\([^"]*\)".*/\1/p')
    JAVA_MAJOR=$(echo "$JAVA_VERSION" | cut -d'.' -f1)

    # Handle old format (1.8.x)
    if [ "$JAVA_MAJOR" = "1" ]; then
        JAVA_MAJOR=$(echo "$JAVA_VERSION" | cut -d'.' -f2)
    fi

    if [ "$JAVA_MAJOR" -lt 17 ] 2>/dev/null; then
        echo -e "${RED}[ERROR]${NC} Java 17+ required. Found version $JAVA_VERSION"
        echo -e "    ${YELLOW}Install:${NC} brew install openjdk@21"
        exit 1
    fi

    if [ "$JAVA_MAJOR" -ge 24 ] 2>/dev/null; then
        echo -e "${RED}[ERROR]${NC} Java $JAVA_MAJOR is too new - Gradle doesn't support it yet"
        echo -e "    ${YELLOW}Install Java 21:${NC} brew install openjdk@21"
        echo -e "    ${YELLOW}Then run:${NC} export JAVA_HOME=/opt/homebrew/opt/openjdk@21"
        exit 1
    fi

    echo -e "${GREEN}[OK]${NC} Java version $JAVA_VERSION"

    # Ensure gradle wrapper exists
    if [ ! -f "gradle/wrapper/gradle-wrapper.jar" ]; then
        echo -e "${YELLOW}[INFO]${NC} Gradle wrapper missing, downloading..."

        # Try to use system gradle to generate wrapper
        if command -v gradle &> /dev/null; then
            gradle wrapper --gradle-version 8.5
        else
            # Download gradle wrapper jar directly
            mkdir -p gradle/wrapper
            WRAPPER_URL="https://raw.githubusercontent.com/gradle/gradle/v8.5.0/gradle/wrapper/gradle-wrapper.jar"
            WRAPPER_JAR="gradle/wrapper/gradle-wrapper.jar"
            WRAPPER_JAR_TMP="${WRAPPER_JAR}.tmp"
            # Track temp file for cleanup on failure
            TEMP_FILES_TO_CLEANUP+=("$WRAPPER_JAR_TMP")

            if command -v curl &> /dev/null; then
                curl -sL "$WRAPPER_URL" -o "$WRAPPER_JAR_TMP"
            elif command -v wget &> /dev/null; then
                wget -q "$WRAPPER_URL" -O "$WRAPPER_JAR_TMP"
            else
                echo -e "${RED}[ERROR]${NC} Cannot download gradle wrapper. Install gradle: brew install gradle"
                exit 1
            fi

            # Verify the download succeeded and file is not empty
            if [ ! -s "$WRAPPER_JAR_TMP" ]; then
                echo -e "${RED}[ERROR]${NC} Failed to download gradle wrapper (empty or missing)"
                rm -f "$WRAPPER_JAR_TMP"
                exit 1
            fi

            # Basic sanity check: gradle-wrapper.jar should be a valid JAR (ZIP format)
            if command -v file &> /dev/null; then
                FILE_TYPE=$(file -b "$WRAPPER_JAR_TMP")
                if [[ ! "$FILE_TYPE" =~ "Java archive" && ! "$FILE_TYPE" =~ "Zip archive" ]]; then
                    echo -e "${RED}[ERROR]${NC} Downloaded file is not a valid JAR: $FILE_TYPE"
                    rm -f "$WRAPPER_JAR_TMP"
                    exit 1
                fi
            fi

            # Move temp file to final location (atomic on same filesystem)
            mv "$WRAPPER_JAR_TMP" "$WRAPPER_JAR"

            # Create wrapper properties if missing
            if [ ! -f "gradle/wrapper/gradle-wrapper.properties" ]; then
                cat > gradle/wrapper/gradle-wrapper.properties << 'PROPEOF'
distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\://services.gradle.org/distributions/gradle-8.5-bin.zip
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
PROPEOF
            fi
        fi
        echo -e "${GREEN}[OK]${NC} Gradle wrapper setup complete"
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

# Create ~/.moe directory
echo -e "${YELLOW}Step 9: Creating Moe config directory...${NC}"
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
