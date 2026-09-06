#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
agent_command=claude
while [ "$#" -gt 0 ]; do
    case "$1" in
        --agent|--agent-command)
            [ "$#" -ge 2 ] || { printf 'Missing agent after --agent\n' >&2; exit 1; }
            agent_command=$2
            shift 2
            ;;
        --help|-h) printf 'Usage: bash scripts/install-all.sh [--agent claude|codex|gemini|none]\nFor the board plugin, use install-mac.sh --global --skip-mcp --with-plugin.\n'; exit 0 ;;
        *) printf 'Unknown option: %s\n' "$1" >&2; exit 1 ;;
    esac
done
source "$root/scripts/install-dependencies.sh"
moe_install_dependencies "$agent_command" false

printf "Installing Moe daemon...\n"
cd "$root/packages/moe-daemon"
npm install
npm run build

printf "Installing Moe proxy...\n"
cd "$root/packages/moe-proxy"
npm install
npm run build

# Write global install config (~/.moe/config.json) -- matches install-all.ps1
# so the agent wrappers can resolve daemon/proxy paths when not run from $root.
moe_home="$HOME/.moe"
mkdir -p "$moe_home"
node - "$moe_home/config.json" "$root" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [configPath, installPath] = process.argv.slice(2);
const { version } = JSON.parse(fs.readFileSync(path.join(installPath, 'packages/moe-daemon/package.json'), 'utf8'));
fs.writeFileSync(configPath, JSON.stringify({ installPath, version, updatedAt: new Date().toISOString() }, null, 2) + '\n');
NODE
printf "Wrote global config to %s/config.json\n" "$moe_home"

printf "Done. Next steps:\n"
printf '1) Initialize your project: node "%s/packages/moe-daemon/dist/index.js" init --project <path>\n' "$root"
printf "2) Build plugin: open moe-jetbrains in your JetBrains IDE and run Gradle task buildPlugin\n"
