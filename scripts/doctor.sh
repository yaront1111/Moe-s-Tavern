#!/bin/bash
# Moe Doctor - Check system prerequisites for Mac/Linux

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

echo "== Moe Doctor =="
echo ""

check_command() {
    local cmd=$1
    local min_version=$2
    local install_hint=$3

    if command -v "$cmd" &> /dev/null; then
        local version=$("$cmd" --version 2>&1 | head -n1)
        echo -e "${GREEN}[OK]${NC} $cmd: $version"
        return 0
    else
        echo -e "${RED}[MISSING]${NC} $cmd"
        if [ -n "$install_hint" ]; then
            echo -e "    ${YELLOW}Install:${NC} $install_hint"
        fi
        return 1
    fi
}

check_node_version() {
    if command -v node &> /dev/null; then
        local version=$(node -v | sed 's/v//')
        local major=$(echo "$version" | cut -d. -f1)
        if [ "$major" -ge 18 ]; then
            echo -e "${GREEN}[OK]${NC} Node.js version $version (>= 18 required)"
            return 0
        else
            echo -e "${RED}[ERROR]${NC} Node.js version $version is too old. Requires >= 18"
            echo -e "    ${YELLOW}Update:${NC} brew upgrade node"
            return 1
        fi
    fi
    return 1
}

ERRORS=0

echo "Checking prerequisites..."
echo ""

# Node.js
if ! check_command "node" "" "brew install node"; then
    ERRORS=$((ERRORS + 1))
else
    if ! check_node_version; then
        ERRORS=$((ERRORS + 1))
    fi
fi

# npm
if ! check_command "npm" "" "(comes with Node.js)"; then
    ERRORS=$((ERRORS + 1))
fi

# git
if ! check_command "git" "" "brew install git"; then
    ERRORS=$((ERRORS + 1))
fi

echo ""

# Check architecture
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    echo -e "${GREEN}[INFO]${NC} Architecture: Apple Silicon (arm64)"
elif [ "$ARCH" = "x86_64" ]; then
    echo -e "${GREEN}[INFO]${NC} Architecture: Intel (x86_64)"
else
    echo -e "${YELLOW}[INFO]${NC} Architecture: $ARCH"
fi

# Check OS
OS=$(uname -s)
echo -e "${GREEN}[INFO]${NC} Operating System: $OS"

echo ""

# Optional: Check for JetBrains IDE (for plugin)
JETBRAINS_DIR="$HOME/Library/Application Support/JetBrains"
if [ -d "$JETBRAINS_DIR" ]; then
    echo -e "${GREEN}[INFO]${NC} JetBrains config found"
    ls -1 "$JETBRAINS_DIR" 2>/dev/null | grep -E "(PyCharm|IntelliJ|WebStorm)" | while read ide; do
        echo "    - $ide"
    done
else
    echo -e "${YELLOW}[INFO]${NC} No JetBrains IDE config found (optional)"
fi

echo ""

# Check for existing Moe installation
if command -v moe-daemon &> /dev/null; then
    echo -e "${GREEN}[INFO]${NC} moe-daemon is installed globally"
else
    echo -e "${YELLOW}[INFO]${NC} moe-daemon not installed globally yet"
fi

if command -v moe-proxy &> /dev/null; then
    echo -e "${GREEN}[INFO]${NC} moe-proxy is installed globally"
else
    echo -e "${YELLOW}[INFO]${NC} moe-proxy not installed globally yet"
fi

echo ""

if [ $ERRORS -gt 0 ]; then
    echo -e "${RED}Doctor found $ERRORS issue(s). Please fix them before continuing.${NC}"
    exit 1
else
    echo -e "${GREEN}All prerequisites met!${NC}"
    exit 0
fi
