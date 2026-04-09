#!/usr/bin/env bash
# Build, install, and restart IntelliJ IDEA with the Moe plugin.
# Usage: ./scripts/deploy-plugin.sh [--no-restart]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_DIR="$PROJECT_ROOT/moe-jetbrains"
NO_RESTART=false

for arg in "$@"; do
    case $arg in
        --no-restart) NO_RESTART=true ;;
        --help|-h)
            echo "Usage: $0 [--no-restart]"
            echo "  --no-restart   Build and install but don't restart the IDE"
            exit 0
            ;;
    esac
done

# Find the latest IntelliJ IDEA plugins directory
IDEA_PLUGINS=""
if [[ "$OSTYPE" == "darwin"* ]]; then
    JB_ROOT="$HOME/Library/Application Support/JetBrains"
else
    JB_ROOT="$HOME/.config/JetBrains"
fi

# Pick the newest IntelliJIdea version directory
for dir in "$JB_ROOT/IntelliJIdea"*/plugins; do
    [ -d "$dir" ] && IDEA_PLUGINS="$dir"
done

if [ -z "$IDEA_PLUGINS" ]; then
    echo "[ERROR] Could not find IntelliJ IDEA plugins directory under $JB_ROOT"
    exit 1
fi

echo "[1/3] Building plugin..."
(cd "$PLUGIN_DIR" && ./gradlew buildPlugin -q)

# Find the zip AFTER the build completes
DIST_ZIP="$(ls -t "$PLUGIN_DIR/build/distributions/moe-jetbrains-"*.zip 2>/dev/null | head -1)"
if [ -z "$DIST_ZIP" ] || [ ! -f "$DIST_ZIP" ]; then
    echo "[ERROR] Build artifact not found in $PLUGIN_DIR/build/distributions/"
    exit 1
fi

echo "[2/3] Installing $DIST_ZIP to $IDEA_PLUGINS ..."
rm -rf "$IDEA_PLUGINS/moe-jetbrains"
unzip -qo "$DIST_ZIP" -d "$IDEA_PLUGINS/"
echo "[OK] Plugin installed."

if [ "$NO_RESTART" = true ]; then
    echo "Skipping IDE restart (--no-restart)."
    exit 0
fi

echo "[3/3] Restarting IntelliJ IDEA..."
# Kill IntelliJ IDEA gracefully via osascript on macOS, fall back to pkill
if [[ "$OSTYPE" == "darwin"* ]]; then
    osascript -e 'tell application "IntelliJ IDEA" to quit' 2>/dev/null || true
    # Wait for it to actually exit
    for i in {1..10}; do
        pgrep -f "IntelliJ IDEA" >/dev/null 2>&1 || break
        sleep 1
    done
    # Force kill if still running
    pkill -f "IntelliJ IDEA" 2>/dev/null || true
    sleep 2
    open -a "IntelliJ IDEA"
else
    pkill -f "idea" 2>/dev/null || true
    sleep 2
    # On Linux try common locations
    idea_bin="$(command -v idea 2>/dev/null || echo "")"
    if [ -n "$idea_bin" ]; then
        nohup "$idea_bin" >/dev/null 2>&1 &
    else
        echo "[WARN] Could not find 'idea' command. Please restart the IDE manually."
    fi
fi
echo "[OK] Done."
