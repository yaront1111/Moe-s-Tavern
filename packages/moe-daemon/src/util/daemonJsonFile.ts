import fs from 'fs';

// daemon.json is repository content (a repository can commit one past
// .moe/.gitignore); the daemon itself writes a few hundred bytes. The same
// 64 KiB cap is used by the JetBrains reader and the other clients.
export const MAX_DAEMON_JSON_BYTES = 64 * 1024;

export class DaemonJsonTooLargeError extends Error {
  constructor() {
    super('daemon.json is larger than 64 KiB');
    this.name = 'DaemonJsonTooLargeError';
  }
}

/**
 * Read daemon.json through one file descriptor, taking at most
 * MAX_DAEMON_JSON_BYTES + 1 bytes. A size pre-check is not enough: a symlink
 * to a device reports size 0 but never ends. Throws DaemonJsonTooLargeError
 * (no file content in the message) when the file exceeds the cap.
 */
export function readDaemonJsonText(filePath: string): string {
  const buf = Buffer.alloc(MAX_DAEMON_JSON_BYTES + 1);
  const fd = fs.openSync(filePath, 'r');
  try {
    let total = 0;
    while (total < buf.length) {
      // Devices and pipes can return short reads, so loop until EOF or full.
      const n = fs.readSync(fd, buf, total, buf.length - total, null);
      if (n === 0) break;
      total += n;
    }
    if (total > MAX_DAEMON_JSON_BYTES) throw new DaemonJsonTooLargeError();
    return buf.toString('utf8', 0, total);
  } finally {
    fs.closeSync(fd);
  }
}
