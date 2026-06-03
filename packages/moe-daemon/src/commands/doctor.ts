// =============================================================================
// `moe-daemon doctor` — local health check that doesn't require the daemon
// to be running. Walks a checklist of common breakage points and prints a
// pass/warn/fail line per probe. Exits 1 if any probe hard-fails.
// =============================================================================

import fs from 'fs';
import http from 'http';
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
const HEALTH_PROBE_TIMEOUT_MS = 2_000;

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

interface DaemonJsonProbe {
  result: ProbeResult;
  port?: number;
  pid?: number;
  alive: boolean;
}

async function probeDaemonJson(moePath: string): Promise<DaemonJsonProbe> {
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
        pid: parsed.pid,
        alive: false,
      };
    }
    return {
      result: { symbol: 'pass', message: `daemon.json valid (pid ${parsed.pid}, port ${parsed.port})` },
      port: parsed.port,
      pid: parsed.pid,
      alive: true,
    };
  }
  return {
    result: { symbol: 'warn', message: 'daemon.json missing pid' },
    port: parsed.port,
    alive: false,
  };
}

interface HealthProbeOutcome {
  ok: boolean;
  statusCode?: number;
  body?: { status?: string; projectPath?: string; pid?: unknown };
  error?: string;
}

// GET /health and parse the JSON body. A bare TCP connect proves only that
// *something* holds the port (pid/port reuse after a crash is common), so the
// daemon is only "healthy" when its own health endpoint confirms identity.
function probeHealth(port: number, timeoutMs: number): Promise<HealthProbeOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: HealthProbeOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/health', method: 'GET', timeout: timeoutMs },
      (res) => {
        let raw = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk) => {
          raw += chunk;
          if (raw.length > 64 * 1024) {
            req.destroy();
            finish({ ok: false, statusCode: res.statusCode, error: 'response too large' });
          }
        });
        res.on('end', () => {
          try {
            finish({ ok: true, statusCode: res.statusCode, body: JSON.parse(raw) });
          } catch {
            finish({ ok: false, statusCode: res.statusCode, error: 'unparseable /health body' });
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, error: `no /health response within ${timeoutMs}ms` });
    });
    req.on('error', (err) => finish({ ok: false, error: err.message }));
    req.end();
  });
}

async function probeDaemonReachability(
  probe: DaemonJsonProbe,
  expectedProjectPath: string,
): Promise<ProbeResult | null> {
  const { port, pid, alive } = probe;
  if (!alive || typeof port !== 'number') return null;

  const health = await probeHealth(port, HEALTH_PROBE_TIMEOUT_MS);
  if (health.ok && health.statusCode === 200 && health.body) {
    const body = health.body;
    const projectMatches = typeof body.projectPath === 'string'
      && path.resolve(body.projectPath) === path.resolve(expectedProjectPath);
    const pidMatches = typeof pid !== 'number' || body.pid === pid;
    if (body.status === 'healthy' && projectMatches && pidMatches) {
      return { symbol: 'pass', message: `/health OK on 127.0.0.1:${port} (status healthy, project matches)` };
    }
    if (!projectMatches) {
      return { symbol: 'fail', message: `/health on 127.0.0.1:${port} reports a different project (${body.projectPath ?? 'unknown'}) — port reused by another daemon` };
    }
    if (!pidMatches) {
      return { symbol: 'fail', message: `/health on 127.0.0.1:${port} reports pid ${String(body.pid)} but daemon.json says ${pid} — pid/port reuse` };
    }
    return { symbol: 'fail', message: `/health on 127.0.0.1:${port} reports status '${body.status ?? 'unknown'}' (not healthy)` };
  }

  // No usable /health response. Fall back to a bare TCP probe: if something is
  // listening it is NOT our daemon (or not healthy), so this is a warning, not
  // a pass — a dead daemon behind a reused port must never show green.
  const tcpOk = await probeTcp('127.0.0.1', port, TCP_PROBE_TIMEOUT_MS);
  if (tcpOk) {
    return {
      symbol: 'warn',
      message: `127.0.0.1:${port} accepts TCP but /health did not confirm a healthy Moe daemon (${health.error ?? `HTTP ${health.statusCode}`}) — possible pid/port reuse`,
    };
  }
  return { symbol: 'fail', message: `nothing reachable on 127.0.0.1:${port} (${health.error ?? 'TCP refused'})` };
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
  const daemonJsonProbe = await probeDaemonJson(moePath);
  probes.push(['daemon.json', daemonJsonProbe.result]);

  // 3. Health reachability when daemon is supposed to be running. A bare TCP
  // connect is not enough — pid/port reuse after a crash can make a dead daemon
  // look alive — so confirm identity via /health and downgrade TCP-only to warn.
  const reachability = await probeDaemonReachability(daemonJsonProbe, projectPath);
  if (reachability) probes.push(['daemon health reachability', reachability]);

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
