import { existsSync, readFileSync } from 'node:fs';

// IDE bundles flatten dist/ beside package.json; source/npm layouts retain it.
const manifestUrl = [
  new URL('../package.json', import.meta.url),
  new URL('../../package.json', import.meta.url),
].find(candidate => existsSync(candidate));

if (!manifestUrl) throw new Error('The moe-daemon package manifest is missing.');

const manifest: { version?: unknown } = JSON.parse(
  readFileSync(manifestUrl, 'utf8'),
);

if (typeof manifest.version !== 'string' || manifest.version.trim() === '') {
  throw new Error('The moe-daemon package manifest must contain a version.');
}

export const VERSION = manifest.version;
