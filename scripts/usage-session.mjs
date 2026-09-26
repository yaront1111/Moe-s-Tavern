import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// The wrapper sends metadata through the environment so PowerShell 5.1 never
// has to round-trip JSON quotes through native argv. No prompt text belongs here.
try {
  const project = process.argv[2];
  if (!project || !path.isAbsolute(project)) throw new Error('project');
  const context = JSON.parse(process.env.MOE_USAGE_CONTEXT_JSON || '{}');
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error('context');
  const launchId = randomUUID();
  const directory = path.join(project, 'logs', 'moe-usage');
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${launchId}.jsonl`);
  writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ file, context: { ...context, launchId } }));
} catch {
  // Diagnostic failures cannot prevent coding, verification or postflight.
  console.error('[usage] MOE_USAGE_REPORT_UNAVAILABLE');
}
