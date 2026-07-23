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

async function copyDir(src, dest, { excludeBin } = {}) {
  await cp(src, dest, {
    recursive: true,
    filter: (filePath) => {
      if (!excludeBin) return true;
      const binSegment = `${path.sep}.bin${path.sep}`;
      if (filePath.includes(binSegment)) return false;
      if (filePath.endsWith(`${path.sep}.bin`)) return false;
      return true;
    }
  });
}

async function main() {
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });

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
    await copyDir(asset.dist, distOut);
    await copyDir(asset.deps, depsOut, { excludeBin: true });
    // Both dists are ESM; without "type": "module" beside them only
    // node >= 22.7 (ESM syntax auto-detection) can run the .js files.
    await cp(path.join(path.dirname(asset.dist), 'package.json'), path.join(distOut, 'package.json'));
  }

  // Copy agent scripts
  const scriptsOut = path.join(outputRoot, 'scripts');
  await mkdir(scriptsOut, { recursive: true });
  const agentScripts = ['moe-agent.ps1', 'moe-agent.sh', 'moe-call.sh'];
  for (const script of agentScripts) {
    const src = path.join(repoRoot, 'scripts', script);
    if (await exists(src)) {
      const dest = path.join(scriptsOut, script);
      if (script.endsWith('.sh')) {
        // A CRLF working-tree checkout (core.autocrlf) would ship a script WSL bash can't parse.
        const text = await readFile(src, 'utf8');
        await writeFile(dest, text.replace(/\r\n/g, '\n'));
        // writeFile creates the dest with default 0644; keep the source's exec
        // bit (moe-agent.sh's EXIT trap executes moe-call.sh directly).
        await chmod(dest, (await stat(src)).mode);
      } else {
        await cp(src, dest);
      }
    }
  }

  // Copy role docs and agent-context (fallback for uninitialised projects)
  const rolesOut = path.join(outputRoot, 'docs', 'roles');
  await mkdir(rolesOut, { recursive: true });
  const roleDocs = ['architect.md', 'qa.md', 'worker.md'];
  for (const doc of roleDocs) {
    const src = path.join(repoRoot, 'docs', 'roles', doc);
    if (await exists(src)) {
      await cp(src, path.join(rolesOut, doc));
    }
  }
  const agentContextSrc = path.join(repoRoot, 'docs', 'agent-context.md');
  if (await exists(agentContextSrc)) {
    await cp(agentContextSrc, path.join(outputRoot, 'docs', 'agent-context.md'));
  }

  // Copy the curated skill pack (manifest + per-skill SKILL.md/SOURCE.md).
  // The daemon embeds these in skillFiles.ts at build time, so .moe/skills/
  // gets scaffolded from the bundled daemon. The bundled copy here is only
  // for users who want to inspect or hand-edit them outside .moe/.
  const skillsSrc = path.join(repoRoot, 'docs', 'skills');
  if (await exists(skillsSrc)) {
    await cp(skillsSrc, path.join(outputRoot, 'docs', 'skills'), { recursive: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
