// =============================================================================
// Runner channel identity (CQ-V03a)
// =============================================================================
//
// A trusted runner identity comes ONLY from an authenticated host-side channel:
// a loopback connection to /runner that presents the host-only key below.
// Tool arguments never carry it.
//
// Why the key is host-only: the CQ plan (docs/plans/2026-10-24-ai-code-quality-
// and-context.md, section 5) requires the runner's capability to sit outside the
// writer's readable and writable boundary. Under verified-local, agents run in
// guest VMs that reach the daemon only through the R08 bridge, which forwards no
// check tool and carries no daemon token into a guest, so a key in the HOST
// user's home meets that boundary. The key never lives under the project tree,
// so it is never committed, snapshotted or IDE-synced.
//
// Documented limit: under legacy and observe a host agent can read the key (a
// secret in a shared environment). No trust is claimed there; verified-local
// stays unavailable until its isolation is certified.
//
// This module deliberately imports no logger, so it can never log the key.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';

export const RUNNER_KEY_HEADER = 'x-moe-runner-key';

export interface RunnerIdentity {
  readonly runnerId: string;
}

/** Unpadded base64url of 32 bytes. */
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const POSIX = process.platform !== 'win32';

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/** `<MOE_RUNNER_KEY_DIR | ~/.moe/runner-keys>/<first 32 hex of sha256(projectPath)>.key`. */
export function runnerKeyPath(projectPath: string): string {
  const configured = process.env.MOE_RUNNER_KEY_DIR?.trim();
  const dir = configured ? path.resolve(configured) : path.join(os.homedir(), '.moe', 'runner-keys');
  return path.join(dir, `${sha256(projectPath).toString('hex').slice(0, 32)}.key`);
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * Provision the project's runner key (0600 in a 0700 directory) and return its
 * path. A valid key is reused so runnerId stays stable across restarts; a
 * missing or malformed one is replaced through an exclusive temp file and an
 * atomic rename. Errors carry paths and codes only, never key bytes.
 */
export async function ensureRunnerKey(projectPath: string): Promise<string> {
  const file = runnerKeyPath(projectPath);
  const dir = path.dirname(file);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  if (POSIX) await fs.promises.chmod(dir, 0o700);

  let existing: string | null = null;
  try {
    existing = await fs.promises.readFile(file, 'utf8');
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  if (existing !== null && KEY_RE.test(existing)) {
    if (POSIX) await fs.promises.chmod(file, 0o600);
    return file;
  }

  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.promises.writeFile(tmp, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
    await fs.promises.rename(tmp, file);
  } catch (error) {
    await fs.promises.unlink(tmp).catch(() => undefined);
    throw error;
  }
  return file;
}

function isLoopback(address: string | undefined): boolean {
  if (typeof address !== 'string') return false;
  const value = address.toLowerCase();
  return value === '::1' || value.startsWith('127.') || value.startsWith('::ffff:127.');
}

/**
 * The runner identity of a loopback request presenting exactly one valid key
 * header that matches the stored key, read fresh so a rotation takes effect.
 * Never throws: every failure is null.
 */
export function authenticateRunner(req: IncomingMessage, projectPath: string): RunnerIdentity | null {
  try {
    if (!isLoopback(req.socket?.remoteAddress)) return null;
    const values = req.headersDistinct?.[RUNNER_KEY_HEADER];
    if (!Array.isArray(values) || values.length !== 1) return null;
    const presented = values[0];
    if (typeof presented !== 'string' || !KEY_RE.test(presented)) return null;
    const stored = fs.readFileSync(runnerKeyPath(projectPath), 'utf8');
    if (!KEY_RE.test(stored)) return null;
    if (!timingSafeEqual(sha256(presented), sha256(stored))) return null;
    return { runnerId: `runner-${sha256(stored).toString('hex').slice(0, 16)}` };
  } catch {
    return null;
  }
}
