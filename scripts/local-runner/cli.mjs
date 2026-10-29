#!/usr/bin/env node
// Read-only provider and host prerequisites. Provisioning and execution readiness are separate gates.
// The exception is `native-smoke`: an operator-invoked run that launches and deletes one owned VM.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runDoctor } from './doctor.mjs';
import { linuxPlatform } from './platform-linux.mjs';
import { macosPlatform } from './platform-macos.mjs';
import { windowsPlatform } from './platform-windows.mjs';

const PLATFORMS = Object.freeze({ win32: windowsPlatform, linux: linuxPlatform, darwin: macosPlatform });
const COMMANDS = ['doctor', 'prerequisites', 'native-smoke'];
const USAGE = 'Usage: cli.mjs doctor|prerequisites [--executable <path>] | native-smoke --work-dir <absolute path>';

function argumentsFor(argv) {
  if (!Array.isArray(argv) || !COMMANDS.includes(argv[0])) return null;
  const smoke = argv[0] === 'native-smoke';
  if (argv.length === 1 && !smoke) return { command: argv[0], options: {} };
  if (argv.length !== 3 || argv[1] !== (smoke ? '--work-dir' : '--executable') || typeof argv[2] !== 'string' ||
      argv[2].trim() === '' || /[\x00-\x1f\x7f]/.test(argv[2]) || (smoke && !path.isAbsolute(argv[2]))) return null;
  return { command: argv[0], options: smoke ? { workDir: argv[2] } : { executable: argv[2] } };
}

/** The platform module for a process.platform id, or null. */
export const platformFor = id => (Object.hasOwn(PLATFORMS, id) ? PLATFORMS[id] : null);

/** This host's operator prerequisites; a host without a platform module is unsupported, never ready. */
export async function hostPrerequisites({ executable }) {
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

/** The smoke's evidence; a refusal is only its stable NATIVE_SMOKE_* code. native-smoke.mjs imports this module. */
const smokeReport = nativeSmoke => async options => {
  try { return await (nativeSmoke ?? (await import('./native-smoke.mjs')).runNativeProviderSmoke)(options); } catch (error) {
    const code = typeof error?.code === 'string' && /^NATIVE_SMOKE_[A-Z_]{1,40}$/.test(error.code) ? error.code : 'NATIVE_SMOKE_UNAVAILABLE';
    return { code, supportEstablished: false, executionReady: false };
  }
};

export async function runCli(argv, { doctor = runDoctor, prerequisites = hostPrerequisites, nativeSmoke, write = text => process.stdout.write(text) } = {}) {
  const parsed = argumentsFor(argv);
  const smoke = parsed?.command === 'native-smoke';
  const result = await reportFor(parsed, doctor, smoke ? smokeReport(nativeSmoke) : prerequisites);
  write(`${JSON.stringify(result)}\n`);
  const ready = smoke ? result.supportEstablished : parsed?.command === 'prerequisites' ? result.ready : result.providerReady;
  return ready === true ? 0 : 2;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCli(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    process.stderr.write('Provider doctor could not emit its report.\n');
    process.exitCode = 2;
  });
}
