#!/usr/bin/env node
// Read-only provider and host prerequisites. Provisioning and execution readiness are separate gates.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runDoctor } from './doctor.mjs';
import { linuxPlatform } from './platform-linux.mjs';
import { windowsPlatform } from './platform-windows.mjs';

// Keyed by process.platform; R05 adds its platform module here.
const PLATFORMS = Object.freeze({ win32: windowsPlatform, linux: linuxPlatform });
const COMMANDS = ['doctor', 'prerequisites'];
const USAGE = 'Usage: cli.mjs doctor|prerequisites [--executable <path>]';

function argumentsFor(argv) {
  if (!Array.isArray(argv) || !COMMANDS.includes(argv[0])) return null;
  if (argv.length === 1) return { command: argv[0], options: {} };
  if (argv.length !== 3 || argv[1] !== '--executable' || typeof argv[2] !== 'string' ||
      argv[2].trim() === '' || /[\x00-\x1f\x7f]/.test(argv[2])) return null;
  return { command: argv[0], options: { executable: argv[2] } };
}

/** The platform module for a process.platform id, or null. */
export const platformFor = id => (Object.hasOwn(PLATFORMS, id) ? PLATFORMS[id] : null);

/** This host's operator prerequisites; a host without a platform module is unsupported, never ready. */
async function hostPrerequisites({ executable }) {
  const platform = platformFor(process.platform);
  if (!platform) return { code: 'PLATFORM_UNSUPPORTED', ready: false, executionReady: false };
  const report = await platform.prerequisites({ provider: { executable } });
  return {
    platform: report.platform, ready: report.ready === true, executionReady: false,
    providerCode: report.providerCode, prerequisites: report.prerequisites,
  };
}

async function reportFor(parsed, doctor, prerequisites) {
  if (parsed === null) return { code: 'CLI_INPUT_INVALID', providerReady: false, executionReady: false, message: USAGE };
  if (parsed.command === 'doctor') return doctor(parsed.options);
  try {
    return await prerequisites(parsed.options);
  } catch {
    // Only a stable code: no stack, path or provider diagnostic reaches the report.
    return { code: 'PREREQUISITES_UNAVAILABLE', ready: false, executionReady: false };
  }
}

export async function runCli(argv, { doctor = runDoctor, prerequisites = hostPrerequisites, write = text => process.stdout.write(text) } = {}) {
  const parsed = argumentsFor(argv);
  const result = await reportFor(parsed, doctor, prerequisites);
  write(`${JSON.stringify(result)}\n`);
  const ready = parsed?.command === 'prerequisites' ? result.ready : result.providerReady;
  return ready === true ? 0 : 2;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCli(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    process.stderr.write('Provider doctor could not emit its report.\n');
    process.exitCode = 2;
  });
}
