#!/usr/bin/env bash
# copilot-guards-gate.sh -- the bounded verification gate of the GitHub Copilot
# seat guards (argv probe, sign-in line, routed effort/model): task-e266a150's
# checkRefs[0], run as `timeout 1200s bash scripts/tests/copilot-guards-gate.sh`
# from a checkout on a Windows drive under WSL. It replaces the full launcher
# postflight, which does not fit the 20-minute gate budget, with four parallel
# legs, each with its own log:
#   bash        bash -n scripts/moe-agent.sh, postflight-vm-route.sh, parity-check.sh, npm run lint
#   powershell  postflight-vm-route.ps1 on Windows PowerShell 5.1, ParseFile of moe-agent.ps1, parity-check.ps1
#   pwsh        the same three steps on PowerShell 7
#   mutants     copied validators against mutated copies of both wrappers (scratch only):
#               a pristine copy passes; one pinned copilot string removed from ONE wrapper, an
#               unpaired MOE_COPILOT_ token in one wrapper, and MOE_COPILOT_EFFORT removed from
#               BOTH wrappers are each rejected by parity-check.sh AND parity-check.ps1 (5.1)
# A missing engine is a hard failure, never a skip. Any leg's failure fails the gate.
# The gate never edits the checkout, builds a package, runs the full postflight or
# signals a process it did not start (an interrupt stops only the legs' recorded PIDs
# and their descendants). Logs and scratch are kept on failure and removed on success.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TESTS="$ROOT/scripts/tests"
LEG_TIMEOUT=1100
die() { echo "GATE FAIL: $*" >&2; exit 1; }

# ---- 0. Hard requirements -----------------------------------------------------
for tool in bash node python3 npm wslpath timeout powershell.exe pwsh.exe; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool '$tool' not found on PATH (the gate needs bash, node, python3, npm, Windows PowerShell 5.1 and pwsh 7; it never skips an engine)"
done
[ -x /init ] || die "/init is missing: Windows binaries are launched through it (WSL only)"
case "$ROOT" in /mnt/[a-z]/*) ;; *) die "run from a checkout on a Windows drive (/mnt/<x>/...); the Windows legs cannot open $ROOT" ;; esac
drive="${ROOT#/mnt/}"; drive="${drive%%/*}"
SCRATCH_BASE="/mnt/$drive/moe-scratch"
mkdir -p "$SCRATCH_BASE" || die "cannot create $SCRATCH_BASE"
# The seat's identity and fixtures must not reach the harnesses (WSL interop forwards the environment).
while IFS= read -r v; do unset "$v"; done < <(compgen -e | grep -E '^(MOE_|CLAUDE|FAKE_)' || true)
export MOE_POSTFLIGHT_TIMEOUT_SEC=360 WSLENV=MOE_POSTFLIGHT_TIMEOUT_SEC
PWSH7=(/init "$(command -v pwsh.exe)")
PS51=(/init "$(command -v powershell.exe)")

S="$(mktemp -d "$SCRATCH_BASE/copilot-guards-gate.XXXXXX")" || die "cannot create a scratch dir under $SCRATCH_BASE"
STATUS=1
declare -A PID=()
cleanup() {
  if [ "$STATUS" -eq 0 ]; then
    case "$S" in "$SCRATCH_BASE"/copilot-guards-gate.*) rm -rf -- "$S" ;; esac
  else
    echo "GATE: logs and scratch kept at $S" >&2
  fi
}
# An interrupt signals only the PIDs this gate recorded: each leg's subshell, which forwards the signal to
# the one bounded child it started (CHILD; `timeout` passes it to its command). No name or command-line
# match, no process group, and nothing another seat started is ever signalled.
on_signal() {
  local p
  for p in "${PID[@]}"; do kill -TERM "$p" 2>/dev/null || true; done
  wait
  STATUS=130; exit 130
}
trap cleanup EXIT
trap on_signal INT TERM
CHILD=
leg_trap() { trap 'kill -TERM "$CHILD" 2>/dev/null; exit 143' INT TERM; }
bounded() { # $1 = seconds, then the command: runs it under `timeout` as this leg's one recorded child
  timeout "$@" &
  CHILD=$!
  wait "$CHILD"
}

# ---- 1. Legs ------------------------------------------------------------------
# ParseFile with its errors initialised, printed and turned into a nonzero exit (no double quotes: it
# crosses the Windows command line).
PARSE_PS='$x=$null;[void][Management.Automation.Language.Parser]::ParseFile((Resolve-Path ../moe-agent.ps1),[ref]$null,[ref]$x);if($x){$x|ForEach-Object{Write-Host PARSE_ERROR $_.Message};exit 1};Write-Host PARSE_OK'

bash_leg() {
  leg_trap; cd "$TESTS" || return 1
  bounded 300 bash -n ../moe-agent.sh || return 1
  bounded "$LEG_TIMEOUT" bash postflight-vm-route.sh < /dev/null || return 1
  bounded 300 bash parity-check.sh || return 1
  cd "$ROOT" && bounded 600 npm run lint || return 1
  echo "LEG_OK bash"
}
win_leg() { # $1 = engine word cmd runs (powershell|pwsh); the rest = the interop prefix of that engine's exe
  local engine="$1"; shift
  leg_trap; cd "$TESTS" || return 1
  # The established bridge: pwsh -> cmd -> engine, so Windows PowerShell 5.1 runs the harness natively.
  bounded "$LEG_TIMEOUT" "${PWSH7[@]}" -nop -c "cmd /c $engine -nop -ep Bypass -f postflight-vm-route.ps1; exit \$LASTEXITCODE" || return 1
  bounded 300 "$@" -nop -c "$PARSE_PS" || return 1
  bounded 300 "$@" -nop -ep Bypass -f parity-check.ps1 || return 1
  echo "LEG_OK $engine"
}

# ---- 2. Mutants: copied validators against mutated copies of the wrappers -------
MUT_EXPECTED=16  # pristine 2 + (2 wrappers x 2 pins) x 2 validators + (2 wrappers) x 2 + 1 x 2
mut_fail() { echo "[mutants] FAIL: $*"; return 1; }
stage() { # $1 = case name; a fresh copy of the pristine tree, printed
  local d="$S/case-$1"
  mkdir -p "$d/scripts/tests" && cp "$S/pristine/scripts/"moe-agent.* "$d/scripts/" && cp "$S/pristine/scripts/tests/"* "$d/scripts/tests/" && echo "$d"
}
mutate() { # $1 file, $2 needle, $3 replacement ('' deletes): every occurrence, byte-preserving; prints the count
  node -e '
    const fs = require("fs");
    const [f, needle, rep] = process.argv.slice(1);
    const bin = (t) => Buffer.from(t, "utf8").toString("latin1");
    const parts = fs.readFileSync(f).toString("latin1").split(bin(needle));
    if (parts.length < 2) { console.error("needle not found in " + f + ": " + needle); process.exit(3); }
    fs.writeFileSync(f, Buffer.from(parts.join(bin(rep)), "latin1"));
    console.log(parts.length - 1);
  ' "$1" "$2" "$3"
}
run_validator() { # $1 = sh|ps; $2 = case dir. Prints the cleaned output, returns the validator's own status
  local out rc
  if [ "$1" = sh ]; then
    out="$(cd "$2" && timeout 300 bash scripts/tests/parity-check.sh < /dev/null 2>&1)"; rc=$?
  else
    out="$(cd "$2/scripts/tests" && timeout 300 "${PS51[@]}" -nop -ep Bypass -f "$(wslpath -w "$2/scripts/tests/parity-check.ps1")" 2>&1)"; rc=$?
  fi
  printf '%s\n' "$out" | tr -d '\r\0'
  return "$rc"
}
expect() { # $1 label, $2 case dir, $3 = pass|reject, $4.. needles that must share one output line (reject only)
  local label="$1" dir="$2" want="$3" v out rc n ok; shift 3
  for v in sh ps; do
    out="$(run_validator "$v" "$dir")"; rc=$?
    if [ "$want" = pass ]; then
      [ "$rc" -eq 0 ] && printf '%s\n' "$out" | grep '^PASS parity-check' > /dev/null || { printf '%s\n' "$out" | tail -5; mut_fail "$label: $v validator did not pass a pristine copy (rc=$rc)"; return 1; }
    else
      [ "$rc" -eq 0 ] && { mut_fail "$label: $v validator PASSED the mutant"; return 1; }
      { [ "$rc" -eq 1 ] && printf '%s\n' "$out" | grep 'FAIL parity-check' > /dev/null; } \
        || { printf '%s\n' "$out" | tail -5; mut_fail "$label: $v validator gave no verdict (rc=$rc: a launch or timeout error, not a parity failure)"; return 1; }
      ok="$(printf '%s\n' "$out")"
      for n in "$@"; do ok="$(printf '%s\n' "$ok" | grep -F -- "$n" || true)"; done
      [ -n "$ok" ] || { printf '%s\n' "$out" | tail -8; mut_fail "$label: $v validator failed, but no output line names: $*"; return 1; }
    fi
    echo "[mutants] ok $label ($v)"
  done
}
mutants_leg() {
  local w d n key pin
  leg_trap
  mkdir -p "$S/pristine/scripts/tests" || return 1
  cp "$ROOT/scripts/"moe-agent.sh "$ROOT/scripts/"moe-agent.ps1 "$S/pristine/scripts/" || return 1
  for n in parity-check.sh parity-check.ps1 postflight.sh postflight.ps1 postflight-fake-proxy.js; do
    cp "$TESTS/$n" "$S/pristine/scripts/tests/$n" || return 1
  done
  d="$(stage pristine)" || return 1
  expect pristine "$d" pass || return 1
  # One pinned copilot string removed from ONE wrapper: both validators must name it and that wrapper.
  for w in sh ps1; do
    for key in banner argv; do
      if [ "$key" = banner ]; then pin='Copilot mode: headless'; else pin='MOE_CLI_ARGV_REJECTED: the installed copilot ('; fi
      d="$(stage "pin-$w-$key")" || return 1
      n="$(mutate "$d/scripts/moe-agent.$w" "$pin" 'removed-copilot-pin')" && [ "${n:-0}" -gt 0 ] || { mut_fail "no occurrence of '$pin' in moe-agent.$w"; return 1; }
      [ "$(head -c3 "$d/scripts/moe-agent.ps1" | od -An -tx1 | tr -d ' \n')" = efbbbf ] || { mut_fail "the staged moe-agent.ps1 lost its BOM"; return 1; }
      expect "'$pin' removed from moe-agent.$w only" "$d" reject "$pin" "moe-agent.$w" || return 1
    done
  done
  # An unpaired MOE_COPILOT_ token in one wrapper: the compared family, not just the fixed pins, must catch it.
  for w in sh ps1; do
    d="$(stage "token-$w")" || return 1
    printf '\n# MOE_COPILOT_TEST_ONLY\n' >> "$d/scripts/moe-agent.$w"
    expect "MOE_COPILOT_TEST_ONLY only in moe-agent.$w" "$d" reject MOE_COPILOT_TEST_ONLY "in moe-agent.$w" || return 1
  done
  # MOE_COPILOT_EFFORT gone from BOTH wrappers: symmetric disappearance must still fail (the fixed pin).
  d="$(stage effort-both)" || return 1
  for w in sh ps1; do
    n="$(mutate "$d/scripts/moe-agent.$w" MOE_COPILOT_EFFORT '')" && [ "${n:-0}" -gt 0 ] || { mut_fail "no MOE_COPILOT_EFFORT in moe-agent.$w"; return 1; }
  done
  expect "MOE_COPILOT_EFFORT removed from both wrappers" "$d" reject 'copilot vocabulary' MOE_COPILOT_EFFORT || return 1
  echo "LEG_OK mutants"
}

# ---- 3. Run the legs in parallel, aggregate every status ------------------------
START=$SECONDS
( bash_leg ) > "$S/bash.log" 2>&1 & PID[bash]=$!
( win_leg powershell "${PS51[@]}" ) > "$S/powershell.log" 2>&1 & PID[powershell]=$!
( win_leg pwsh "${PWSH7[@]}" ) > "$S/pwsh.log" 2>&1 & PID[pwsh]=$!
( mutants_leg ) > "$S/mutants.log" 2>&1 & PID[mutants]=$!

declare -A RC=()
failed=0
for leg in bash powershell pwsh mutants; do
  wait "${PID[$leg]}"; RC[$leg]=$?
  [ "${RC[$leg]}" -eq 0 ] || failed=1
done
logtext() { tr -d '\r\0' < "$S/$1.log"; }
for leg in bash powershell pwsh mutants; do
  echo "=== $leg: exit ${RC[$leg]} (last lines of $S/$leg.log)"
  if [ "${RC[$leg]}" -eq 0 ]; then logtext "$leg" | tail -n 4; else logtext "$leg" | tail -n 40; fi
done

# ---- 4. Evidence counts: a skipped harness can never look green ------------------
count() { { cat "$S"/bash.log "$S"/powershell.log "$S"/pwsh.log "$S"/mutants.log | tr -d '\r\0' | grep -c -- "$1"; } || true; }
vm_pass="$(count 'PASS postflight-vm-route')"
parity_pass="$(count 'PASS parity-check')"
leg_ok="$(count '^LEG_OK ')"
parse_ok="$(count '^PARSE_OK')"
mut_ok="$(count '^\[mutants\] ok ')"
cp_rows="$(count '^\[copilot\] ok ')"
echo "COUNTS: vm-route PASS=$vm_pass (need 3), parity PASS=$parity_pass (need 3), ParseFile OK=$parse_ok (need 2), legs OK=$leg_ok (need 4), mutant checks=$mut_ok (need $MUT_EXPECTED), vm-route [copilot] rows=$cp_rows, wall=$((SECONDS - START))s"
[ "$mut_ok" -eq "$MUT_EXPECTED" ] || { echo "GATE FAIL: expected $MUT_EXPECTED mutant checks, saw $mut_ok"; failed=1; }
[ "$vm_pass" -eq 3 ] || { echo "GATE FAIL: expected exactly 3 'PASS postflight-vm-route' summaries (bash, 5.1, pwsh 7), saw $vm_pass"; failed=1; }
[ "$parity_pass" -eq 3 ] || { echo "GATE FAIL: expected 3 'PASS parity-check' (bash, 5.1, pwsh 7), saw $parity_pass"; failed=1; }
[ "$parse_ok" -eq 2 ] || { echo "GATE FAIL: expected ParseFile OK on 5.1 and pwsh 7, saw $parse_ok"; failed=1; }
[ "$leg_ok" -eq 4 ] || { echo "GATE FAIL: expected 4 LEG_OK lines, saw $leg_ok"; failed=1; }
[ "$failed" -eq 0 ] || exit 1
STATUS=0
echo "PASS copilot-guards-gate"
