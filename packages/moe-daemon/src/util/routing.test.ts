import { describe, expect, it } from 'vitest';
import {
  allowedEfforts, bumpEffort, bumpTier, clampEffort, defaultModel, isLowEffortPlan, maxTier, modelCatalog, modelsForTier,
  planSizeFloor, resolveLaunch,
} from './routing.js';

const steps = (n: number, filesEach: number) =>
  Array.from({ length: n }, (_, i) => ({
    affectedFiles: Array.from({ length: filesEach }, (_, j) => `f${i}-${j}.ts`),
  }));

describe('routing tiers', () => {
  it('floors light / standard / heavy from plan size', () => {
    expect(planSizeFloor(steps(3, 0).map((s, i) => ({ ...s, affectedFiles: i < 2 ? ['a.ts'] : ['b.ts'] })))).toBe('light');
    expect(planSizeFloor(steps(4, 1))).toBe('standard');
    expect(planSizeFloor(steps(9, 1))).toBe('heavy');
    expect(planSizeFloor(steps(2, 2))).toBe('standard');
    expect(planSizeFloor(steps(2, 3))).toBe('heavy');
    // newFiles count toward size
    expect(planSizeFloor([{ affectedFiles: ['a.ts'], newFiles: ['b.ts', 'c.ts'] }])).toBe('standard');
    // warn thresholds come from settings.taskSizing
    expect(planSizeFloor(steps(4, 1), { taskSizing: { warnSteps: 3 } })).toBe('heavy');
  });

  it('bumps and maxes in order, capped at heavy', () => {
    expect(bumpTier('light')).toBe('standard');
    expect(bumpTier('heavy')).toBe('heavy');
    expect(maxTier('light', 'heavy')).toBe('heavy');
    expect(maxTier('standard', undefined)).toBe('standard');
    expect(maxTier('heavy', 'light')).toBe('heavy');
  });

  it('floors a qa seat at xhigh (or settings.routing.qa) and never lowers the task pick', () => {
    const codex = (model: string, effort: string) => ({ model, effort });
    const light = { tier: 'light', status: 'REVIEW', effort: 'high', model: 'claude-sonnet-5-5', codexModel: 'gpt-6-luna' } as const;
    expect(resolveLaunch(light, undefined, 'worker')?.effort).toBe('high');
    expect(resolveLaunch(light, undefined, 'qa'))
      .toEqual({ tier: 'light', effort: 'xhigh', model: 'claude-sonnet-5-5', codex: codex('gpt-6-luna', 'xhigh') });
    expect(resolveLaunch({ tier: 'heavy', status: 'REVIEW', effort: 'max' }, undefined, 'qa')?.effort).toBe('max');
    // Configured floor and model; a model the tier disallows is ignored.
    expect(resolveLaunch(light, { routing: { qa: { effort: 'max', model: 'claude-opus-5-5' } } }, 'qa'))
      .toEqual({ tier: 'light', effort: 'max', model: 'claude-opus-5-5', codex: codex('gpt-6-luna', 'max') });
    expect(resolveLaunch({ tier: 'heavy', status: 'REVIEW' }, { routing: { qa: { model: 'claude-sonnet-5-5' } } }, 'qa')?.model)
      .toBe('claude-opus-5-5');
  });

  it('resolves launch with defaults, overrides, and ignores bad config', () => {
    const opus = 'claude-opus-5-5';
    const codex = (model: string, effort: string) => ({ model, effort });
    expect(resolveLaunch({ tier: 'light', status: 'WORKING' }))
      .toEqual({ tier: 'light', effort: 'high', model: opus, codex: codex('gpt-6-astra', 'high') });
    expect(resolveLaunch({ tier: 'heavy', status: 'REVIEW' }))
      .toEqual({ tier: 'heavy', effort: 'max', model: opus, codex: codex('gpt-6-astra', 'max') });
    // Planner picks win while still allowed for the tier.
    expect(resolveLaunch({ tier: 'light', status: 'WORKING', effort: 'xhigh', model: 'claude-sonnet-5-5', codexModel: 'gpt-6-luna' }))
      .toEqual({ tier: 'light', effort: 'xhigh', model: 'claude-sonnet-5-5', codex: codex('gpt-6-luna', 'xhigh') });
    // A pick the tier no longer allows falls back to the provider default.
    expect(resolveLaunch({ tier: 'heavy', status: 'WORKING', model: 'claude-sonnet-5-5', codexModel: 'gpt-6-luna' }))
      .toEqual({ tier: 'heavy', effort: 'max', model: opus, codex: codex('gpt-6-astra', 'max') });
    // A disallowed effort (tier config or stored) is raised, never lowered.
    expect(resolveLaunch({ tier: 'light', status: 'WORKING' }, { routing: { light: { model: 'custom-model', effort: 'low' } } }))
      .toEqual({ tier: 'light', effort: 'high', model: 'custom-model', codex: codex('gpt-6-astra', 'high') });
    expect(resolveLaunch({ tier: 'light', status: 'WORKING', effort: 'medium' })?.effort).toBe('high');
    const bad = { routing: { standard: { model: 42, effort: 'turbo' }, models: 'nope' } } as never;
    expect(resolveLaunch({ tier: 'standard', status: 'WORKING' }, bad))
      .toEqual({ tier: 'standard', effort: 'xhigh', model: opus, codex: codex('gpt-6-astra', 'xhigh') });
    expect(resolveLaunch({ tier: 'light', status: 'WORKING' }, { routing: { enabled: false } })).toBeUndefined();
    expect(resolveLaunch({ status: 'WORKING' })).toBeUndefined();
    expect(resolveLaunch({ tier: 'heavy', status: 'PLANNING' })).toBeUndefined();
  });

  it('keeps the catalog per provider, one entry per model, defaults for unmentioned providers', () => {
    expect(modelsForTier('light').sort()).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(modelsForTier('heavy')).toEqual(['claude-opus-5-5']);
    expect(modelsForTier('light', undefined, 'codex')).toEqual(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna']);
    expect(modelsForTier('standard', undefined, 'codex')).toEqual(['gpt-6-astra', 'gpt-6.1-sol']);
    // Adding a model is one entry; configuring only claude keeps the built-in codex models.
    const settings = { routing: { models: [
      { id: 'claude-next' },
      { id: 'cheap-claude', use: 'mechanical', tiers: ['light' as const] },
      { id: '' }, { id: 'x', provider: 'other' as never }, { id: 'y', tiers: ['nope' as never] },
    ] } };
    expect(modelCatalog(settings, 'claude').map((m) => m.id)).toEqual(['claude-next', 'cheap-claude', 'y']);
    expect(defaultModel(settings)).toBe('claude-next');
    expect(defaultModel(settings, 'codex')).toBe('gpt-6-astra');
    expect(modelsForTier('heavy', settings)).toEqual(['claude-next', 'y']);
  });

  it('allows only the configured efforts: clamps up, bumps to the next allowed level', () => {
    expect(allowedEfforts()).toEqual(['high', 'xhigh', 'max']);
    expect(allowedEfforts({ routing: { efforts: ['bogus' as never] } })).toEqual(['high', 'xhigh', 'max']);
    expect(clampEffort('low')).toBe('high');
    expect(clampEffort('xhigh')).toBe('xhigh');
    expect(bumpEffort('high')).toBe('xhigh');
    expect(bumpEffort('xhigh')).toBe('max');
    expect(bumpEffort('max')).toBe('max');
    const custom = { routing: { efforts: ['medium' as const, 'max' as const] } };
    expect(clampEffort('low', custom)).toBe('medium');
    expect(clampEffort('high', custom)).toBe('max');
    expect(bumpEffort('medium', custom)).toBe('max');
    expect(clampEffort('max', { routing: { efforts: ['high' as const] } })).toBe('high');
  });

  it('decides docs/tests-only from the plan files, and only then allows low/medium', () => {
    const plan = (...files: string[]) => [{ affectedFiles: files }];
    expect(isLowEffortPlan(plan('README.md', 'docs/guide/x.png', 'src/a.test.ts'))).toBe(true);
    expect(isLowEffortPlan(plan('pkg/tests/fixture.json', 'lib/__tests__/b.js', 'x.spec.tsx'))).toBe(true);
    expect(isLowEffortPlan([{ affectedFiles: ['docs/a.md'], newFiles: ['src/new.ts'] }])).toBe(false);
    expect(isLowEffortPlan(plan('src/app.ts'))).toBe(false);
    expect(isLowEffortPlan(plan())).toBe(false);
    expect(isLowEffortPlan(plan('scripts/run.sh'), { routing: { lowEffortFiles: ['scripts/*.sh'] } })).toBe(true);
    expect(isLowEffortPlan(plan('scripts/sub/run.sh'), { routing: { lowEffortFiles: ['scripts/*.sh'] } })).toBe(false);

    expect(allowedEfforts(undefined, true)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(clampEffort('low', undefined, true)).toBe('low');
    expect(bumpEffort('medium', undefined, true)).toBe('high');
    // Eligibility widens what the planner may pick; the omitted default stays the tier's
    // (a tests-only file list can still be a heavy batch that runs every gate).
    expect(resolveLaunch({ tier: 'standard', status: 'WORKING', lowEffortEligible: true })?.effort).toBe('xhigh');
    expect(resolveLaunch({ tier: 'heavy', status: 'WORKING', lowEffortEligible: true })?.effort).toBe('max');
    expect(resolveLaunch({ tier: 'light', status: 'WORKING', effort: 'low', lowEffortEligible: true })?.effort).toBe('low');
  });
});
