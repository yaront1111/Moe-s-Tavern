import { cp, rm, mkdir, stat, readdir, readFile, writeFile, chmod } from 'fs/promises';
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
    src: path.join(repoRoot, 'packages', 'moe-daemon', 'src'),
    out: path.join(outputRoot, 'daemon')
  },
  {
    name: 'proxy',
    dist: path.join(repoRoot, 'packages', 'moe-proxy', 'dist'),
    deps: path.join(repoRoot, 'packages', 'moe-proxy', 'node_modules'),
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

async function copyDir(src, dest, { excludeBin, excludeTests } = {}) {
  await cp(src, dest, {
    recursive: true,
    filter: (filePath) => {
      // moe-proxy's tsconfig compiles src/*.test.ts, and compiled tests never ship.
      if (excludeTests && /\.(test|spec)\./.test(path.basename(filePath))) return false;
      if (!excludeBin) return true;
      const binSegment = `${path.sep}.bin${path.sep}`;
      if (filePath.includes(binSegment)) return false;
      if (filePath.endsWith(`${path.sep}.bin`)) return false;
      return true;
    }
  });
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

    const distOut = asset.out;
    const depsOut = path.join(asset.out, 'node_modules');
    await mkdir(distOut, { recursive: true });
    await copyDir(asset.dist, distOut, { excludeTests: true });
    await copyDir(asset.deps, depsOut, { excludeBin: true });
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

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
