import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// moe-team.sh's background mode (no terminal emulator found, or -t background).
// Each row runs a copy of the real moe-team.sh next to a fake moe-agent.sh that
// records its argv and cwd. A relative --project used to reach the agents as
// given, so an agent started in the scripts dir (iTerm, Terminal.app) bound to
// it; every team on a host shared /tmp/moe-<role>.log; and a launch that failed
// still counted as launched.
const windows = process.platform === 'win32';
const TEAM = fileURLToPath(new URL('../moe-team.sh', import.meta.url));
const bash = windows ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const shellPath = value => windows
  ? value.replaceAll('\\', '/').replace(/^([A-Z]):/i, (_, drive) => `/${drive.toLowerCase()}`)
  : value;
const FAKE_AGENT = `#!/bin/bash
out="$TEAM_SH_RECORDS/record-$$"
{ printf 'cwd=%s\\n' "$(pwd)"; for a in "$@"; do printf 'arg=%s\\n' "$a"; done; } > "$out.tmp" && mv "$out.tmp" "$out.txt"
`;

function fixture(t) {
  // Native realpath expands 8.3 names (RUNNER~1), so recorded paths compare exactly.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'moe-team-sh-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const scripts = path.join(root, 'scripts');
  const records = path.join(root, 'records');
  const logs = path.join(root, 'logs');
  for (const dir of [scripts, records, logs]) fs.mkdirSync(dir);
  fs.copyFileSync(TEAM, path.join(scripts, 'moe-team.sh'));
  fs.writeFileSync(path.join(scripts, 'moe-agent.sh'), FAKE_AGENT);
  fs.chmodSync(path.join(scripts, 'moe-agent.sh'), 0o755);
  return { root, scripts, records, logs };
}

function runTeam(f, args, tmpdir) {
  const env = { ...process.env, TEAM_SH_RECORDS: shellPath(f.records), TMPDIR: shellPath(tmpdir) };
  for (const key of Object.keys(env)) if (/^(MOE_|TERMINAL$)/i.test(key)) delete env[key];
  const r = spawnSync(bash, [shellPath(path.join(f.scripts, 'moe-team.sh')), ...args, '-t', 'background', '-d', '0'],
    { cwd: f.root, env, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.ifError(r.error);
  return { ...r, show: `exit ${r.status}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}` };
}

// The directory as the shell names it (Git Bash mounts %TEMP% at /tmp).
function shellPwd(dir) {
  const r = spawnSync(bash, ['-c', 'pwd'], { cwd: dir, encoding: 'utf8' });
  assert.ifError(r.error);
  return r.stdout.trim();
}

// The agents run in the background: wait for each one's record.
async function records(f, count) {
  const deadline = Date.now() + 30_000;
  let names = [];
  while (Date.now() < deadline) {
    names = fs.readdirSync(f.records).filter(name => name.endsWith('.txt'));
    if (names.length >= count) break;
    await delay(100);
  }
  return names.map(name => fs.readFileSync(path.join(f.records, name), 'utf8').trim().split('\n'))
    .sort((a, b) => a[2].localeCompare(b[2]));
}

test('a relative --project reaches every agent absolute, each with its own log file', async t => {
  const f = fixture(t);
  const project = path.join(f.root, "proj it's");
  fs.mkdirSync(project);
  const r = runTeam(f, ['-p', "proj it's"], f.logs);
  assert.equal(r.status, 0, r.show);
  assert.match(r.stdout, /Launched 3 agent\(s\)/, r.show);
  const want = role => [`cwd=${shellPwd(f.root)}`, 'arg=--role', `arg=${role}`, 'arg=--project', `arg=${shellPwd(project)}`,
    'arg=--team', "arg=proj it's"];
  assert.deepEqual(await records(f, 3), ['architect', 'qa', 'worker'].map(want), r.show);
  const logs = [...r.stdout.matchAll(/Log: (.+)$/gm)].map(m => path.posix.basename(m[1].trim()));
  assert.equal(logs.length, 3, r.show);
  assert.equal(new Set(logs).size, 3, 'each agent gets its own log');
  for (const name of logs) assert.match(name, /^moe-(worker|qa|architect)\.[A-Za-z0-9]{6}$/);
  assert.deepEqual(fs.readdirSync(f.logs).sort(), [...logs].sort(), 'the logs live in TMPDIR');
});

test('a launch that fails is reported, not counted, and exits 1', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'proj'));
  const r = runTeam(f, ['-p', 'proj', '--no-qa', '--no-architect'], path.join(f.root, 'missing'));
  assert.equal(r.status, 1, r.show);
  assert.match(r.stdout, /Failed to start the worker agent\./, r.show);
  assert.match(r.stdout, /Launched 0 agent\(s\)/, r.show);
  assert.match(r.stdout, /1 agent\(s\) failed to start\./, r.show);
  await delay(500);
  assert.deepEqual(fs.readdirSync(f.records), [], r.show);
});
