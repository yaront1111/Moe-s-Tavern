// Recovery certify check's controller child (CQ-R13h). It runs one real provisioning, which the certify parent SIGKILLs once
// the VM is launched, so that reconcile and cleanup are certified on a real orphan. Its argv is fixed: [process.execPath,
// this file]. Its only input is one JSON line on stdin, {ledgerDir, cacheDir, owner}, validated before any platform module
// is imported or any provider called. It prints nothing, and its credential never leaves this process. Exit codes: 0
// provisioned (the parent normally kills it first), 64 bad input, 70 any provisioning failure.
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createLedger, validOwner } from './lifecycle.mjs';

const MAX_INPUT_BYTES = 4096;
const CONTROL = /[\x00-\x1f\x7f]/;
const KEYS = ['cacheDir', 'ledgerDir', 'owner'];
const [PROVISIONED, BAD_INPUT, FAILED] = [0, 64, 70];
const validDir = dir => typeof dir === 'string' && path.isAbsolute(dir) && !CONTROL.test(dir);

// The whole of stdin, or null past MAX_INPUT_BYTES.
async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// A plain record of exactly KEYS: absolute control-free dirs and a valid owner, copied; else null.
function parse(text) {
  let input;
  try { input = JSON.parse(text); } catch { return null; }
  if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join() !== KEYS.join()) return null;
  const { ledgerDir, cacheDir, owner } = input;
  if (!validDir(ledgerDir) || !validDir(cacheDir) || !validOwner(owner)) return null;
  return { ledgerDir, cacheDir, owner: { taskId: owner.taskId, attemptId: owner.attemptId, generation: owner.generation } };
}

async function main() {
  const text = await readInput();
  const input = text === null ? null : parse(text);
  if (input === null) return BAD_INPUT;
  try {
    const [{ platformFor }, { provisionGuest }] = await Promise.all([import('./cli.mjs'), import('./provision.mjs')]);
    const platform = platformFor(process.platform);
    if (!platform) return FAILED;
    const outcome = await provisionGuest({ platform, ledger: createLedger(input.ledgerDir), owner: input.owner, cacheDir: input.cacheDir,
      supervisor: await readFile(new URL('./guest-supervisor.py', import.meta.url)), credential: randomBytes(32) });
    return outcome?.provisioned === true ? PROVISIONED : FAILED;
  } catch { return FAILED; }
}

main().then(code => process.exit(code), () => process.exit(FAILED));
