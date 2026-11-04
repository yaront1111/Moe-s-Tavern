import fs from 'node:fs';

// Run from the repository root before building or publishing a tagged release.
// docs/RELEASING.md section 1 lists exactly the fields in FIELDS, in this order.
const PACKAGES = ['packages/moe-daemon', 'packages/moe-proxy', 'packages/moe-claude-plugin', 'moe-vscode'];

const json = (file, pick) => ({ label: file, file, read: text => pick(JSON.parse(text)) });
const FIELDS = [
  ...PACKAGES.flatMap(dir => [
    json(`${dir}/package.json`, data => data.version),
    { ...json(`${dir}/package-lock.json`, data => data.version), label: `${dir}/package-lock.json version` },
    { ...json(`${dir}/package-lock.json`, data => data.packages[''].version), label: `${dir}/package-lock.json packages[""].version` },
  ]),
  json('packages/moe-claude-plugin/.claude-plugin/plugin.json', data => data.version),
  { label: 'moe-jetbrains/build.gradle.kts', file: 'moe-jetbrains/build.gradle.kts', read: text => text.match(/^version\s*=\s*"([^"]+)"/m)?.[1] },
  { label: 'installer/moe-installer.iss', file: 'installer/moe-installer.iss', read: text => text.match(/^AppVersion=(\S+)[ \t]*\r?$/m)?.[1] },
];

function readField(field, cache) {
  try {
    if (!cache.has(field.file)) cache.set(field.file, fs.readFileSync(field.file, 'utf8'));
    return { version: field.read(cache.get(field.file)) };
  } catch {
    return { unreadable: true };
  }
}

try {
  const tag = process.argv[2];
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag || '')) {
    throw new Error('Expected a release tag such as v0.8.0');
  }
  const expected = tag.slice(1);
  const cache = new Map();
  const problems = [];
  for (const field of FIELDS) {
    const result = readField(field, cache);
    if (result.unreadable) problems.push(`${field.label}: unreadable, expected ${expected}`);
    else if (result.version !== expected) problems.push(`${field.label}: found ${result.version}, expected ${expected}`);
  }
  if (problems.length) throw new Error(problems.join('\n'));
  console.log(`PASS release versions: ${expected}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
