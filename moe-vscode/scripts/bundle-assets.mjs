import { cp, rm, mkdir, stat, readdir, readFile, writeFile, chmod } from 'fs/promises';
import { realpathSync } from 'fs';
import { isBuiltin } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, '..', '..');
const vscodeRoot = path.join(repoRoot, 'moe-vscode');
const outputRoot = path.join(vscodeRoot, 'bundled');

const assets = [
  {
    name: 'daemon',
    dist: path.join(repoRoot, 'packages', 'moe-daemon', 'dist'),
    deps: path.join(repoRoot, 'packages', 'moe-daemon', 'node_modules'),
    lock: path.join(repoRoot, 'packages', 'moe-daemon', 'package-lock.json'),
    src: path.join(repoRoot, 'packages', 'moe-daemon', 'src'),
    out: path.join(outputRoot, 'daemon')
  },
  {
    name: 'proxy',
    dist: path.join(repoRoot, 'packages', 'moe-proxy', 'dist'),
    deps: path.join(repoRoot, 'packages', 'moe-proxy', 'node_modules'),
    lock: path.join(repoRoot, 'packages', 'moe-proxy', 'package-lock.json'),
    src: path.join(repoRoot, 'packages', 'moe-proxy', 'src'),
    out: path.join(outputRoot, 'proxy')
  }
];

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// Newest mtime of any non-test source file under dir. Used to refuse bundling
// a dist that predates the sources — an old dist bundles silently and ships
// removed behavior (e.g. the pre-3d2cb16 idle-based worker sweep) inside the
// extension, where it resurrects bugs the repo already fixed.
async function newestSourceMtime(dir) {
  let newest = 0;
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.includes('.test.')) continue;
    const s = await stat(path.join(entry.parentPath ?? entry.path, entry.name));
    if (s.mtimeMs > newest) newest = s.mtimeMs;
  }
  return newest;
}

// moe-proxy's tsconfig compiles src/*.test.ts, and compiled tests never ship.
const isTestFile = (filePath) => /\.(test|spec)\./.test(path.basename(filePath));

// The node_modules rule of moe-jetbrains/build.gradle.kts (task-864103f3), so both IDE bundles ship one set.
// A package-lock.json packages key: node_modules/<name>, optionally nested (node_modules/a/node_modules/b).
const LOCKFILE_KEY = /^node_modules\/(?:@[^/\\]+\/)?[^/\\]+(?:\/node_modules\/(?:@[^/\\]+\/)?[^/\\]+)*$/;

// The lockfile's production packages as paths under node_modules ("chokidar", "pino-pretty/node_modules/sonic-boom"):
// every entry not marked "dev": true, optional and peer ones included. An unusable lockfile stops the bundle;
// nothing falls back to copying the whole tree.
export async function productionPackages(lockFile) {
  const bad = (what) => new Error(`Lockfile ${lockFile} ${what}`);
  const text = await readFile(lockFile, 'utf8').catch((err) => { throw bad(`is missing or unreadable: ${err.message}`); });
  let parsed;
  try { parsed = JSON.parse(text); } catch (err) { throw bad(`is not valid JSON: ${err.message}`); }
  const packages = parsed?.packages;
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) {
    throw bad('has no packages map (npm lockfileVersion 2 or newer is required)');
  }
  const found = [];
  for (const [key, entry] of Object.entries(packages)) {
    if (!key.startsWith('node_modules/')) continue;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw bad(`entry ${key} must be an object`);
    if (!LOCKFILE_KEY.test(key) || key.split('/').some((s) => s === '.' || s === '..')) {
      throw bad(`key ${key} is not a node_modules package path`);
    }
    if (entry.dev === true) continue;
    // npm creates a link even for an optional entry, and its target lies outside node_modules.
    if (entry.link === true) throw bad(`entry ${key} is a link, which cannot be bundled`);
    found.push(key.slice('node_modules/'.length));
  }
  return found.sort();
}

// The four ways a dist file can name a package: static from, side-effect import, dynamic import() and require().
// Group 2 is the specifier; the static form never crosses a quote or backtick.
const IMPORT_FORMS = [
  /^\s*(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])([^'"\n]+)\1/dgm,
  /^\s*import\s*(['"])([^'"\n]+)\1/dgm,
  /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/dg,
  /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/dg,
];
// A URL scheme covers node:, file: and data: specifiers.
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

// The package a bare specifier names: its first segment, or two for a @scope.
const packageOf = (specifier) => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');

// The bare package imports of a source in source order, as { specifier, line }: relative and absolute paths, URL
// schemes and Node builtins (bare or node:) never resolve from node_modules, so they are skipped.
export function bareImports(source) {
  return IMPORT_FORMS.flatMap((form) => [...source.matchAll(form)])
    .map((match) => ({ specifier: match[2], at: match.indices[2][0] }))
    .filter(({ specifier }) => !/^[./]/.test(specifier) && !URL_SCHEME.test(specifier) && !isBuiltin(packageOf(specifier)))
    .sort((a, b) => a.at - b.at)
    // The specifier's own line: a leading ^\s* can start the match on an earlier blank line.
    .map(({ specifier, at }) => ({ specifier, line: 1 + (source.slice(0, at).match(/\n/g)?.length ?? 0) }));
}

// Every problem one asset would ship: production packages that are not installed, and dist imports of packages that
// do not ship (only top-level entries resolve from the dist; a nested one serves its parent package alone).
async function bundleProblems(asset, packages) {
  const problems = [];
  const missing = [];
  for (const rel of packages) {
    if (!(await stat(path.join(asset.deps, rel, 'package.json')).catch(() => undefined))?.isFile()) missing.push(rel);
  }
  if (missing.length > 0) {
    problems.push(`Bundled moe-${asset.name} production packages from ${asset.lock} are missing at ${asset.deps} ` +
      `(run npm ci in packages/moe-${asset.name}): ${missing.join(', ')}`);
  }
  const shipped = new Set(packages.filter((rel) => !rel.includes('/node_modules/')));
  const unshipped = [];
  const scripts = (await readdir(asset.dist, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.[cm]?js$/.test(entry.name) && !isTestFile(entry.name))
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name)).sort();
  for (const file of scripts) {
    const rel = path.relative(asset.dist, file).split(path.sep).join('/');
    for (const { specifier, line } of bareImports(await readFile(file, 'utf8'))) {
      if (!shipped.has(packageOf(specifier))) unshipped.push(`'${specifier}' (${rel}:${line})`);
    }
  }
  if (unshipped.length > 0) {
    problems.push(`Bundled moe-${asset.name} dist imports packages its bundled node_modules does not ship ` +
      `(devDependencies are not bundled): ${[...new Set(unshipped)].join(', ')}`);
  }
  return problems;
}

// The scripts and docs to bundle come from one manifest, which moe-jetbrains/build.gradle.kts reads too;
// its comment member states the copy rules. The daemon and proxy copies stay here, beside their checks.
const manifestPath = path.join(repoRoot, 'scripts/bundle-manifest.json');

async function readManifest() {
  const text = await readFile(manifestPath, 'utf8').catch((err) => {
    throw new Error(`Bundle manifest ${manifestPath} is unreadable: ${err.message}`);
  });
  const malformed = (what) => new Error(`Bundle manifest ${manifestPath} is malformed: ${what}`);
  const str = (key, value, isPath) => {
    if (typeof value !== 'string' || value === '') throw malformed(`${key} must be a non-empty string`);
    if (isPath && (/^[\\/]/.test(value) || path.isAbsolute(value) || value.split(/[\\/]/).includes('..'))) {
      throw malformed(`${key} (${value}) must be a relative path with no .. segment`);
    }
    return value;
  };
  const list = (key, value, arePaths) => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw malformed(`${key} must be an array of non-empty strings`);
    return value.map((item, i) => str(`${key}[${i}]`, item, arePaths));
  };
  let parsed;
  try { parsed = JSON.parse(text); } catch (err) { throw malformed(err.message); }
  const copies = parsed?.copies;
  if (!Array.isArray(copies) || copies.length === 0) throw malformed('copies must be a non-empty array');
  return copies.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw malformed(`copies[${i}] must be an object`);
    return {
      from: str(`copies[${i}].from`, entry.from, true),
      into: str(`copies[${i}].into`, entry.into, true),
      files: list(`copies[${i}].files`, entry.files, true),
      required: list(`copies[${i}].required`, entry.required, true),
      exclude: list(`copies[${i}].exclude`, entry.exclude, false),
    };
  });
}

// Every manifest source is checked before anything is copied.
async function requireManifestSources(copies) {
  for (const copy of copies) {
    const dir = path.join(repoRoot, copy.from);
    if (!(await exists(dir)) || !(await stat(dir)).isDirectory()) throw new Error(`Bundled ${copy.from} not found at ${dir}.`);
    for (const name of [...copy.files, ...copy.required]) {
      const file = path.join(dir, name);
      if (!(await exists(file)) || !(await stat(file)).isFile()) {
        throw new Error(`Required ${copy.from}/${name} asset not found at ${dir}.`);
      }
    }
  }
}

// An exclude pattern as Gradle (Ant) reads it. Not path.matchesGlob: on Node 24.21 it returns false for
// ('a/.claude-plugin/x.test.ts', '**/*.test.ts') and for ('tests', '**/tests/**'), and Gradle excludes both.
const antPattern = (glob) => new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  .replace(/\*\*\/|\/\*\*$|\*\*|\*|\?/g, (t) => ({ '**/': '(?:[^/]+/)*', '/**': '(?:/.*)?', '**': '.*', '*': '[^/]*', '?': '[^/]' })[t]) + '$');

async function main() {
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  const copies = await readManifest();
  await requireManifestSources(copies);

  const packagesOf = new Map();
  for (const asset of assets) {
    if (!(await exists(asset.dist))) {
      throw new Error(`${asset.name} dist not found at ${asset.dist}. Run build first.`);
    }
    if (!(await exists(asset.deps))) {
      throw new Error(`${asset.name} dependencies not found at ${asset.deps}. Run npm install first.`);
    }
    if (await exists(asset.src)) {
      const distMain = path.join(asset.dist, 'index.js');
      const distMtime = (await exists(distMain)) ? (await stat(distMain)).mtimeMs : 0;
      const srcMtime = await newestSourceMtime(asset.src);
      if (srcMtime > distMtime) {
        throw new Error(
          `${asset.name} dist at ${asset.dist} is STALE (source files are newer than dist/index.js). ` +
          `Rebuild first (cd packages/moe-${asset.name} && npm run build) — bundling an old dist ships outdated daemon behavior.`
        );
      }
    }

    packagesOf.set(asset, await productionPackages(asset.lock));
  }

  // Checks both packages before anything is copied and reports every problem in one failure.
  const problems = [];
  for (const asset of assets) problems.push(...await bundleProblems(asset, packagesOf.get(asset)));
  if (problems.length > 0) throw new Error(problems.join('\n'));

  for (const asset of assets) {
    const distOut = asset.out;
    await mkdir(distOut, { recursive: true });
    await cp(asset.dist, distOut, { recursive: true, filter: (filePath) => !isTestFile(filePath) });
    // Each package without its own nested node_modules: a nested production package is a lockfile entry of its
    // own, so .bin, stray installs, caches and dev-only nested packages never ship.
    for (const rel of packagesOf.get(asset)) {
      const from = path.join(asset.deps, rel);
      const nested = path.join(from, 'node_modules');
      await cp(from, path.join(distOut, 'node_modules', rel), { recursive: true, filter: (p) => p !== nested });
    }
    // Both dists are ESM; without "type": "module" beside them only
    // node >= 22.7 (ESM syntax auto-detection) can run the .js files.
    await cp(path.join(path.dirname(asset.dist), 'package.json'), path.join(distOut, 'package.json'));
  }

  for (const copy of copies) {
    const src = path.join(repoRoot, copy.from);
    const dest = path.join(outputRoot, copy.into);
    if (copy.files.length === 0) {
      const excludes = copy.exclude.map(antPattern);
      await cp(src, dest, {
        recursive: true,
        filter: (p) => !excludes.some((re) => re.test(path.relative(src, p).replaceAll('\\', '/'))),
      });
      continue;
    }
    for (const name of copy.files) {
      const from = path.join(src, name);
      const to = path.join(dest, name);
      await mkdir(path.dirname(to), { recursive: true });
      if (!name.endsWith('.sh')) {
        await cp(from, to);
        continue;
      }
      // A CRLF working-tree checkout (core.autocrlf) would ship a script WSL bash can't parse.
      await writeFile(to, (await readFile(from, 'utf8')).replace(/\r\n/g, '\n'));
      // writeFile creates the dest with default 0644; keep the source's exec
      // bit (the wrappers execute bundled shell scripts directly).
      await chmod(to, (await stat(from)).mode);
    }
  }
}

// `npm run bundle` runs this file; tests/bundle-assets.test.cjs imports it for the helpers above, which must not bundle.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    const [a, b] = [realpathSync(process.argv[1]), realpathSync(__filename)];
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
