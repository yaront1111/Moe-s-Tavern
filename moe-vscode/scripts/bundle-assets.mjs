import { cp, rm, mkdir, stat } from 'fs/promises';
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
    out: path.join(outputRoot, 'daemon')
  },
  {
    name: 'proxy',
    dist: path.join(repoRoot, 'packages', 'moe-proxy', 'dist'),
    deps: path.join(repoRoot, 'packages', 'moe-proxy', 'node_modules'),
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

    const distOut = asset.out;
    const depsOut = path.join(asset.out, 'node_modules');
    await mkdir(distOut, { recursive: true });
    await copyDir(asset.dist, distOut);
    await copyDir(asset.deps, depsOut, { excludeBin: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
