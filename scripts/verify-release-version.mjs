import fs from 'node:fs';

// Run from the repository root before building or publishing a tagged release.
try {
  const tag = process.argv[2];
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag || '')) {
    throw new Error('Expected a release tag such as v0.8.0');
  }
  const expected = tag.slice(1);
  const versions = [
    'packages/moe-daemon/package.json',
    'packages/moe-proxy/package.json',
    'moe-vscode/package.json',
  ].map(file => [file, JSON.parse(fs.readFileSync(file, 'utf8')).version]);
  const gradle = 'moe-jetbrains/build.gradle.kts';
  versions.push([gradle, fs.readFileSync(gradle, 'utf8').match(/^version\s*=\s*"([^"]+)"/m)?.[1]]);
  const mismatches = versions.filter(([, version]) => version !== expected);
  if (mismatches.length) {
    throw new Error(mismatches.map(([file, version]) => `${file}: found ${version}, expected ${expected}`).join('\n'));
  }
  console.log(`PASS release versions: ${expected}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
