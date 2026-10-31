#!/usr/bin/env node
// Read-only provider and host prerequisites. Provisioning and execution readiness are separate gates. The exceptions are the
// operator-invoked native runs that launch and delete one owned VM: `native-smoke` (provider support) and `certify` (CQ-R13d).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runDoctor } from './doctor.mjs';
import { linuxPlatform } from './platform-linux.mjs';
import { macosPlatform } from './platform-macos.mjs';
import { windowsPlatform } from './platform-windows.mjs';

const PLATFORMS = Object.freeze({ win32: windowsPlatform, linux: linuxPlatform, darwin: macosPlatform });
const FLAGS = Object.freeze({
  doctor: { '--executable': 'executable' },
  prerequisites: { '--executable': 'executable', '--cache-dir': 'cacheDir' },
  'native-smoke': { '--work-dir': 'workDir' },
  certify: { '--work-dir': 'workDir' },
});
const READY = Object.freeze({ doctor: 'providerReady', prerequisites: 'ready', 'native-smoke': 'supportEstablished', certify: 'certified' });
const ABSOLUTE = new Set(['cacheDir', 'workDir']);
const USAGE = 'Usage: cli.mjs doctor [--executable <path>] | prerequisites [--executable <path>] [--cache-dir <absolute path>] | native-smoke --work-dir <absolute path> | certify --work-dir <absolute path>';

function argumentsFor(argv) {
  if (!Array.isArray(argv) || typeof argv[0] !== 'string' || !Object.hasOwn(FLAGS, argv[0]) || argv.length % 2 === 0) return null;
  const table = FLAGS[argv[0]];
  const options = {};
  for (let at = 1; at < argv.length; at += 2) {
    const [flag, value] = [argv[at], argv[at + 1]];
    const option = typeof flag === 'string' && Object.hasOwn(table, flag) ? table[flag] : null;
    if (option === null || Object.hasOwn(options, option) || typeof value !== 'string' || value.trim() === '' || /[\x00-\x1f\x7f]/.test(value) ||
        (ABSOLUTE.has(option) && !path.isAbsolute(value))) return null;
    options[option] = value;
  }
  return Object.hasOwn(FLAGS[argv[0]], '--work-dir') && !Object.hasOwn(options, 'workDir') ? null : { command: argv[0], options };
}

/** The platform module for a process.platform id, or null. */
export const platformFor = id => (Object.hasOwn(PLATFORMS, id) ? PLATFORMS[id] : null);

/**
 * This host's operator prerequisites; a host without a platform module is unsupported, never ready.
 * `platform` is a test seam: the default is this host's module, chosen per call.
 */
export async function hostPrerequisites({ executable, cacheDir } = {}, { platform = platformFor(process.platform) } = {}) {
  if (!platform) return { code: 'PLATFORM_UNSUPPORTED', ready: false, executionReady: false };
  const report = await platform.prerequisites({ provider: { executable }, cacheDir });
  return {
    platform: report.platform, ready: report.ready === true, executionReady: false,
    providerCode: report.providerCode, prerequisites: report.prerequisites,
  };
}

async function reportFor(parsed, doctor, prerequisites) {
  if (parsed === null) return { code: 'CLI_INPUT_INVALID', providerReady: false, executionReady: false, message: USAGE };
  // This host's pinned client unless --executable names one: never a bare `multipass`.
  if (parsed.command === 'doctor') return doctor({ executable: platformFor(process.platform)?.executable, ...parsed.options });
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

/** The certification report; a refusal is only its stable CERTIFY_* code. certify.mjs imports this module. */
const certifyReport = certify => async options => {
  try { return await (certify ?? (await import('./certify.mjs')).runIsolationCertify)(options); } catch (error) {
    const code = typeof error?.code === 'string' && /^CERTIFY_[A-Z_]{1,40}$/.test(error.code) ? error.code : 'CERTIFY_UNAVAILABLE';
    return { code, certified: false, executionReady: false };
  }
};

export async function runCli(argv, { doctor = runDoctor, prerequisites = hostPrerequisites, nativeSmoke, certify, write = text => process.stdout.write(text) } = {}) {
  const parsed = argumentsFor(argv);
  const native = { 'native-smoke': smokeReport(nativeSmoke), certify: certifyReport(certify) };
  const result = await reportFor(parsed, doctor, parsed !== null && Object.hasOwn(native, parsed.command) ? native[parsed.command] : prerequisites);
  write(`${JSON.stringify(result)}\n`);
  return parsed !== null && result[READY[parsed.command]] === true ? 0 : 2;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCli(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    process.stderr.write('Provider doctor could not emit its report.\n');
    process.exitCode = 2;
  });
}
