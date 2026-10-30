// The running daemon loads dist/: fail before deleting it if generation or the
// compiler cannot start. task-f9789178: a WSL build with Windows-native modules
// deleted the live dist before its generator failed.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

type Scripts = Record<string, string | undefined>;
const { scripts } = JSON.parse(
  fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
) as { scripts: Scripts };
const safePrebuild = 'npm run generate-init-files && npm run generate-skill-files && tsc --version && npm run clean';

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
      const nested = /^npm (?:run|run-script) ([\w-]+)$/.exec(step);
      return nested ? runOrder(all, nested[1], depth + 1) : step ? [step] : [];
    })
  );
}

function orderViolations(all: Scripts): string[] {
  let leaves: string[];
  try {
    leaves = runOrder(all, 'build');
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const init = leaves.map((step) => step.includes('scripts/generate-init-files.ts')).lastIndexOf(true);
  const skill = leaves.map((step) => step.includes('scripts/generate-skill-files.ts')).lastIndexOf(true);
  const isProbe = (step: string) => /^tsc (?:--version|-v)$/.test(step);
  const probe = leaves.map(isProbe).lastIndexOf(true);
  const emits = leaves.flatMap((step, i) => /^tsc(?:\s|$)/.test(step) && !isProbe(step) ? [i] : []);
  const removals = leaves.flatMap((step, i) =>
    /\b(?:rmSync|rmdirSync|rimraf|rm|rmdir|del|rd|Remove-Item)\b/i.test(step) &&
    /(?:^|[\s'"(,\\/])dist(?=$|[\s'"),\\/])/i.test(step) ? [i] : []
  );
  const violations: string[] = [];
  if (init < 0) violations.push('generate-init-files never runs');
  if (skill < 0) violations.push('generate-skill-files never runs');
  if (probe < 0) violations.push('tsc --version never runs');
  if (!removals.length) violations.push('nothing removes dist');
  if (!emits.length) violations.push('tsc never emits');
  for (const i of removals) {
    if (i < Math.max(init, skill, probe)) {
      violations.push(`"${leaves[i]}" removes dist before the generators and the compiler probe succeed`);
    }
  }
  if (emits.some((i) => i < (removals.at(-1) ?? -1))) {
    violations.push('tsc emits before dist is removed');
  }
  return violations;
}

describe('daemon build preserves dist until prerequisites succeed', () => {
  it('orders the real npm lifecycle safely', () => {
    expect(orderViolations(scripts)).toEqual([]);
  });

  const safe = { ...scripts, prebuild: safePrebuild };
  it.each<[string, Scripts, string]>([
    ['old order', { prebuild: 'npm run clean && npm run generate-init-files && npm run generate-skill-files' }, 'removes dist before'],
    ['semicolon', { prebuild: safePrebuild.replace(' && tsc', '; tsc') }, 'chains steps with ";"'],
    ['missing probe', { prebuild: safePrebuild.replace('tsc --version && ', '') }, 'tsc --version never runs'],
    ['missing clean', { prebuild: safePrebuild.replace(' && npm run clean', '') }, 'nothing removes dist'],
    ['inline removal', { prebuild: undefined, build: `node -e "require('fs').rmSync('dist',{recursive:true,force:true})" && npm run generate-init-files && npm run generate-skill-files && tsc --version && tsc` }, 'removes dist before'],
    ['early emit', { prebuild: safePrebuild.replace(' && npm run clean', ''), build: 'tsc && npm run clean' }, 'emits before'],
    ['missing init generator', { 'generate-init-files': undefined }, 'generate-init-files never runs'],
    ['missing skill generator', { 'generate-skill-files': undefined }, 'generate-skill-files never runs'],
    ['missing emit', { build: undefined }, 'tsc never emits'],
    ['recursive script', { clean: 'npm run clean' }, 'recursion depth 8'],
    ['nested pre-hook removal', { 'pregenerate-init-files': 'npm run clean' }, 'removes dist before'],
    ['nested post-hook removal', { postbuild: 'npm run clean' }, 'emits before'],
    ['run-script expansion', { prebuild: `npm run-script clean && ${safePrebuild}` }, 'removes dist before'],
    ...['|', '||', '&'].map((op): [string, Scripts, string] =>
      [op, { prebuild: safePrebuild.replace(' && tsc', ` ${op} tsc`) }, `chains steps with "${op}"`]
    ),
    ...['rmdir /s /q dist', 'rm -rf ./dist/', 'rimraf "dist"', 'del dist\\*', 'rd dist', 'Remove-Item -Recurse dist', `node -e "require('fs').rmdirSync('dist')"`]
      .map((clean): [string, Scripts, string] =>
        [clean, { clean, prebuild: `npm run clean && ${safePrebuild}` }, 'removes dist before']
      ),
  ])('rejects %s', (_name, override, needle) => {
    expect(orderViolations({ ...safe, ...override })).toContainEqual(expect.stringContaining(needle));
  });

  it('accepts quoted operators and the short compiler probe', () => {
    expect(orderViolations({
      ...safe, prebuild: safePrebuild.replace('--version', '-v'),
      postbuild: `node -e "console.log('a;b|c&d')"`,
    })).toEqual([]);
  });
});
