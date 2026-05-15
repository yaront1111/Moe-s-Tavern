import type { MemorySettings, ProjectSettings } from '../types/schema.js';

export const MEMORY_AUTO_INJECT_MODES = ['off', 'summary', 'full'] as const;

export const DEFAULT_MEMORY_SETTINGS: Required<MemorySettings> = {
  autoInject: 'off',
  maxAutoResults: 1,
  maxAutoChars: 500,
  autoSave: {
    completedTask: false,
    firstPassApproval: false,
    qaRejection: true,
    reopenedApproval: true,
  },
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

export function resolveMemorySettings(settings?: Partial<ProjectSettings> | null): Required<MemorySettings> {
  const configured = settings?.memory ?? {};
  const autoInject = MEMORY_AUTO_INJECT_MODES.includes(configured.autoInject as typeof MEMORY_AUTO_INJECT_MODES[number])
    ? configured.autoInject!
    : DEFAULT_MEMORY_SETTINGS.autoInject;

  return {
    autoInject,
    maxAutoResults: clampInt(configured.maxAutoResults, DEFAULT_MEMORY_SETTINGS.maxAutoResults, 0, 10),
    maxAutoChars: clampInt(configured.maxAutoChars, DEFAULT_MEMORY_SETTINGS.maxAutoChars, 0, 10_000),
    autoSave: {
      completedTask: configured.autoSave?.completedTask ?? DEFAULT_MEMORY_SETTINGS.autoSave.completedTask,
      firstPassApproval: configured.autoSave?.firstPassApproval ?? DEFAULT_MEMORY_SETTINGS.autoSave.firstPassApproval,
      qaRejection: configured.autoSave?.qaRejection ?? DEFAULT_MEMORY_SETTINGS.autoSave.qaRejection,
      reopenedApproval: configured.autoSave?.reopenedApproval ?? DEFAULT_MEMORY_SETTINGS.autoSave.reopenedApproval,
    },
  };
}

export function truncateForBudget(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (maxChars <= 0) return { text: '', truncated: text.length > 0 };
  if (text.length <= maxChars) return { text, truncated: false };
  const suffix = '…';
  return {
    text: text.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd() + suffix,
    truncated: true,
  };
}

