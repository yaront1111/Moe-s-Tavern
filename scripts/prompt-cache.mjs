import { createInterface } from 'node:readline';
import { checkPolicy } from './prompt-cache-policy.mjs';
import { formatUsage, renderCodexEvent } from './prompt-cache-usage.mjs';

const [command, provider, project, ...args] = process.argv.slice(2);
try {
  if (command === 'check') {
    const mode = checkPolicy({ provider, project, args });
    console.log(`[prompt-cache] provider=${provider} policy=${mode} caching=provider-managed; hits require provider usage evidence`);
  } else if (command === 'claude-stream' || command === 'codex-stream') {
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    let reported = false;
    for await (const line of lines) {
      let event;
      try { event = JSON.parse(line); }
      catch { console.log(line); continue; }
      if (command === 'claude-stream') {
        // Leave Claude events byte-for-byte for the existing attribution and
        // display parser. Only result usage is cumulative; do not sum deltas.
        console.log(line);
        if (event?.type === 'result') {
          console.log(formatUsage('claude', event.usage));
          reported = true;
        }
      } else {
        for (const output of renderCodexEvent(event)) if (output) console.log(output);
        if (event?.type === 'turn.completed') reported = true;
      }
    }
    if (!reported) console.log(formatUsage(command === 'claude-stream' ? 'claude' : 'codex'));
  } else {
    throw new Error('MOE_PROMPT_CACHE_COMMAND_INVALID: expected check, claude-stream, or codex-stream.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
