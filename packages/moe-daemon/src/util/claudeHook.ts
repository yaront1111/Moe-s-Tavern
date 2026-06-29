import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from './logger.js';

export const CLAUDE_HOOK_MATCHER = 'mcp__moe__moe_(start_step|complete_step|complete_task|submit_plan|qa_approve|qa_reject)';

const PRE_TOOL_USE_ENTRY = {
  matcher: CLAUDE_HOOK_MATCHER,
  hooks: [
    { type: 'command', command: 'bash .claude/hooks/moe-require-claim.sh' },
    { type: 'command', command: 'pwsh -NoProfile -File .claude/hooks/moe-require-claim.ps1' },
  ],
};

export const CLAUDE_SETTINGS_CONTENT = `${JSON.stringify({
  hooks: {
    PreToolUse: [PRE_TOOL_USE_ENTRY],
  },
}, null, 2)}\n`;

const REQUIRE_CLAIM_SH_BODY = `#!/usr/bin/env bash
set -euo pipefail
ALLOWLIST_RE='^mcp__moe__moe_(start_step|complete_step|complete_task|submit_plan|qa_approve|qa_reject)$'
find_python() {
  if command -v python3 >/dev/null 2>&1 && python3 --version >/dev/null 2>&1; then echo "python3"; return 0; fi
  if command -v py >/dev/null 2>&1 && py -3 --version >/dev/null 2>&1; then echo "py -3"; return 0; fi
  if command -v python >/dev/null 2>&1 && python --version 2>&1 | grep -q 'Python 3\\.'; then echo "python"; return 0; fi
  return 1
}
PAYLOAD="$(cat || true)"
PYTHON_CMD="\${PYTHON_CMD:-$(find_python || true)}"
if [ -z "$PYTHON_CMD" ]; then echo "[moe] warning: python3 not found; claim hook fail-open" >&2; exit 0; fi
TOOL_NAME="$(printf '%s' "$PAYLOAD" | $PYTHON_CMD -c 'import json,sys; data=json.load(sys.stdin) if sys.stdin.readable() else {}; print(data.get("tool_name") or data.get("toolName") or data.get("name") or "")' 2>/dev/null || true)"
if ! [[ "$TOOL_NAME" =~ $ALLOWLIST_RE ]]; then exit 0; fi
if [ -z "\${MOE_WORKER_ID:-}" ]; then echo "[moe] warning: MOE_WORKER_ID is not set; claim hook fail-open" >&2; exit 0; fi
PROJECT_DIR="\${CLAUDE_PROJECT_DIR:-\${MOE_PROJECT_PATH:-$PWD}}"
MOE_CALL="\${MOE_CALL_PATH:-$PROJECT_DIR/scripts/moe-call.sh}"
if [ ! -f "$MOE_CALL" ]; then echo "[moe] warning: moe-call.sh not found at $MOE_CALL; claim hook fail-open" >&2; exit 0; fi
PROJECT_ARG="$PROJECT_DIR"; if command -v cygpath >/dev/null 2>&1; then MOE_CALL="$(cygpath -u "$MOE_CALL")"; PROJECT_ARG="$(cygpath -u "$PROJECT_DIR")"; fi
BASH_CMD="\${MOE_BASH_PATH:-$(command -v bash || true)}"
if [ -z "$BASH_CMD" ]; then echo "[moe] warning: bash not found; claim hook fail-open" >&2; exit 0; fi
if command -v cygpath >/dev/null 2>&1; then BASH_CMD="$(cygpath -w "$BASH_CMD")"; fi
# shellcheck disable=SC2086 # PYTHON_CMD may intentionally be "py -3".
$PYTHON_CMD - "$BASH_CMD" "$MOE_CALL" "$PROJECT_ARG" "$MOE_WORKER_ID" <<'PY'
import json, subprocess, sys
bash_cmd, moe_call, project_dir, worker_id = sys.argv[1:5]
args = json.dumps({"status": ["PLANNING", "WORKING", "REVIEW"], "limit": 500})
try:
    proc = subprocess.run([bash_cmd, moe_call, "list_tasks", args, "--project", project_dir], capture_output=True, text=True, timeout=2)
except Exception as exc:
    print(f"[moe] warning: claim check failed ({exc}); fail-open", file=sys.stderr); sys.exit(0)
if proc.returncode != 0:
    print("[moe] warning: list_tasks failed; claim hook fail-open", file=sys.stderr); sys.exit(0)
try:
    payload = json.loads(proc.stdout)
except Exception:
    print("[moe] warning: list_tasks returned malformed JSON; claim hook fail-open", file=sys.stderr); sys.exit(0)
for task in payload.get("tasks", []):
    if task.get("assignedWorkerId") == worker_id and task.get("status") in {"PLANNING", "WORKING", "REVIEW"}: sys.exit(0)
print(f"No active claim for worker {worker_id} — call moe.claim_next_task first", file=sys.stderr)
sys.exit(2)
PY
`;

const REQUIRE_CLAIM_PS1_BODY = `[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$allowlist = '^(mcp__moe__moe_start_step|mcp__moe__moe_complete_step|mcp__moe__moe_complete_task|mcp__moe__moe_submit_plan|mcp__moe__moe_qa_approve|mcp__moe__moe_qa_reject)$'
$payload = [Console]::In.ReadToEnd()
try {
    $data = if ([string]::IsNullOrWhiteSpace($payload)) { $null } else { $payload | ConvertFrom-Json }
    $toolName = if ($data -and $data.PSObject.Properties['tool_name']) { $data.tool_name } elseif ($data -and $data.PSObject.Properties['toolName']) { $data.toolName } elseif ($data -and $data.PSObject.Properties['name']) { $data.name } else { '' }
} catch { $toolName = '' }
if ($toolName -notmatch $allowlist) { exit 0 }
$workerId = $env:MOE_WORKER_ID
if ([string]::IsNullOrWhiteSpace($workerId)) { Write-Warning '[moe] MOE_WORKER_ID is not set; claim hook fail-open'; exit 0 }
$projectDir = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } elseif ($env:MOE_PROJECT_PATH) { $env:MOE_PROJECT_PATH } else { (Get-Location).Path }
$moeCall = if ($env:MOE_CALL_PATH) { $env:MOE_CALL_PATH } else { Join-Path $projectDir 'scripts/moe-call.sh' }
if (-not (Test-Path -LiteralPath $moeCall -PathType Leaf)) { Write-Warning "[moe] moe-call.sh not found at $moeCall; claim hook fail-open"; exit 0 }
function Test-Bash([string]$Exe) {
    if (-not $Exe -or -not (Test-Path -LiteralPath $Exe -PathType Leaf)) { return $false }
    try {
        $p = [Diagnostics.ProcessStartInfo]::new(); $p.FileName = $Exe; $p.RedirectStandardOutput = $true; $p.RedirectStandardError = $true; $p.UseShellExecute = $false
        @('-lc', 'printf ok') | ForEach-Object { [void]$p.ArgumentList.Add($_) }
        $c = [Diagnostics.Process]::Start($p); if (-not $c.WaitForExit(2000)) { $c.Kill($true); return $false }
        return $c.ExitCode -eq 0 -and $c.StandardOutput.ReadToEnd() -eq 'ok'
    } catch { return $false }
}
$bashCandidates = @()
if ($env:MOE_BASH_PATH) { $bashCandidates += $env:MOE_BASH_PATH }
if ($env:ProgramFiles) { $bashCandidates += (Join-Path $env:ProgramFiles 'Git/usr/bin/bash.exe') }
$pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
if ($pf86) { $bashCandidates += (Join-Path $pf86 'Git/usr/bin/bash.exe') }
$bashCandidates += @(Get-Command bash -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
$bashExe = $bashCandidates | Select-Object -Unique | Where-Object { Test-Bash $_ } | Select-Object -First 1
if (-not $bashExe) { Write-Warning '[moe] usable bash not found; claim hook fail-open'; exit 0 }
function ConvertTo-BashPath([string]$PathValue) {
    $normalizedBash = $bashExe -replace '\\\\', '/'
    if ($normalizedBash -match '(?i)/(System32|WindowsApps)/bash\.exe$' -and $PathValue -match '^([A-Za-z]):\\\\(.*)$') { return "/mnt/$($Matches[1].ToLower())/" + ($Matches[2] -replace '\\\\', '/') }
    return $PathValue -replace '\\\\', '/'
}
$argsJson = '{"status":["PLANNING","WORKING","REVIEW"],"limit":500}'
$psi = [Diagnostics.ProcessStartInfo]::new(); $psi.FileName = $bashExe; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false
@((ConvertTo-BashPath $moeCall), 'list_tasks', $argsJson, '--project', (ConvertTo-BashPath $projectDir)) | ForEach-Object { [void]$psi.ArgumentList.Add($_) }
$proc = [Diagnostics.Process]::Start($psi)
if (-not $proc.WaitForExit(2000)) { $proc.Kill($true); Write-Warning '[moe] list_tasks timed out; claim hook fail-open'; exit 0 }
if ($proc.ExitCode -ne 0) { Write-Warning '[moe] list_tasks failed; claim hook fail-open'; exit 0 }
try { $result = $proc.StandardOutput.ReadToEnd() | ConvertFrom-Json } catch { Write-Warning '[moe] list_tasks returned malformed JSON; claim hook fail-open'; exit 0 }
foreach ($task in @($result.tasks)) { if ($task.assignedWorkerId -eq $workerId -and $task.status -in @('PLANNING', 'WORKING', 'REVIEW')) { exit 0 } }
[Console]::Error.WriteLine("No active claim for worker $workerId — call moe.claim_next_task first")
exit 2
`;

// Marker line that stamps a Moe-generated hook so writeHookFile() can tell an
// upgradeable Moe-generated copy apart from a user-customized one — same scheme
// as ROLE_DOCS in util/initFiles.ts, but using a `#` shell/PowerShell comment
// instead of an HTML comment. A user who wants to customize the hook deletes the
// marker line, opting the file out of future auto-upgrades.
const HOOK_MARKER_RE = /^#\s*moe-generated:\s*sha=([a-f0-9]{6,64})\s*$/m;

function hookMarkerSha(content: string): string | null {
  const m = content.match(HOOK_MARKER_RE);
  return m ? m[1] : null;
}

/**
 * Returns true when the on-disk hook carries a Moe-generated marker whose sha
 * differs from the bundled hook's marker (i.e. an upgradeable stale copy).
 * False when the disk copy has no marker (user-customized, preserve) or matches.
 */
function shouldUpgradeHook(onDisk: string, bundled: string): boolean {
  const diskSha = hookMarkerSha(onDisk);
  const bundledSha = hookMarkerSha(bundled);
  if (!diskSha || !bundledSha) return false;
  return diskSha !== bundledSha;
}

// Stamp a `# moe-generated: sha=<hex12>` marker into a hook body. The sha is a
// content hash of the marker-free body, so any future edit to the body bumps the
// marker and triggers an upgrade on existing projects. The marker goes after the
// `#!` shebang for the bash script (the shebang must stay on line 1) and on the
// first line for the PowerShell script (a leading comment is valid there).
function stampHookBody(body: string, afterFirstLine: boolean): string {
  const sha = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
  const marker = `# moe-generated: sha=${sha}`;
  if (!afterFirstLine) {
    return `${marker}\n${body}`;
  }
  const nl = body.indexOf('\n');
  if (nl === -1) {
    return `${marker}\n${body}`;
  }
  return `${body.slice(0, nl + 1)}${marker}\n${body.slice(nl + 1)}`;
}

export const REQUIRE_CLAIM_SH_CONTENT = stampHookBody(REQUIRE_CLAIM_SH_BODY, true);
export const REQUIRE_CLAIM_PS1_CONTENT = stampHookBody(REQUIRE_CLAIM_PS1_BODY, false);

export interface ClaudeHookWriteResult {
  settingsWritten: boolean;
  settingsMerged: boolean;
  settingsSkippedReason?: 'already-present' | 'invalid-json' | 'write-failed' | 'too-large';
  hookWritten: boolean;
  hookSkippedReason?: 'user-modified' | 'write-failed';
  shHookWritten: boolean;
  ps1HookWritten: boolean;
}

export function writeClaudeHook(projectRoot: string): ClaudeHookWriteResult {
  const claudeDir = path.join(projectRoot, '.claude');
  const hooksDir = path.join(claudeDir, 'hooks');
  const result: ClaudeHookWriteResult = {
    settingsWritten: false,
    settingsMerged: false,
    hookWritten: false,
    shHookWritten: false,
    ps1HookWritten: false,
  };

  try {
    fs.mkdirSync(hooksDir, { recursive: true });
  } catch (error) {
    logger.warn({ error, projectRoot }, 'Failed to create Claude hook directories');
    result.settingsSkippedReason = 'write-failed';
    result.hookSkippedReason = 'write-failed';
    return result;
  }

  mergeOrWriteSettings(path.join(claudeDir, 'settings.json'), result);
  writeHookFile(path.join(hooksDir, 'moe-require-claim.sh'), REQUIRE_CLAIM_SH_CONTENT, result, 'shHookWritten');
  writeHookFile(path.join(hooksDir, 'moe-require-claim.ps1'), REQUIRE_CLAIM_PS1_CONTENT, result, 'ps1HookWritten');

  return result;
}

export const writeClaudeHookFiles = writeClaudeHook;

function mergeOrWriteSettings(settingsPath: string, result: ClaudeHookWriteResult): void {
  if (!fs.existsSync(settingsPath)) {
    try {
      fs.writeFileSync(settingsPath, CLAUDE_SETTINGS_CONTENT);
      result.settingsWritten = true;
    } catch (error) {
      logger.warn({ error, settingsPath }, 'Failed to write Claude settings');
      result.settingsSkippedReason = 'write-failed';
    }
    return;
  }

  // Cap at 1 MB: settings.json is a small JSON file in practice. Anything
  // larger is almost certainly a corrupt/abused file and we'd rather skip
  // than load it into memory.
  const SETTINGS_MAX_BYTES = 1024 * 1024;
  try {
    const stat = fs.statSync(settingsPath);
    if (stat.size > SETTINGS_MAX_BYTES) {
      logger.warn(
        { settingsPath, size: stat.size, max: SETTINGS_MAX_BYTES },
        'Skipping Claude settings: file exceeds size cap'
      );
      result.settingsSkippedReason = 'too-large';
      return;
    }
  } catch (error) {
    logger.warn({ error, settingsPath }, 'Failed to stat Claude settings');
    result.settingsSkippedReason = 'write-failed';
    return;
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
  } catch (error) {
    logger.warn({ error, settingsPath }, 'Preserving invalid Claude settings');
    result.settingsSkippedReason = 'invalid-json';
    return;
  }

  const hooks = ensureRecord(settings, 'hooks');
  const preToolUse = ensureArray(hooks, 'PreToolUse');
  if (preToolUse.some((entry) => isRecord(entry) && entry.matcher === CLAUDE_HOOK_MATCHER)) {
    result.settingsSkippedReason = 'already-present';
    return;
  }

  preToolUse.push(PRE_TOOL_USE_ENTRY);
  try {
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    result.settingsMerged = true;
  } catch (error) {
    logger.warn({ error, settingsPath }, 'Failed to merge Claude settings');
    result.settingsSkippedReason = 'write-failed';
  }
}

function writeHookFile(
  hookPath: string,
  content: string,
  result: ClaudeHookWriteResult,
  writtenKey: 'shHookWritten' | 'ps1HookWritten'
): void {
  if (fs.existsSync(hookPath)) {
    let onDisk: string;
    try {
      onDisk = fs.readFileSync(hookPath, 'utf-8');
    } catch (error) {
      logger.warn({ error, hookPath }, 'Preserving unreadable Claude hook file');
      result.hookSkippedReason = 'user-modified';
      return;
    }
    // Already current — nothing to do.
    if (onDisk === content) {
      return;
    }
    // A Moe-generated hook with a stale marker is upgraded (claim-gate fixes
    // must reach existing projects); a marker-stripped (user-edited) hook is
    // preserved. Mirrors writeInitFiles()'s role-doc upgrade convention.
    if (!shouldUpgradeHook(onDisk, content)) {
      result.hookSkippedReason = 'user-modified';
      return;
    }
  }

  try {
    fs.writeFileSync(hookPath, content);
    result[writtenKey] = true;
    result.hookWritten = true;
    if (hookPath.endsWith('.sh')) {
      fs.chmodSync(hookPath, 0o755);
    }
  } catch (error) {
    logger.warn({ error, hookPath }, 'Failed to write Claude hook file');
    result.hookSkippedReason = 'write-failed';
  }
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (isRecord(value)) return value;
  const record: Record<string, unknown> = {};
  parent[key] = record;
  return record;
}

function ensureArray(parent: Record<string, unknown>, key: string): unknown[] {
  const value = parent[key];
  if (Array.isArray(value)) return value;
  const array: unknown[] = [];
  parent[key] = array;
  return array;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
