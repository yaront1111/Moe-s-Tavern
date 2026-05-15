// =============================================================================
// `moe-daemon doctor` — local health check that doesn't require the daemon
// to be running. Walks a checklist of common breakage points and prints a
// pass/warn/fail line per probe. Exits 1 if any probe hard-fails.
// =============================================================================

import fs from 'fs';
import net from 'net';
import path from 'path';

interface ProbeResult {
  symbol: 'pass' | 'warn' | 'fail';
  message: string;
}

const REQUIRED_ROLE_DOCS = ['architect.md', 'worker.md', 'qa.md', 'governor.md'];
const REQUIRED_CHANNELS = ['general', 'workers', 'architects', 'qa', 'governors'];
const STALE_WORKER_MS = 5 * 60_000;
const ORPHAN_LOCK_MS = 10 * 60_000;
const LARGE_CHANNEL_BYTES = 50 * 1024 * 1024;
const TCP_PROBE_TIMEOUT_MS = 2_000;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH') return false;
    return true;
  }
}

function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

async function probeMoeDir(moePath: string): Promise<ProbeResult> {
  if (!fs.existsSync(moePath)) {
    return { symbol: 'fail', message: `.moe/ missing at ${moePath}` };
  }
  const stat = fs.statSync(moePath);
  if (!stat.isDirectory()) {
    return { symbol: 'fail', message: `.moe/ exists but is not a directory: ${moePath}` };
  }
  return { symbol: 'pass', message: `.moe/ present at ${moePath}` };
}

async function probeDaemonJson(moePath: string): Promise<{ result: ProbeResult; port?: number; alive: boolean }> {
  const daemonJson = path.join(moePath, 'daemon.json');
  if (!fs.existsSync(daemonJson)) {
    return { result: { symbol: 'pass', message: 'daemon.json absent (daemon not running)' }, alive: false };
  }
  let parsed: { port?: number; pid?: number; projectPath?: string };
  try {
    parsed = JSON.parse(fs.readFileSync(daemonJson, 'utf-8'));
  } catch (err) {
    return {
      result: { symbol: 'fail', message: `daemon.json unparseable: ${(err as Error).message}` },
      alive: false,
    };
  }
  if (typeof parsed.port !== 'number') {
    return { result: { symbol: 'fail', message: 'daemon.json missing port' }, alive: false };
  }
  if (typeof parsed.pid === 'number') {
    const alive = isProcessAlive(parsed.pid);
    if (!alive) {
      return {
        result: { symbol: 'warn', message: `daemon.json present but pid ${parsed.pid} not running (stale)` },
        port: parsed.port,
        alive: false,
      };
    }
    return {
      result: { symbol: 'pass', message: `daemon.json valid (pid ${parsed.pid}, port ${parsed.port})` },
      port: parsed.port,
      alive: true,
    };
  }
  return {
    result: { symbol: 'warn', message: 'daemon.json missing pid' },
    port: parsed.port,
    alive: false,
  };
}

async function probeTcpReachability(port: number | undefined, alive: boolean): Promise<ProbeResult | null> {
  if (!alive || typeof port !== 'number') return null;
  const ok = await probeTcp('127.0.0.1', port, TCP_PROBE_TIMEOUT_MS);
  if (ok) {
    return { symbol: 'pass', message: `TCP probe succeeded on 127.0.0.1:${port}` };
  }
  return { symbol: 'fail', message: `TCP probe failed on 127.0.0.1:${port} within ${TCP_PROBE_TIMEOUT_MS}ms` };
}

async function probeRoleDocs(moePath: string): Promise<ProbeResult> {
  const rolesDir = path.join(moePath, 'roles');
  if (!fs.existsSync(rolesDir)) {
    return { symbol: 'fail', message: '.moe/roles/ missing' };
  }
  const missing = REQUIRED_ROLE_DOCS.filter((f) => !fs.existsSync(path.join(rolesDir, f)));
  if (missing.length > 0) {
    return { symbol: 'fail', message: `missing role docs: ${missing.join(', ')}` };
  }
  return { symbol: 'pass', message: 'all role docs present (architect/worker/qa/governor)' };
}

async function probeChannels(moePath: string): Promise<ProbeResult> {
  const channelsDir = path.join(moePath, 'channels');
  if (!fs.existsSync(channelsDir)) {
    return { symbol: 'fail', message: '.moe/channels/ missing' };
  }
  const names = new Set<string>();
  for (const file of fs.readdirSync(channelsDir).filter((f) => f.endsWith('.json'))) {
    try {
      const channel = JSON.parse(fs.readFileSync(path.join(channelsDir, file), 'utf-8')) as { name?: string };
      if (typeof channel.name === 'string') names.add(channel.name);
    } catch { /* skip unreadable */ }
  }
  const missing = REQUIRED_CHANNELS.filter((n) => !names.has(n));
  if (missing.length > 0) {
    return { symbol: 'fail', message: `missing channels: ${missing.join(', ')}` };
  }
  return { symbol: 'pass', message: 'canonical channels present (general/workers/architects/qa/governors)' };
}

async function probeStaleWorkers(moePath: string): Promise<ProbeResult> {
  const workersDir = path.join(moePath, 'workers');
  if (!fs.existsSync(workersDir)) {
    return { symbol: 'pass', message: 'no workers directory (none registered)' };
  }
  const now = Date.now();
  let stale = 0;
  let total = 0;
  for (const file of fs.readdirSync(workersDir).filter((f) => f.endsWith('.json'))) {
    try {
      const worker = JSON.parse(fs.readFileSync(path.join(workersDir, file), 'utf-8')) as { lastActivityAt?: string };
      total++;
      if (typeof worker.lastActivityAt === 'string') {
        const ts = Date.parse(worker.lastActivityAt);
        if (Number.isFinite(ts) && now - ts > STALE_WORKER_MS) stale++;
      }
    } catch { /* skip unreadable */ }
  }
  if (stale > 0) {
    return { symbol: 'warn', message: `${stale}/${total} worker(s) stale (>5m idle)` };
  }
  return { symbol: 'pass', message: `${total} worker(s), none stale` };
}

async function probeLockfiles(moePath: string): Promise<ProbeResult> {
  const now = Date.now();
  let orphans = 0;
  for (const file of fs.readdirSync(moePath).filter((f) => f.endsWith('.lock'))) {
    try {
      const stat = fs.statSync(path.join(moePath, file));
      if (now - stat.mtimeMs > ORPHAN_LOCK_MS) orphans++;
    } catch { /* skip */ }
  }
  if (orphans > 0) {
    return { symbol: 'warn', message: `${orphans} orphaned lockfile(s) older than 10m` };
  }
  return { symbol: 'pass', message: 'no orphaned lockfiles' };
}

async function probeMessagesSize(moePath: string): Promise<ProbeResult> {
  const messagesDir = path.join(moePath, 'messages');
  if (!fs.existsSync(messagesDir)) {
    return { symbol: 'pass', message: '.moe/messages/ absent (no chat traffic yet)' };
  }
  let totalBytes = 0;
  let oversized: string | null = null;
  for (const file of fs.readdirSync(messagesDir).filter((f) => f.endsWith('.jsonl'))) {
    try {
      const stat = fs.statSync(path.join(messagesDir, file));
      totalBytes += stat.size;
      if (stat.size > LARGE_CHANNEL_BYTES && !oversized) oversized = file;
    } catch { /* skip */ }
  }
  const totalMb = (totalBytes / (1024 * 1024)).toFixed(1);
  if (oversized) {
    return { symbol: 'warn', message: `${oversized} exceeds 50MB; consider trimming (.moe/messages total ${totalMb}MB)` };
  }
  return { symbol: 'pass', message: `.moe/messages/ total ${totalMb}MB` };
}

function emit(label: string, result: ProbeResult, log: (msg: string) => void): void {
  const icon = result.symbol === 'pass' ? '[OK]' : result.symbol === 'warn' ? '[WARN]' : '[FAIL]';
  log(`${icon} ${label}: ${result.message}`);
}

export interface DoctorResult {
  exitCode: number;
  output: string[];
}

/**
 * Run all probes and return aggregated output. Exit code is 1 if any probe
 * hard-fails; warnings do NOT cause a non-zero exit.
 */
export async function runDoctor(projectPath: string): Promise<DoctorResult> {
  const moePath = path.join(projectPath, '.moe');
  const output: string[] = [];
  const log = (msg: string) => output.push(msg);

  log(`moe-daemon doctor — ${projectPath}`);

  const probes: Array<[string, ProbeResult]> = [];

  // 1. .moe/ presence
  const moeDir = await probeMoeDir(moePath);
  probes.push(['.moe/ presence', moeDir]);
  if (moeDir.symbol === 'fail') {
    emit('.moe/ presence', moeDir, log);
    return { exitCode: 1, output };
  }

  // 2. daemon.json
  const { result: daemonJsonResult, port, alive } = await probeDaemonJson(moePath);
  probes.push(['daemon.json', daemonJsonResult]);

  // 3. TCP reachability when daemon is supposed to be running
  const tcp = await probeTcpReachability(port, alive);
  if (tcp) probes.push(['daemon TCP reachability', tcp]);

  // 4. role docs
  probes.push(['role docs', await probeRoleDocs(moePath)]);

  // 5. channels
  probes.push(['canonical channels', await probeChannels(moePath)]);

  // 6. stale workers
  probes.push(['workers', await probeStaleWorkers(moePath)]);

  // 7. lockfiles
  probes.push(['lockfile sanity', await probeLockfiles(moePath)]);

  // 8. disk usage
  probes.push(['messages disk usage', await probeMessagesSize(moePath)]);

  for (const [label, result] of probes) {
    emit(label, result, log);
  }

  const failed = probes.some(([, r]) => r.symbol === 'fail');
  return { exitCode: failed ? 1 : 0, output };
}
