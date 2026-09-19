import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const disabled = value => /^(1|true|yes|on)$/i.test(String(value).trim());
const fail = (code, detail) => { throw new Error(`${code}: ${detail}`); };

function checkEnv(env, source) {
  for (const [key, value] of Object.entries(env ?? {})) {
    // Windows resolves environment names without regard to case, including
    // settings.env entries when Claude applies them to its process environment.
    const name = process.platform === 'win32' ? key.toUpperCase() : key;
    if ((/^DISABLE_PROMPT_CACHING(?:_[A-Z0-9_]+)?$/.test(name) && disabled(value)) ||
        (name === 'MOE_NO_DYNAMIC_PROMPT_EXCLUDE' && value)) {
      fail('MOE_PROMPT_CACHE_DISABLED', `${key} in ${source}; remove the disabling control or explicitly use MOE_PROMPT_CACHE_MODE=inherit.`);
    }
  }
}

function checkSettings(text, source) {
  let settings;
  try { settings = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { fail('MOE_PROMPT_CACHE_SETTINGS_INVALID', `Cannot parse ${source}.`); }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    fail('MOE_PROMPT_CACHE_SETTINGS_INVALID', `Expected an object in ${source}.`);
  }
  checkEnv(settings.env, source);
}

function checkFile(file, required = false) {
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT' && !required) return;
    fail('MOE_PROMPT_CACHE_SETTINGS_INVALID', `Cannot read settings file ${file}.`);
  }
  checkSettings(text, file);
}

function managedSettings(env) {
  const base = process.platform === 'win32' ? path.join(env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode')
    : process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : '/etc/claude-code';
  const files = [path.join(base, 'managed-settings.json')];
  const dir = path.join(base, 'managed-settings.d');
  try { files.push(...readdirSync(dir).filter(name => name.endsWith('.json')).sort().map(name => path.join(dir, name))); }
  catch (error) { if (error.code !== 'ENOENT') fail('MOE_PROMPT_CACHE_SETTINGS_INVALID', `Cannot read ${dir}.`); }
  return files;
}

// Conservative preflight of locally observable controls, not a claim that a
// gateway or remote managed policy actually preserves provider cache markers.
export function checkPolicy({ provider, project, cwd = process.cwd(), home = homedir(), env = process.env, args = [], managedPaths } = {}) {
  const mode = env.MOE_PROMPT_CACHE_MODE || 'strict';
  if (!['strict', 'inherit'].includes(mode)) fail('MOE_PROMPT_CACHE_POLICY_INVALID', 'Use strict or inherit.');
  if (mode === 'inherit' || provider !== 'claude') return mode;
  checkEnv(env, 'environment');
  const config = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const files = new Set([path.join(config, 'settings.json'), ...(managedPaths ?? managedSettings(env))]);
  for (const root of [project, cwd]) {
    files.add(path.join(root, '.claude/settings.json'));
    files.add(path.join(root, '.claude/settings.local.json'));
  }
  for (const file of files) checkFile(file);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg !== '--settings' && !arg.startsWith('--settings=')) continue;
    const value = arg === '--settings' ? args[++i] : arg.slice('--settings='.length);
    if (!value) fail('MOE_PROMPT_CACHE_SETTINGS_INVALID', 'Missing --settings value.');
    if (value.trimStart().startsWith('{')) checkSettings(value, '--settings');
    else checkFile(path.resolve(cwd, value), true);
  }
  return mode;
}
