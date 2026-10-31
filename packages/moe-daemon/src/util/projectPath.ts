import path from 'path';

// The project-path identity contract. index.ts re-exports it, and
// scripts/tests/daemon-json-cap.test.mjs reads comparableProjectPath from dist/index.js.

export function canonicalProjectPath(projectPath: string): string {
  return path.resolve(projectPath);
}

const WINDOWS_FORM = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;
const WSL_SHARE = /^\/\/(?:wsl\$|wsl\.localhost)\/[^/]+(\/.*)?$/i;
const MNT_DRIVE = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/;

/**
 * Comparison-only form of a project path; never written anywhere. The contract
 * is documented on moe-proxy's comparableProjectPath (packages/moe-proxy/src/utils.ts).
 * Keep the two equivalent: scripts/tests/daemon-json-cap.test.mjs checks both dists against one table.
 */
export function comparableProjectPath(projectPath: string): string {
  const raw = projectPath.trim();
  const abs = WINDOWS_FORM.test(raw) || raw.startsWith('/') ? raw : path.resolve(raw);
  if (!WINDOWS_FORM.test(abs)) return posixKey(abs);
  const s = abs.replace(/\\/g, '/');
  const share = WSL_SHARE.exec(s);
  if (share) return posixKey(share[1] ?? '/');
  const unc = s.startsWith('//');
  return ((unc ? '//' : '') + collapse(s, unc ? 2 : 1)).toLowerCase();
}

function posixKey(p: string): string {
  const key = '/' + collapse(p, 0);
  const mnt = MNT_DRIVE.exec(key);
  return mnt ? `${mnt[1]}:${mnt[2] ? `/${mnt[2]}` : ''}`.toLowerCase() : key;
}

/** Drops empty and '.' segments; '..' never pops the first `keep` (drive, or UNC server and share). */
function collapse(p: string, keep: number): string {
  const kept: string[] = [];
  for (const segment of p.split('/').filter((s) => s !== '' && s !== '.')) {
    if (segment !== '..') kept.push(segment);
    else if (kept.length > keep) kept.pop();
  }
  return kept.join('/');
}

export function isSameProjectPath(a: string, b: string): boolean {
  return comparableProjectPath(a) === comparableProjectPath(b);
}
