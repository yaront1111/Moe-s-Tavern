// Keeps the folder-trust exception in the docs and comments in step with the
// landed helper (scripts/moe-account-lease.mjs). Reads checked-in text only:
// no account folder, no claude, no environment secrets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

/** Text from `start` up to the next line that begins with `endPrefix` (or the end of file). */
function slice(text, start, endPrefix) {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, `missing anchor: ${start}`);
  const rest = text.slice(from + start.length);
  const to = rest.search(new RegExp(`^${endPrefix}`, 'm'));
  return start + (to === -1 ? rest : rest.slice(0, to));
}

/** The quoted values of the helper's TRUST_REASON object, read from source (never executed). */
function trustReasons() {
  const src = read('scripts/moe-account-lease.mjs');
  const body = src.match(/const TRUST_REASON = \{\n([\s\S]*?)\n\};/);
  assert.ok(body, 'TRUST_REASON object not found');
  const values = [...body[1].matchAll(/^\s*\w+:\s*(?:'([^'\n]*)'|"([^"\n]*)"),\s*$/gm)].map((m) => m[1] ?? m[2]);
  assert.equal(values.length, body[1].trim().split('\n').length, 'every TRUST_REASON line must parse');
  assert.ok(values.length >= 8, 'TRUST_REASON unexpectedly small');
  return values;
}

const troubleshooting = () => slice(read('docs/TROUBLESHOOTING.md'), '## Claude Account Rotation Issues', '## ');

test('TROUBLESHOOTING lists both trust codes and the remedy', () => {
  const section = troubleshooting();
  assert.match(section, /MOE_ACCOUNT_TRUST_GRANTED/);
  assert.match(section, /MOE_ACCOUNT_UNTRUSTED/);
  assert.match(section, /start claude once in the project under that account/);
  assert.match(section, /accept the trust dialog/);
});

test('TROUBLESHOOTING prints every helper refusal reason verbatim', () => {
  const section = troubleshooting();
  for (const reason of trustReasons()) {
    assert.ok(section.includes(`\`${reason}\``), `refusal reason missing from TROUBLESHOOTING: ${reason}`);
  }
});

test('SCHEMA claude-accounts entry states the interactive wrapper exception and the daemon boundary', () => {
  const entry = slice(read('docs/SCHEMA.md'), '- `claude-accounts/<id>/`', '- ');
  assert.match(entry, /daemon and the `accounts` CLI never open a file inside it/);
  assert.match(entry, /scripts\/moe-account-lease\.mjs/);
  assert.match(entry, /interactive claude seat only/);
  assert.match(entry, /\.claude\.json/);
  assert.match(entry, /hasTrustDialogAccepted/);
});

test('registry.ts header and accountConfigDir comments state the exception', () => {
  const src = read('packages/moe-daemon/src/accounts/registry.ts');
  const header = src.slice(0, src.indexOf('import fs'));
  assert.match(header, /neither this module, the daemon nor the accounts CLI opens a file inside it/);
  assert.match(header, /scripts\/moe-account-lease\.mjs/);
  assert.match(header, /interactive claude seat only/);
  assert.match(header, /hasTrustDialogAccepted/);
  const doc = src.match(/\/\*\*[^\n]*\*\/\nexport function accountConfigDir/);
  assert.ok(doc, 'accountConfigDir doc comment not found');
  assert.match(doc[0], /only the wrapper's scripts\/moe-account-lease\.mjs touches \.claude\.json/);
  assert.match(doc[0], /interactive seat/);
});

test('daemon-only statements stay absolute', () => {
  for (const rel of ['docs/ARCHITECTURE.md', 'packages/moe-daemon/CLAUDE.md']) {
    assert.match(read(rel), /The daemon never runs claude and never opens a file inside a Claude config folder/, rel);
  }
  assert.match(read('packages/moe-daemon/src/state/accountStore.ts'), /The daemon never runs claude and never opens a file inside a Claude config/);
});
