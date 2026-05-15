// =============================================================================
// Atomic write helpers - write to temp file, then rename to target.
// Rename is atomic on POSIX and "close-to-atomic" on Windows for files on the
// same volume, which is dramatically safer than writing the target in place.
// =============================================================================

import fs from 'fs';

function makeTmpPath(filePath: string): string {
  return `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
}

export function atomicWriteJson(filePath: string, obj: unknown): void {
  const tmp = makeTmpPath(filePath);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, filePath);
}

export function atomicWriteText(filePath: string, content: string): void {
  const tmp = makeTmpPath(filePath);
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

export async function atomicWriteJsonAsync(filePath: string, obj: unknown): Promise<void> {
  const tmp = makeTmpPath(filePath);
  await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fs.promises.rename(tmp, filePath);
}

export async function atomicWriteTextAsync(filePath: string, content: string): Promise<void> {
  const tmp = makeTmpPath(filePath);
  await fs.promises.writeFile(tmp, content);
  await fs.promises.rename(tmp, filePath);
}
