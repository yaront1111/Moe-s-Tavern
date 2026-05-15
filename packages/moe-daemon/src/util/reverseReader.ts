import fs from 'fs';

const DEFAULT_CHUNK_SIZE = 8 * 1024;

export interface ReadLastLinesResult {
  lines: string[];
  hasMoreOlderLines: boolean;
}

/**
 * Read only the last N lines from a file without loading the entire file into memory.
 * Returns lines in chronological order (oldest -> newest within the returned window).
 */
export function readLastLines(filePath: string, maxLines: number): string[] {
  return readLastLinesWithMetadata(filePath, maxLines).lines;
}

/**
 * Read the last N lines and report whether older lines were omitted.
 * Returns lines in chronological order (oldest -> newest within the returned window).
 */
export function readLastLinesWithMetadata(filePath: string, maxLines: number): ReadLastLinesResult {
  if (maxLines <= 0) {
    return { lines: [], hasMoreOlderLines: false };
  }

  if (!fs.existsSync(filePath)) {
    return { lines: [], hasMoreOlderLines: false };
  }

  let fd: number | undefined;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= 0) {
      return { lines: [], hasMoreOlderLines: false };
    }

    // Small-file fast path (and avoids reverse-reader overhead for tiny logs).
    if (stat.size <= DEFAULT_CHUNK_SIZE) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content
        .split(/\r?\n/)
        .filter((line) => line.length > 0);
      return {
        lines: lines.slice(-maxLines),
        hasMoreOlderLines: lines.length > maxLines,
      };
    }

    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(DEFAULT_CHUNK_SIZE);
    const reverseLines: string[] = [];
    let position = stat.size;
    // Accumulate the still-undecoded byte tail at the *front* of the file's
    // read window. We decode bytes only after they're glued to the chunk
    // immediately preceding them, so a multi-byte UTF-8 sequence that spans a
    // chunk boundary is never split mid-character.
    let leadingBytes: Buffer = Buffer.alloc(0);
    let remainder = '';

    while (position > 0 && reverseLines.length < maxLines) {
      const bytesToRead = Math.min(DEFAULT_CHUNK_SIZE, position);
      position -= bytesToRead;
      fs.readSync(fd, buffer, 0, bytesToRead, position);

      // Combine this chunk's bytes with the still-undecoded leading bytes from
      // the previous (further-into-the-file) iteration.
      const combinedBytes = Buffer.concat([
        buffer.subarray(0, bytesToRead),
        leadingBytes,
      ]);

      // If we haven't reached BOF yet, the first byte of combinedBytes may be
      // the middle of a multi-byte UTF-8 character. Find the first valid UTF-8
      // start byte; everything before it must wait for the next iteration.
      let safeStart = 0;
      if (position > 0) {
        // UTF-8 continuation bytes have the high bits 10xxxxxx (0x80..0xBF).
        // Scan forward until we land on a non-continuation byte (or up to 3
        // bytes — the max number of continuation bytes that can precede a
        // start byte in valid UTF-8).
        const maxScan = Math.min(4, combinedBytes.length);
        while (safeStart < maxScan && (combinedBytes[safeStart] & 0xc0) === 0x80) {
          safeStart += 1;
        }
      }

      leadingBytes = combinedBytes.subarray(0, safeStart);
      const decodable = combinedBytes.subarray(safeStart);
      const chunk = decodable.toString('utf-8');
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

    const hasUnreadOlderContent =
      position > 0 ||
      leadingBytes.length > 0 ||
      (reverseLines.length >= maxLines && remainder.length > 0);

    if (reverseLines.length < maxLines && remainder.length > 0) {
      reverseLines.push(remainder);
    }

    return {
      lines: reverseLines.reverse(),
      hasMoreOlderLines: hasUnreadOlderContent,
    };
  } catch {
    return { lines: [], hasMoreOlderLines: false };
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
