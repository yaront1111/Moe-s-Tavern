import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const source = fs.readFileSync(new URL('./version.ts', import.meta.url), 'utf8');
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fs.rmSync(fixture, { recursive: true, force: true });
});

describe('package version discovery', () => {
  for (const layout of ['src', 'dist', 'bundled']) {
    it(`reads the actual manifest in the ${layout} layout from another working directory`, () => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-version-'));
      fixtures.push(fixture);
      const modulePath = path.join(fixture, layout === 'bundled' ? 'util' : `${layout}/util`, 'version.ts');
      fs.mkdirSync(path.dirname(modulePath), { recursive: true });
      fs.writeFileSync(modulePath, source);
      fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({
        name: 'moe-daemon', type: 'module', version: '9.8.7',
      }));
      const result = spawnSync(process.execPath, [
        '--import', 'tsx', '--input-type=module', '--eval',
        `import(${JSON.stringify(pathToFileURL(modulePath).href)}).then(module => console.log(module.VERSION))`,
      ], { cwd: packageRoot, encoding: 'utf8', timeout: 10000, windowsHide: true });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('9.8.7');
    });
  }
});
