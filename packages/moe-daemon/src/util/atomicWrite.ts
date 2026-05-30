// =============================================================================
// Atomic write helpers - write to temp file, fsync, then rename to target.
// Rename is atomic on POSIX and "close-to-atomic" on Windows for files on the
// same volume, which is dramatically safer than writing the target in place.
//
// Durability: we fsync the temp file before renaming. Without it, a crash/power
// loss can make the rename durable while the temp file's contents are not yet
// flushed — yielding a target that is empty/truncated even though rename
// "succeeded". On Windows the rename can also fail transiently (EPERM/EBUSY)
// when an AV scanner or the file watcher briefly holds the target, so we retry.
// On any failure the temp file is cleaned up rather than leaked.
// =============================================================================

import fs from 'fs';

const RENAME_RETRIES = 5;
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function makeTmpPath(filePath: string): string {
  return `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
}

function isRetryableRename(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code !== undefined && RETRYABLE_RENAME_CODES.has(code);
}

function cleanupTmp(tmp: string): void {
  try { fs.unlinkSync(tmp); } catch { /* best effort — already gone or locked */ }
}

function writeAndFsyncSync(tmp: string, data: string): void {
  fs.writeFileSync(tmp, data);
  // fsync via a separate fd flushes the file's dirty pages regardless of which
  // descriptor wrote them, so the rename can't expose a truncated file.
  const fd = fs.openSync(tmp, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function renameWithRetrySync(tmp: string, filePath: string): void {
  let lastErr: unknown;
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    try {
      fs.renameSync(tmp, filePath);
      return;
    } catch (err) {
      if (!isRetryableRename(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

export function atomicWriteJson(filePath: string, obj: unknown): void {
  atomicWriteText(filePath, JSON.stringify(obj, null, 2));
}

export function atomicWriteText(filePath: string, content: string): void {
  const tmp = makeTmpPath(filePath);
  try {
    writeAndFsyncSync(tmp, content);
    renameWithRetrySync(tmp, filePath);
  } catch (err) {
    cleanupTmp(tmp);
    throw err;
  }
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeAndFsyncAsync(tmp: string, data: string): Promise<void> {
  await fs.promises.writeFile(tmp, data);
  // fsync via a separate handle flushes the file's dirty pages regardless of
  // which descriptor wrote them, so the rename can't expose a truncated file.
  const fh = await fs.promises.open(tmp, 'r+');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function renameWithRetryAsync(tmp: string, filePath: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    try {
      await fs.promises.rename(tmp, filePath);
      return;
    } catch (err) {
      if (!isRetryableRename(err)) throw err;
      lastErr = err;
      await delay(10 * (attempt + 1));
    }
  }
  throw lastErr;
}

export async function atomicWriteJsonAsync(filePath: string, obj: unknown): Promise<void> {
  await atomicWriteTextAsync(filePath, JSON.stringify(obj, null, 2));
}

export async function atomicWriteTextAsync(filePath: string, content: string): Promise<void> {
  const tmp = makeTmpPath(filePath);
  try {
    await writeAndFsyncAsync(tmp, content);
    await renameWithRetryAsync(tmp, filePath);
  } catch (err) {
    cleanupTmp(tmp);
    throw err;
  }
}
