// =============================================================================
// VM tokens: one long-lived Claude token per rotation account, for Moe VM jobs
// =============================================================================
//
// `accounts vm-token <id>` (cli.ts) mints it with Claude's own
// `claude setup-token` and stores it at <accounts dir>/claude-vm-tokens/<id>.token,
// beside claude-accounts.json: outside every Claude config folder and every
// project. registry.removeAccount and addAccount delete it. This module
// exports no reader: the daemon only stats the store (hasVmToken), and the one
// reader is the wrapper helper scripts/moe-account-lease.mjs (vm-credential),
// which keeps VM_TOKEN_RE, MAX_VM_TOKEN_BYTES and the path rule identical.
//
// Node built-ins and ./registry.js only, like the rest of accounts/.

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { vmTokenFile, writeTextAtomic } from './registry.js';

/** A Claude long-lived OAuth token as `claude setup-token` prints it. Another shape is refused. */
export const VM_TOKEN_RE = /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,1000}$/;
export const MAX_VM_TOKEN_BYTES = 1100;

const POSIX = process.platform !== 'win32';

/** Store the token (dir 0700, file 0600 on POSIX). Errors carry a code and a path, never the token. */
export function writeVmToken(registryFile: string, id: string, token: string): void {
  if (!VM_TOKEN_RE.test(token)) throw new Error('MOE_VM_TOKEN_INVALID: not a Claude long-lived token');
  const file = vmTokenFile(registryFile, id);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory()) throw new Error(`MOE_VM_TOKEN_NOT_STORED: ${dir} is not a directory`);
  if (POSIX) fs.chmodSync(dir, 0o700);
  writeTextAtomic(file, token);
  if (POSIX) fs.chmodSync(file, 0o600);
}

/** true when a token was deleted, false when there was none. */
export function removeVmToken(registryFile: string, id: string): boolean {
  try {
    fs.unlinkSync(vmTokenFile(registryFile, id));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Presence from an lstat alone: a regular file. The file is never opened. */
export function hasVmToken(registryFile: string, id: string): boolean {
  try {
    return fs.lstatSync(vmTokenFile(registryFile, id)).isFile();
  } catch {
    return false;
  }
}

/**
 * `node -e` source for readHiddenLine: the prompt (argv[1]) on stderr, one line
 * read with echo off (readline raw mode on a TTY, its output dropped), that
 * line on stdout. Ctrl-C reaches readline in raw mode, so SIGINT closes it
 * (exit 1). It sets exitCode rather than calling process.exit, which could drop
 * a pending POSIX pipe write. One line, no double quotes.
 */
export const HIDDEN_READER_SOURCE =
  `const {createInterface}=require('readline'),{Writable}=require('stream');let got=null;process.stderr.write(process.argv[1]);` +
  `const rl=createInterface({input:process.stdin,output:new Writable({write(c,e,done){done()}}),terminal:process.stdin.isTTY===true});` +
  `rl.on('line',(l)=>{if(got===null){got=l;process.stdout.write(l)}rl.close()});rl.on('SIGINT',()=>rl.close());` +
  `rl.on('close',()=>{process.stderr.write('\\n');process.exitCode=got===null?1:0})`;

/** One line from the terminal with echo off, over a pipe only; null when none came (empty input, Ctrl-C, 15 minutes). */
export function readHiddenLine(prompt: string): string | null {
  const run = spawnSync(process.execPath, ['-e', HIDDEN_READER_SOURCE, prompt], { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8', timeout: 15 * 60_000 });
  return run.status === 0 ? run.stdout : null;
}
