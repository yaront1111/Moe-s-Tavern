#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="${1:-"$(cd "$(dirname "$0")/.." && pwd)"}"
PROPS="$PROJECT_ROOT/gradle/wrapper/gradle-wrapper.properties"

if [ ! -f "$PROPS" ]; then
  echo "gradle-wrapper.properties not found at $PROPS" >&2
  exit 1
fi

url=$(grep -E '^distributionUrl=' "$PROPS" | head -n 1 | cut -d= -f2- | sed 's/\\//g')
if [ -z "$url" ]; then
  echo "distributionUrl not found in gradle-wrapper.properties" >&2
  exit 1
fi

file=$(basename "$url")
version="$file"
if [[ "$file" =~ ^gradle-(.+)-bin\.zip$ ]]; then
  version="${BASH_REMATCH[1]}"
fi

DIST_ROOT="$PROJECT_ROOT/.gradle-dist"
DIST_DIR="$DIST_ROOT/gradle-$version"
GRADLE_BIN="$DIST_DIR/bin/gradle"

if [ -x "$GRADLE_BIN" ]; then
  echo "$GRADLE_BIN"
  exit 0
fi

mkdir -p "$DIST_ROOT"
ZIP="$DIST_ROOT/$file"

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$url" -o "$ZIP"
elif command -v wget >/dev/null 2>&1; then
  wget -q "$url" -O "$ZIP"
else
  python3 - <<'PY'
import sys, urllib.request
url = sys.argv[1]
zip_path = sys.argv[2]
urllib.request.urlretrieve(url, zip_path)
PY
  "$url" "$ZIP"
fi

python3 - <<'PY'
import sys, zipfile
zip_path, dest = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(zip_path, 'r') as zf:
    zf.extractall(dest)
PY
"$ZIP" "$DIST_ROOT"

if [ ! -x "$GRADLE_BIN" ]; then
  echo "Gradle not found at $GRADLE_BIN" >&2
  exit 1
fi

echo "$GRADLE_BIN"
