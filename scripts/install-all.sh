#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

printf "Installing Moe daemon...\n"
cd "$root/packages/moe-daemon"
npm install
npm run build

printf "Installing Moe proxy...\n"
cd "$root/packages/moe-proxy"
npm install
npm run build

printf "Done. Next steps:\n"
printf "1) Start daemon: node packages/moe-daemon/dist/index.js start --project <path>\n"
printf "2) Build plugin: open moe-jetbrains in PyCharm and run Gradle task buildPlugin\n"
