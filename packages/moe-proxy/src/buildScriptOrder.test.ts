// Every seat's MCP bridge runs packages/moe-proxy/dist: do not delete it unless
// the compiler can start. task-a10a7f78: WSL with Windows-native node_modules
// lost the proxy dist through npm test -> pretest -> build -> clean before tsc failed.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

type Scripts = Record<string, string | undefined>;
const manifests: Record<string, Scripts> = {
  'moe-proxy': JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts,
  'moe-claude-plugin': JSON.parse(fs.readFileSync(new URL('../../moe-claude-plugin/package.json', import.meta.url), 'utf8')).scripts,
};
const safePrebuild = 'tsc --version && npm run clean';

function splitSteps(name: string, body: string): string[] {
  const steps: string[] = [];
  let quote = '';
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (quote) {
      if (char === '\\' && quote === '"') i++;
      else if (char === quote) quote = '';
    } else if (char === "'" || char === '"') quote = char;
    else if (body.slice(i, i + 2) === '&&') {
      steps.push(body.slice(start, i).trim());
      start = ++i + 1;
    } else if (';|&'.includes(char)) {
      const op = body.slice(i, i + 2) === '||' ? '||' : char;
      throw new Error(`npm script "${name}" chains steps with "${op}"; only && stops the next step after a failure`);
    }
  }
  steps.push(body.slice(start).trim());
  return steps;
}

function runOrder(all: Scripts, name: string, depth = 0): string[] {
  if (depth > 8) throw new Error(`npm script "${name}" exceeds recursion depth 8`);
  return [`pre${name}`, name, `post${name}`].flatMap((hook) =>
    splitSteps(hook, all[hook] ?? '').flatMap((step) => {
      const nested = /^npm (?:run|run-script) ([\w:-]+)$/.exec(step);
      return nested ? runOrder(all, nested[1], depth + 1) : step ? [step] : [];
    })
  );
}

const isProbe = (step: string): boolean => /^tsc (?:--version|-v)$/.test(step);
const isEmit = (step: string): boolean => /^tsc(?:\s|$)/.test(step) && !isProbe(step);
const removesDist = (step: string): boolean =>
  /\b(?:rmSync|rmdirSync|rimraf|rm|rmdir|del|rd|Remove-Item)\b/i.test(step) &&
  /(?:^|[\s'"(,\\/])dist(?=$|[\s'"),\\/])/i.test(step);

function orderViolations(all: Scripts): string[] {
  try {
    const violations: string[] = [];
    for (const [name, body] of Object.entries(all)) {
      if (name === 'clean' || body === undefined) continue;
      const leaves = runOrder(all, name);
      for (let i = 0; i < leaves.length; i++) {
        if (removesDist(leaves[i]) && !leaves.slice(0, i).some(isProbe)) {
          violations.push(`"${name}" runs "${leaves[i]}" before tsc --version`);
        }
      }
    }
    const build = runOrder(all, 'build');
    const lastRemoval = build.map(removesDist).lastIndexOf(true);
    if (lastRemoval < 0) violations.push('build never removes dist');
    if (!build.some(isEmit)) violations.push('build never emits with tsc');
    if (build.some((step, i) => isEmit(step) && i < lastRemoval)) {
      violations.push('build emits with tsc before dist is removed');
    }
    return violations;
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

describe('builds preserve dist until the compiler can start', () => {
  it.each(Object.entries(manifests))('%s probes tsc before anything removes dist', (_name, scripts) => {
    expect(orderViolations(scripts)).toEqual([]);
  });

  const safe = { ...manifests['moe-proxy'], prebuild: safePrebuild };
  it.each<[string, Scripts, string]>([
    ['old order reaches test', { prebuild: 'npm run clean' }, '"test" runs'],
    ['early pretest removal', { pretest: 'npm run clean && npm run build' }, '"pretest" runs'],
    ['prestart removal', { prestart: 'rimraf dist' }, '"start" runs "rimraf dist"'],
    ['missing clean', { prebuild: 'tsc --version' }, 'build never removes dist'],
    ['missing emit', { build: undefined }, 'build never emits'],
    ['early emit', { prebuild: 'tsc --version', build: 'tsc && npm run clean' }, 'emits with tsc before'],
    ['run-script expansion', { prebuild: 'npm run-script clean && tsc --version && npm run clean' }, 'before tsc --version'],
    ['recursive script', { clean: 'npm run clean' }, 'recursion depth 8'],
    ...[';', '|', '||', '&'].map((op): [string, Scripts, string] =>
      [op, { prebuild: `tsc --version ${op} npm run clean` }, `chains steps with "${op}"`]
    ),
    ...['rm -rf ./dist/', 'rimraf "dist"', 'rmdir /s /q dist', 'del dist\\*', 'rd dist', 'Remove-Item -Recurse dist', `node -e "require('fs').rmdirSync('dist')"`]
      .map((clean): [string, Scripts, string] =>
        [clean, { clean, prebuild: 'npm run clean' }, 'before tsc --version']
      ),
  ])('rejects %s', (_name, override, needle) => {
    expect(orderViolations({ ...safe, ...override })).toContainEqual(expect.stringContaining(needle));
  });

  it('accepts quoted operators and the short compiler probe', () => {
    expect(orderViolations({
      ...safe, prebuild: 'tsc -v && npm run clean',
      postbuild: `node -e "console.log('a;b|c&d')"`,
    })).toEqual([]);
  });
});
