import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import type { StateManager } from '../state/StateManager.js';
import { getTools } from './index.js';

// Tool factories only touch `state` inside their handler closures, never at
// construction time, so a bare cast is sufficient to enumerate the registry.
const fakeState = {} as unknown as StateManager;

const toolsDir = path.dirname(fileURLToPath(import.meta.url));

function registeredNames(): string[] {
  return getTools(fakeState).map((t) => t.name);
}

describe('tool registry completeness', () => {
  it('registers the seven chat/activity tools that were previously dropped', () => {
    const names = registeredNames();
    for (const expected of [
      'moe.chat_who',
      'moe.chat_resync',
      'moe.chat_pin',
      'moe.chat_unpin',
      'moe.chat_decision',
      'moe.chat_create_channel',
      'moe.get_activity_log',
    ]) {
      expect(names, `expected ${expected} to be registered in getTools()`).toContain(expected);
    }
  });

  it('registers every exported *Tool factory in src/tools', async () => {
    const registered = new Set(registeredNames());

    const files = fs
      .readdirSync(toolsDir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'index.ts');

    const missing: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(path.join(toolsDir, file), 'utf8');
      const factoryNames = [...source.matchAll(/export function (\w+Tool)\b/g)].map((m) => m[1]);
      if (factoryNames.length === 0) continue;

      // Import the compiled-equivalent module via its source path; vitest resolves .ts.
      const mod = (await import(pathToFileURL(path.join(toolsDir, file)).href)) as Record<
        string,
        (state: StateManager) => { name: string }
      >;
      for (const factory of factoryNames) {
        const toolName = mod[factory](fakeState).name;
        if (!registered.has(toolName)) {
          missing.push(`${factory} (${toolName}) from ${file}`);
        }
      }
    }

    expect(missing, `unregistered tool factories: ${missing.join(', ')}`).toEqual([]);
  });
});
