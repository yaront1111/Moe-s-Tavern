#!/usr/bin/env node
// =============================================================================
// PostToolUse hook entry. Stdlib-only shim that loads the compiled hook.
//
// Claude Code spawns this process and pipes the hook event JSON to stdin. We
// delegate to dist/postToolUse.js for the real work. Any failure here is
// swallowed so the agent's tool call never breaks.
// =============================================================================

import { fileURLToPath } from 'node:url';
import path from 'node:path';

async function run() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const distEntry = path.resolve(here, '..', 'dist', 'postToolUse.js');
    const mod = await import(`file://${distEntry.replace(/\\/g, '/')}`);
    if (typeof mod.runPostToolUseHook !== 'function') {
      process.stderr.write('[moe-claude-plugin] runPostToolUseHook export missing\n');
      process.exit(0);
    }
    const raw = await readStdin();
    let payload = {};
    if (raw.trim().length > 0) {
      try {
        payload = JSON.parse(raw);
      } catch (err) {
        process.stderr.write(`[moe-claude-plugin] Invalid hook stdin: ${err.message}\n`);
        process.exit(0);
      }
    }
    await mod.runPostToolUseHook(payload);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    process.stderr.write(`[moe-claude-plugin] PostToolUse hook crashed (swallowed): ${msg}\n`);
  } finally {
    process.exit(0);
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf-8'));
    }, 2000);
    if (typeof timer.unref === 'function') timer.unref();

    process.stdin.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    process.stdin.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    process.stdin.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

run();
