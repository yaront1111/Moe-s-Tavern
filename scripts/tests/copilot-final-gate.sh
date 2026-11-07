#!/usr/bin/env bash
# copilot-final-gate.sh -- the epic-final regression gate of the GitHub Copilot CLI provider: task-59e1d150's
# checkRefs[0], run as `timeout 1200s bash scripts/tests/copilot-final-gate.sh` from the repo or task-worktree
# root on a Windows drive under WSL (/mnt/<x>/...). Leg D (docs anchors) runs first; then four legs run in
# parallel, each with its own log in $L:
#   W  wrappers   copilot-guards-gate.sh (vm-route on bash, 5.1 and pwsh 7 with every copilot row, bash -n and
#                 ParseFile, both parity checks, lint, mutants), then protected-agent-command.test.mjs (bash rows)
#   J  JetBrains  gradlew.bat test --rerun through cmd.exe (WSL has no JDK): fresh TEST-*.xml, tests > 0, no failures
#   V  VS Code    npm ci, npm test and npm run compile in a git-archive snapshot $S outside the checkout
#   P  packages   in the same $S: moe-proxy and moe-daemon npm ci + build, the daemon's workerType.test.ts, and the
#                 smoke driver's offline row (a missing copilot CLI must give one BLOCKED line and exit 3)
# The caller holds the jetbrains-gradle lease. npm runs only in $S, never in the checkout; no full postflight runs.
# A missing tool exits 2, never a skip. PASS needs D and all four legs. An interrupt signals only the recorded
# leg PIDs (each forwards it to its one bounded child); the gate removes only its own $S and keeps $L on failure.
# WSL interop does not pass that signal on to the Windows Gradle leg J started: it runs its :test to the end (about
# a minute), and a rerun started before then fails on moe-jetbrains/build/test-results (NoSuchFileException).
#
# macOS profile (uname -s Darwin, bash 3.2): a Mac has no WSL, Windows PowerShell, pwsh or (here) JDK, so the legs that
# need them cannot run and are never faked. D, V and P run as above. W is the bash-only subset: bash -n of the wrapper
# and this gate, parity-check.sh, npm run lint and protected-agent-command.test.mjs. J runs `./gradlew test --rerun`
# only when `java -version` answers. Every leg that cannot run is named in a SKIP line, and the last line is
# `PASS copilot-final-gate-mac (skipped: <legs>)`: only the WSL profile prints the bare `PASS copilot-final-gate`.
# The Windows rows are owned by task-ba574a26, the macOS port of postflight-vm-route.sh by task-d95ce3aa.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" || exit 2
cd "$ROOT" || exit 2
unset ${!MOE_*} ${!CLAUDE*} ${!FAKE_*}
case "$(uname -s)" in
  Darwin) HOST=mac ;;
  Linux) HOST=wsl ;;
  *) echo "GATE: unsupported host $(uname -s): run on WSL (/mnt/<x>/...) or macOS" >&2; exit 2 ;;
esac
TMO=timeout
if [ "$HOST" = mac ]; then
  command -v timeout >/dev/null 2>&1 || { command -v gtimeout >/dev/null 2>&1 && TMO=gtimeout; }
  for tool in node npm git tar "$TMO"; do
    command -v "$tool" >/dev/null 2>&1 || { echo "GATE: required tool '$tool' not found on PATH; the gate never skips a leg" >&2; exit 2; }
  done
else
  echo "[gate] the JetBrains leg needs the caller to hold the jetbrains-gradle lease"
  for tool in node npm git wslpath cmd.exe powershell.exe pwsh.exe timeout tar; do
    command -v "$tool" >/dev/null 2>&1 || { echo "GATE: required tool '$tool' not found on PATH; the gate never skips a leg" >&2; exit 2; }
  done
  [ -x /init ] || { echo "GATE: /init is missing: the Windows legs are launched through it (WSL only)" >&2; exit 2; }
  case "$ROOT" in /mnt/[a-z]/*) ;; *) echo "GATE: run from a checkout on a Windows drive (/mnt/<x>/...), not $ROOT" >&2; exit 2 ;; esac
  CMD=(/init "$(command -v cmd.exe)")
  WROOT="$(wslpath -w "$ROOT")" || exit 2
fi
L="$(mktemp -d /tmp/copilot-final-gate.XXXXXX)" || exit 2
S="$(mktemp -d /tmp/copilot-final-gate-snap.XXXXXX)" || exit 2
STATUS=1
# Per-leg state lives in PID_<leg> and RC_<leg> variables: bash 3.2 has no associative arrays.
on_exit() {
  case "$S" in /tmp/copilot-final-gate-snap.?*) rm -rf -- "$S" ;; esac
  if [ "$STATUS" -eq 0 ]; then rm -rf -- "$L"; else echo "GATE: logs kept at $L" >&2; fi
}
# Only the legs not yet collected are signalled: a collected PID may already belong to another process.
on_signal() {
  local leg pid
  for leg in W J V P; do
    pid=PID_$leg
    [ -z "${!pid:-}" ] || kill -TERM "${!pid}" 2>/dev/null || true
  done
  wait
  exit 130
}
trap on_exit EXIT
trap on_signal INT TERM
CHILD=
leg_trap() { trap 'kill -TERM "$CHILD" 2>/dev/null; exit 143' INT TERM; }
bounded() { # $1 = seconds, then the command: runs under `timeout` as this leg's one recorded child
  "$TMO" "$@" &
  CHILD=$!
  wait "$CHILD"
}

# ---- D. Docs anchors (synchronous; the other legs run whatever it says) --------------------------------------
docs_leg() {
  node - "$ROOT" <<'JS'
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const codes = ['MOE_COPILOT_NOT_FOUND', 'MOE_COPILOT_CONFIG_FAILED', 'MOE_COPILOT_SIGNED_OUT', 'MOE_COPILOT_NOT_ENTITLED', 'MOE_COPILOT_MCP_BLOCKED'];
const want = {
  'scripts/CLAUDE.md': [...codes, 'copilot-smoke.mjs', 'All five CLIs', 'Grok, Copilot or interactive Claude'],
  'docs/TROUBLESHOOTING.md': [...codes, 'MOE_CLI_ARGV_REJECTED: the installed copilot'],
  'docs/CONFIGURATION.md': ['MOE_COPILOT_MODEL', 'MOE_COPILOT_EFFORT', '`GROK` or `COPILOT`', '`copilot` → `COPILOT`'],
  'docs/SCHEMA.md': ['GROK or COPILOT'],
  'README.md': ['GitHub Copilot CLI'],
  'docs/PRD.md': ['GitHub Copilot CLI'],
};
let stale = 0;
const miss = (file, needle) => { stale++; console.log(`DOCS STALE: ${file}: ${needle}`); };
const text = {};
for (const [file, needles] of Object.entries(want)) {
  try { text[file] = fs.readFileSync(path.join(root, file), 'utf8'); } catch { miss(file, '(unreadable)'); continue; }
  for (const needle of needles) if (!text[file].includes(needle)) miss(file, needle);
}
const row = (text['docs/CONFIGURATION.md'] || '').split(/\r?\n/).find(line => line.startsWith('| `agentCommand` |'));
if (!row || !row.includes('`copilot`')) miss('docs/CONFIGURATION.md', "the '| `agentCommand` |' row names `copilot`");
if ((text['docs/PRD.md'] || '').includes('Autocomplete only')) miss('docs/PRD.md', 'still says Autocomplete only');
if (stale) { console.log(`DOCS FAIL: ${stale} stale anchor(s)`); process.exit(1); }
console.log(`DOCS OK: ${Object.keys(want).length} files, every copilot anchor present`);
JS
}

# ---- Legs ------------------------------------------------------------------------------------------------------
w_protected() { # protected-agent-command.test.mjs on bash: the copilot rows must pass, not skip
  local rc row
  bounded 600 node --test --test-reporter=tap scripts/tests/protected-agent-command.test.mjs < /dev/null > "$L/W-protected.log" 2>&1; rc=$?
  cat "$L/W-protected.log"
  [ "$rc" -eq 0 ] || { echo "W: protected-agent-command.test.mjs exited $rc"; return 1; }
  for row in 'bash: CP1 ' 'bash: CP2 ' 'bash: R1 '; do
    grep -E "^ *ok [0-9]+ - $row" "$L/W-protected.log" | grep -qv '# SKIP' || { echo "W: no passing, unskipped '$row' row"; return 1; }
  done
}
leg_w() {
  local rc
  leg_trap
  bounded 1150 bash scripts/tests/copilot-guards-gate.sh < /dev/null > "$L/W-guards.log" 2>&1; rc=$?
  tr -d '\r\0' < "$L/W-guards.log"
  [ "$rc" -eq 0 ] && grep -q '^PASS copilot-guards-gate$' "$L/W-guards.log" || { echo "W: copilot-guards-gate.sh exited $rc without PASS"; return 1; }
  w_protected || return 1
  echo "LEG_OK W"
}
leg_w_mac() { # copilot-guards-gate.sh hard-requires WSL, so the bash-only steps run here directly
  local rc
  leg_trap
  bash -n scripts/moe-agent.sh || { echo "W: bash -n scripts/moe-agent.sh failed"; return 1; }
  bash -n scripts/tests/copilot-final-gate.sh || { echo "W: bash -n scripts/tests/copilot-final-gate.sh failed"; return 1; }
  bounded 300 bash scripts/tests/parity-check.sh < /dev/null > "$L/W-parity.log" 2>&1; rc=$?
  cat "$L/W-parity.log"
  [ "$rc" -eq 0 ] && grep -q '^PASS parity-check.sh$' "$L/W-parity.log" || { echo "W: parity-check.sh exited $rc without PASS"; return 1; }
  bounded 300 npm run lint < /dev/null || { echo "W: npm run lint failed"; return 1; }
  w_protected || return 1
  echo "LEG_OK W"
}
# An UP-TO-DATE or skipped :test writes no fresh XML, so it can never count green.
j_xml_check() { # $1 = the leg's start time in epoch ms
  node - "$ROOT/moe-jetbrains/build/test-results/test" "$1" <<'JS'
const fs = require('fs');
const path = require('path');
const [dir, start] = process.argv.slice(2);
let files = 0, tests = 0, bad = 0, stale = 0;
for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => /^TEST-.*\.xml$/.test(n)) : []) {
  const file = path.join(dir, name);
  if (fs.statSync(file).mtimeMs < Number(start) - 2000) { stale++; continue; }
  const head = /<testsuite\b[^>]*>/.exec(fs.readFileSync(file, 'utf8'))?.[0] ?? '';
  const attr = key => Number(new RegExp(`\\b${key}="(\\d+)"`).exec(head)?.[1] ?? NaN);
  files++; tests += attr('tests'); bad += attr('failures') + attr('errors');
}
console.log(`J: fresh TEST-*.xml ${files} (stale ${stale}), tests ${tests}, failures+errors ${bad}`);
process.exit(files > 0 && tests > 0 && bad === 0 ? 0 : 1);
JS
}
leg_j() {
  local start
  leg_trap
  start="$(date +%s%3N)"
  bounded 900 "${CMD[@]}" /d /c "set GRADLE_OPTS=-Xmx512m&& cd /d $WROOT\\moe-jetbrains && gradlew.bat test --rerun" < /dev/null || { echo "J: gradlew.bat test failed (a NoSuchFileException under build/test-results means a Gradle from an interrupted earlier gate was still running: let it finish, then rerun)"; return 1; }
  j_xml_check "$start" || return 1
  echo "LEG_OK J"
}
leg_j_mac() { # only launched when a JDK answers; date +%3N is GNU-only, so the clock is node's
  local start
  leg_trap
  start="$(node -e 'console.log(Date.now())')" || return 1
  export GRADLE_OPTS=-Xmx512m
  cd "$ROOT/moe-jetbrains" && bounded 900 ./gradlew test --rerun < /dev/null || { echo "J: ./gradlew test failed"; return 1; }
  j_xml_check "$start" || return 1
  echo "LEG_OK J"
}
leg_v() {
  leg_trap
  cd "$S/moe-vscode" || return 1
  bounded 600 npm ci --no-audit --no-fund < /dev/null || { echo "V: npm ci failed"; return 1; }
  bounded 600 npm test < /dev/null || { echo "V: npm test failed"; return 1; }
  bounded 600 npm run compile < /dev/null || { echo "V: npm run compile failed"; return 1; }
  echo "LEG_OK V"
}
leg_p() {
  local rc
  leg_trap
  cp "$ROOT/scripts/tests/copilot-smoke.mjs" "$S/scripts/tests/copilot-smoke.mjs" || return 1
  cd "$S/packages/moe-proxy" && bounded 600 npm ci --no-audit --no-fund < /dev/null && bounded 300 npm run build < /dev/null || { echo "P: moe-proxy install/build failed"; return 1; }
  cd "$S/packages/moe-daemon" && bounded 600 npm ci --no-audit --no-fund < /dev/null && bounded 300 npm run build < /dev/null || { echo "P: moe-daemon install/build failed"; return 1; }
  bounded 300 npx vitest run src/tools/workerType.test.ts < /dev/null || { echo "P: workerType.test.ts failed"; return 1; }
  # The driver's offline row: a real daemon, board, fixture, wrapper pre-flight and claim, with no model call.
  bounded 300 node "$S/scripts/tests/copilot-smoke.mjs" sh --command "$S/no-such-dir/copilot" < /dev/null > "$L/P-smoke.log" 2>&1; rc=$?
  tail -n 8 "$L/P-smoke.log"
  [ "$rc" -eq 3 ] || { echo "P: the offline smoke row exited $rc, not 3 (BLOCKED)"; return 1; }
  [ "$(grep -c '^BLOCKED copilot-smoke sh: ' "$L/P-smoke.log")" -eq 1 ] && grep '^BLOCKED copilot-smoke sh: ' "$L/P-smoke.log" | grep -q MOE_COPILOT_NOT_FOUND \
    || { echo "P: expected exactly one 'BLOCKED copilot-smoke sh: ' line naming MOE_COPILOT_NOT_FOUND"; return 1; }
  echo "LEG_OK P"
}

# ---- Run: D first, then W, J, V and P in parallel; every exit code is collected -------------------------------
START=$SECONDS
LEGS="W J V P"
NAME=copilot-final-gate
WLEG=leg_w
JLEG=leg_j
SKIPPED=
skip() { # $1 = a leg or smoke name, $2 = why: a leg that cannot run is named here, never dropped
  echo "SKIP $1: $2"
  SKIPPED="${SKIPPED:+$SKIPPED, }$1"
}
java_ok() { if [ -n "${JAVA_HOME:-}" ]; then "$JAVA_HOME/bin/java" -version; else java -version; fi > /dev/null 2>&1; }
if [ "$HOST" = mac ]; then
  NAME=copilot-final-gate-mac
  WLEG=leg_w_mac
  JLEG=leg_j_mac
  if java_ok; then
    echo "[gate] the JetBrains leg needs the caller to hold the jetbrains-gradle lease"
  else
    LEGS="W V P"
    skip J "no JDK on this host (needs gradlew.bat on a Windows/WSL host; task-ba574a26)"
  fi
  skip W-ps1 "no Windows PowerShell 5.1 on macOS: the vm-route.ps1, ParseFile and parity-check.ps1 rows (task-ba574a26)"
  skip W-pwsh7 "the pwsh 7 rows run in the WSL guards gate, which hard-requires WSL (task-ba574a26)"
  skip W-mutants "the parity mutants of the guards gate run on Windows PowerShell 5.1 (task-ba574a26)"
  skip W-vmroute-sh "postflight-vm-route.sh is not macOS-portable: an unresolved /var temp path and an empty array under set -u on bash 3.2 (task-d95ce3aa)"
  skip smoke-ps1 "the Windows PowerShell 5.1 smoke needs Windows (task-ba574a26)"
fi
docs_leg 2>&1 | tee "$L/D.log"; RC_D=${PIPESTATUS[0]}
git -C "$ROOT" archive HEAD | tar -x -C "$S" || { echo "GATE FAIL: cannot extract a snapshot of HEAD into $S"; exit 1; }
( "$WLEG" ) > "$L/W.log" 2>&1 & PID_W=$!
case " $LEGS " in *" J "*) ( "$JLEG" ) > "$L/J.log" 2>&1 & PID_J=$! ;; esac
( leg_v ) > "$L/V.log" 2>&1 & PID_V=$!
( leg_p ) > "$L/P.log" 2>&1 & PID_P=$!
for leg in $LEGS; do
  pid=PID_$leg
  wait "${!pid}"; printf -v "RC_$leg" %s "$?"
  unset "PID_$leg"
done
failed=0
for leg in $LEGS; do
  rc=RC_$leg
  echo "=== leg $leg: exit ${!rc} (last lines of $L/$leg.log)"
  tr -d '\r\0' < "$L/$leg.log" | tail -n 15
  # A leg that returned 0 without reaching its last line (LEG_OK) still fails.
  if [ "${!rc}" -eq 0 ] && ! grep -q "^LEG_OK $leg\$" "$L/$leg.log"; then printf -v "RC_$leg" %s 1; fi
done
echo "leg  verdict  exit"
for leg in D $LEGS; do
  rc=RC_$leg
  if [ "${!rc}" -eq 0 ]; then verdict=PASS; else verdict=FAIL; failed=1; fi
  printf '%-4s %-8s %s\n' "$leg" "$verdict" "${!rc}"
done
echo "wall $((SECONDS - START)) s"
[ "$failed" -eq 0 ] || { echo "FAIL $NAME"; exit 1; }
STATUS=0
if [ "$HOST" = mac ]; then echo "PASS $NAME (skipped: $SKIPPED)"; else echo "PASS $NAME"; fi
