import { describe, it, expect } from 'vitest';
import { generateId } from './ids.js';

describe('generateId', () => {
  it('generates an id with the given prefix', () => {
    const id = generateId('task');
    expect(id).toMatch(/^task-[a-f0-9]{8}$/);
  });

  it('generates unique ids on each call', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateId('test'));
    }
    expect(ids.size).toBe(100);
  });

  it('works with different prefixes', () => {
    expect(generateId('epic')).toMatch(/^epic-/);
    expect(generateId('worker')).toMatch(/^worker-/);
    expect(generateId('proposal')).toMatch(/^proposal-/);
  });

  it('handles empty prefix', () => {
    const id = generateId('');
    expect(id).toMatch(/^-[a-f0-9]{8}$/);
  });
});
