import fs from 'fs';

const DEFAULT_CHUNK_SIZE = 8 * 1024;

function normalizeLines(content: string, maxLines: number): string[] {
  const lines = content
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  return lines.slice(-maxLines);
}

/**
 * Read only the last N lines from a file without loading the entire file into memory.
 * Returns lines in chronological order (oldest -> newest within the returned window).
 */
export function readLastLines(filePath: string, maxLines: number): string[] {
  if (maxLines <= 0) {
    return [];
  }

  if (!fs.existsSync(filePath)) {
    return [];
  }

  let fd: number | undefined;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= 0) {
      return [];
    }

    // Small-file fast path (and avoids reverse-reader overhead for tiny logs).
    if (stat.size <= DEFAULT_CHUNK_SIZE) {
      const content = fs.readFileSync(filePath, 'utf-8');
      return normalizeLines(content, maxLines);
    }

    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(DEFAULT_CHUNK_SIZE);
    const reverseLines: string[] = [];
    let position = stat.size;
    let remainder = '';

    while (position > 0 && reverseLines.length < maxLines) {
      const bytesToRead = Math.min(DEFAULT_CHUNK_SIZE, position);
      position -= bytesToRead;
      fs.readSync(fd, buffer, 0, bytesToRead, position);

      const chunk = buffer.toString('utf-8', 0, bytesToRead);
      const combined = chunk + remainder;
      const parts = combined.split(/\r?\n/);

      // First entry can be partial because we are reading backwards.
      remainder = parts.shift() ?? '';

      for (let i = parts.length - 1; i >= 0 && reverseLines.length < maxLines; i -= 1) {
        if (parts[i].length > 0) {
          reverseLines.push(parts[i]);
        }
      }
    }

    if (reverseLines.length < maxLines && remainder.length > 0) {
      reverseLines.push(remainder);
    }

    return reverseLines.reverse();
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Swallow close errors to keep this helper fail-safe.
      }
    }
  }
}
