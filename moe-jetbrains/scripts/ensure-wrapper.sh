#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="${1:-"$(cd "$(dirname "$0")/.." && pwd)"}"
WRAPPER_DIR="$PROJECT_ROOT/gradle/wrapper"
PROPS="$WRAPPER_DIR/gradle-wrapper.properties"
DEST="$WRAPPER_DIR/gradle-wrapper.jar"

if [ -f "$DEST" ]; then
  python3 - <<'PY' "$DEST" "$WRAPPER_DIR/gradle-wrapper-shared.jar" "$WRAPPER_DIR/gradle-cli.jar" || exit 1
import sys, zipfile, os
main_jar = sys.argv[1]
shared_jar = sys.argv[2]
cli_jar = sys.argv[3]
def has_class(path, class_name):
    try:
        with zipfile.ZipFile(path, 'r') as zf:
            return class_name in zf.namelist()
    except Exception:
        return False
has_main = has_class(main_jar, "org/gradle/wrapper/GradleWrapperMain.class")
has_download = has_class(main_jar, "org/gradle/wrapper/IDownload.class")
if has_main and has_download:
    raise SystemExit(0)
shared_ok = os.path.exists(shared_jar) and has_class(shared_jar, "org/gradle/wrapper/IDownload.class")
cli_ok = os.path.exists(cli_jar) and has_class(cli_jar, "org/gradle/cli/CommandLineParser.class")
if has_main and shared_ok and cli_ok:
    raise SystemExit(0)
raise SystemExit(2)
PY
  status=$?
  if [ "$status" -eq 0 ]; then
    exit 0
  fi
  rm -f "$DEST"
  rm -f "$WRAPPER_DIR/gradle-wrapper-shared.jar"
  rm -f "$WRAPPER_DIR/gradle-cli.jar"
fi

if [ ! -f "$PROPS" ]; then
  echo "gradle-wrapper.properties not found at $PROPS" >&2
  exit 1
fi

url=$(grep -E '^distributionUrl=' "$PROPS" | head -n 1 | cut -d= -f2- | sed 's/\\//g')
if [ -z "$url" ]; then
  echo "distributionUrl not found in gradle-wrapper.properties" >&2
  exit 1
fi

tmp_dir=$(mktemp -d)
zip="$tmp_dir/gradle.zip"

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$url" -o "$zip"
elif command -v wget >/dev/null 2>&1; then
  wget -q "$url" -O "$zip"
else
  python3 - <<'PY'
import sys, urllib.request
url = sys.argv[1]
zip_path = sys.argv[2]
urllib.request.urlretrieve(url, zip_path)
PY
  "$url" "$zip"
fi

python3 - <<'PY'
import sys, zipfile
zip_path, dest = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(zip_path, 'r') as zf:
    candidates = [n for n in zf.namelist() if n.endswith('.jar') and '/lib/' in n]
    if not candidates:
        raise SystemExit('no jar files found in distribution')

    def find_class(name, class_path):
        try:
            with zf.open(name) as jar:
                with zipfile.ZipFile(jar) as jz:
                    return class_path in jz.namelist()
        except Exception:
            return False

    main = None
    shared = None
    cli = None
    for name in candidates:
        if find_class(name, "org/gradle/wrapper/GradleWrapperMain.class"):
            main = name
        if find_class(name, "org/gradle/wrapper/IDownload.class"):
            shared = name
        if find_class(name, "org/gradle/cli/CommandLineParser.class"):
            cli = name

    if not main:
        preferred = [n for n in candidates if 'gradle-wrapper' in n and 'shared' not in n]
        main = (preferred or candidates)[0]

    with zf.open(main) as src, open(dest, 'wb') as dst:
        dst.write(src.read())

    if shared:
        shared_dest = dest.replace('gradle-wrapper.jar', 'gradle-wrapper-shared.jar')
        with zf.open(shared) as src, open(shared_dest, 'wb') as dst:
            dst.write(src.read())
    if not cli:
        for name in candidates:
            if 'gradle-cli' in name:
                cli = name
                break
    if cli:
        cli_dest = dest.replace('gradle-wrapper.jar', 'gradle-cli.jar')
        with zf.open(cli) as src, open(cli_dest, 'wb') as dst:
            dst.write(src.read())
PY
"$zip" "$DEST"

rm -rf "$tmp_dir"
echo "Installed gradle-wrapper.jar"
