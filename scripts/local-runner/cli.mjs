#!/usr/bin/env node
// Read-only provider prerequisites. Provisioning and execution readiness are separate gates.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runDoctor } from './doctor.mjs';

function argumentsFor(argv) {
  if (!Array.isArray(argv) || argv[0] !== 'doctor') return null;
  if (argv.length === 1) return {};
  if (argv.length !== 3 || argv[1] !== '--executable' || typeof argv[2] !== 'string' ||
      argv[2].trim() === '' || /[\x00-\x1f\x7f]/.test(argv[2])) return null;
  return { executable: argv[2] };
}

export async function runCli(argv, { doctor = runDoctor, write = text => process.stdout.write(text) } = {}) {
  const options = argumentsFor(argv);
  const result = options === null
    ? { code: 'CLI_INPUT_INVALID', providerReady: false, executionReady: false, message: 'Usage: cli.mjs doctor [--executable <path>]' }
    : await doctor(options);
  write(`${JSON.stringify(result)}\n`);
  return result.providerReady === true ? 0 : 2;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCli(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    process.stderr.write('Provider doctor could not emit its report.\n');
    process.exitCode = 2;
  });
}
