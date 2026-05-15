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

# Write global install config (~/.moe/config.json) -- matches install-all.ps1
# so the agent wrappers can resolve daemon/proxy paths when not run from $root.
moe_home="$HOME/.moe"
mkdir -p "$moe_home"
python3 - "$moe_home/config.json" "$root" <<'PYEOF'
import json, sys, datetime
cfg_path = sys.argv[1]
install_path = sys.argv[2]
cfg = {
    "installPath": install_path,
    "version": "0.1.0",
    "updatedAt": datetime.datetime.utcnow().isoformat() + "Z",
}
with open(cfg_path, "w") as f:
    json.dump(cfg, f, indent=2)
PYEOF
printf "Wrote global config to %s/config.json\n" "$moe_home"

printf "Done. Next steps:\n"
printf "1) Start daemon: node packages/moe-daemon/dist/index.js start --project <path>\n"
printf "2) Build plugin: open moe-jetbrains in PyCharm and run Gradle task buildPlugin\n"
