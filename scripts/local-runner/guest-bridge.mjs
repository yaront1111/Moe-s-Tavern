// Host-side wire protocol of the CQ-R08 host-guest bridge: pure functions only, with no provider call, no
// spawn and no daemon forwarding; verified-local stays unavailable. The CQ-R08b/c guest supervisor and the
// CQ-R08 host session implement and consume this module as the protocol source of truth.
// Frame: a 4-byte unsigned big-endian length L, then exactly L bytes of UTF-8 JSON encoding one plain object.
// Guest frames allow 1 <= L <= MAX_GUEST_FRAME_BYTES, host frames 1 <= L <= MAX_HOST_FRAME_BYTES.
import { GUEST_LAYOUT } from './guest-bootstrap.mjs';
import { isOwnedInstanceName } from './lifecycle.mjs';

export const MAX_GUEST_FRAME_BYTES = 262_144;
// The daemon's WebSocket maxPayload is 2 MiB (packages/moe-daemon/src/server/WebSocketServer.ts).
export const MAX_HOST_FRAME_BYTES = 4_194_304;
const HEADER_BYTES = 4;
// fatal refuses invalid UTF-8 (overlong forms included); ignoreBOM keeps a leading BOM so JSON.parse refuses it.
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
// Fixed text only: a message never includes frame, tool or argument content.
const MESSAGES = {
  BRIDGE_INPUT_INVALID: 'Bridge input was invalid.',
  BRIDGE_FRAME_INVALID: 'Bridge frame was malformed or outside its size limit.',
  BRIDGE_PROTOCOL_VIOLATION: 'Bridge frame violated the guest protocol.',
  BRIDGE_TOOL_DENIED: 'The guest requested a tool its role may not call.',
  BRIDGE_ARGUMENT_DENIED: 'The guest sent an argument its tool does not allow.',
  BRIDGE_IDENTITY_MISMATCH: 'The guest request did not match the host-bound identity.',
};
const isRecord = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
// The own enumerable key set: a non-enumerable required key cannot stand in for an enumerable extra.
const exactKeys = (value, keys) => { const own = Object.keys(value); return own.length === keys.length && own.every(key => keys.includes(key)); };
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);

export function bridgeError(code) {
  const known = typeof code === 'string' && Object.hasOwn(MESSAGES, code) ? code : 'BRIDGE_INPUT_INVALID';
  return Object.assign(new Error(MESSAGES[known]), { code: known });
}

function frameLimit(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_HOST_FRAME_BYTES) throw bridgeError('BRIDGE_INPUT_INVALID');
}

export function encodeFrame(value, maxBytes = MAX_HOST_FRAME_BYTES) {
  frameLimit(maxBytes);
  let body;
  try { body = isRecord(value) ? Buffer.from(JSON.stringify(value), 'utf8') : undefined; } catch { body = undefined; }
  // A leading '{' proves the top-level JSON is an object even when a toJSON hook is present.
  if (!body || body[0] !== 0x7b || body.length > maxBytes) throw bridgeError('BRIDGE_FRAME_INVALID');
  const head = Buffer.alloc(HEADER_BYTES);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

function parseBody(body) {
  let value;
  try { value = JSON.parse(UTF8.decode(body)); } catch { throw bridgeError('BRIDGE_FRAME_INVALID'); }
  if (!isRecord(value)) throw bridgeError('BRIDGE_FRAME_INVALID');
  return value;
}

// Streaming guest-frame decoder: O(n) copies into one header or one preallocated bounded body. A bad length
// header is refused before any body byte is buffered, and the first error poisons it (fail closed).
export function createFrameDecoder(maxBytes = MAX_GUEST_FRAME_BYTES) {
  frameLimit(maxBytes);
  let pending = Buffer.alloc(HEADER_BYTES);
  let fill = 0;
  let inBody = false;
  let poisoned = false;
  const guarded = fn => (...args) => {
    if (poisoned) throw bridgeError('BRIDGE_FRAME_INVALID');
    try { return fn(...args); } catch (error) { poisoned = true; throw error; }
  };
  const push = chunk => {
    if (!(chunk instanceof Uint8Array)) throw bridgeError('BRIDGE_INPUT_INVALID');
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const frames = [];
    for (let at = 0; at < bytes.length;) {
      const copied = bytes.copy(pending, fill, at, at + pending.length - fill);
      fill += copied;
      at += copied;
      if (fill < pending.length) break;
      fill = 0;
      if (inBody) {
        frames.push(parseBody(pending));
        pending = Buffer.alloc(HEADER_BYTES);
      } else {
        const length = pending.readUInt32BE(0);
        if (length === 0 || length > maxBytes) throw bridgeError('BRIDGE_FRAME_INVALID');
        pending = Buffer.alloc(length);
      }
      inBody = !inBody;
    }
    return frames;
  };
  const end = () => { if (fill > 0 || inBody) throw bridgeError('BRIDGE_FRAME_INVALID'); };
  return Object.freeze({ push: guarded(push), end: guarded(end) });
}

const MAX_REQUEST_ID = 2_147_483_647;
// Node's base64 decoder is lenient; only the round trip rejects stray characters, missing padding and pad bits.
const isCanonicalBase64 = data => typeof data === 'string' && data.length > 0
  && Buffer.from(data, 'base64').toString('base64') === data;
const GUEST_SHAPES = Object.freeze({
  hello: { keys: ['kind', 'protocol'], valid: frame => frame.protocol === 1 },
  // The tool check is shape only; scopeRequest owns the per-role allowlist.
  request: { keys: ['kind', 'id', 'tool', 'args'], valid: frame => Number.isSafeInteger(frame.id) && frame.id >= 1
    && frame.id <= MAX_REQUEST_ID && matches(frame.tool, /^moe\.[a-z][a-z_]{0,63}$/) && isRecord(frame.args) },
  output: { keys: ['kind', 'stream', 'data'],
    valid: frame => (frame.stream === 'stdout' || frame.stream === 'stderr') && isCanonicalBase64(frame.data) },
  observation: { keys: ['kind', 'type', 'code', 'signal'], valid: frame => frame.type === 'exit'
    && (frame.code === null) !== (frame.signal === null)
    && (frame.code === null || (Number.isInteger(frame.code) && frame.code >= 0 && frame.code <= 255))
    && (frame.signal === null || matches(frame.signal, /^SIG[A-Z0-9]{1,15}$/)) },
});

// Validates one decoded guest frame against the exact guest kinds ('response' is host-only). Output data is
// returned as untouched bytes, never JSON-parsed or decoded as frames: child stdout cannot impersonate the supervisor.
export function parseGuestFrame(frame) {
  const shape = isRecord(frame) && typeof frame.kind === 'string' && Object.hasOwn(GUEST_SHAPES, frame.kind)
    ? GUEST_SHAPES[frame.kind] : null;
  if (!shape || !exactKeys(frame, shape.keys) || !shape.valid(frame)) throw bridgeError('BRIDGE_PROTOCOL_VIOLATION');
  if (frame.kind !== 'output') return Object.freeze({ ...frame });
  return Object.freeze({ kind: 'output', stream: frame.stream, data: Buffer.from(frame.data, 'base64') });
}

const entry = (args, taskId = true, workerId = true) => Object.freeze({ args: Object.freeze(args), taskId, workerId });
const SHARED_TOOLS = {
  'moe.get_context': entry(['view', 'commentsLimit', 'commentsMaxChars']),
  'moe.add_comment': entry(['content']),
  'moe.get_handoff_history': entry([], true, false), // its daemon schema has no workerId
  'moe.heartbeat': entry(['presenceKind'], false, true), // its daemon schema has no taskId
};
// role -> tool -> the exact guest argument keys and whether the binding's taskId/workerId are stamped, from each
// tool's inputSchema in packages/moe-daemon/src/tools/<name>.ts (all additionalProperties:false).
export const TOOLS = Object.freeze({
  worker: Object.freeze({
    ...SHARED_TOOLS,
    'moe.start_step': entry(['stepId']),
    'moe.complete_step': entry(['stepId', 'modifiedFiles', 'note']),
    // prLink and currentBranch are absent: caller-asserted delivery evidence the epic rail forbids minting.
    'moe.complete_task': entry(['verification', 'summary']),
    // resourceId is absent: host resource leases are not reachable from the guest.
    'moe.report_blocked': entry(['reason', 'needsFrom', 'currentStepId', 'blockedOnTaskIds']),
  }),
  qa: Object.freeze({
    ...SHARED_TOOLS,
    // manualArtifact and mergedPullRequest are absent: caller-asserted delivery evidence the epic rail forbids minting.
    'moe.qa_approve': entry(['summary', 'candidateId']),
    'moe.qa_reject': entry(['reason', 'failedDodItems', 'issues', 'candidateId']),
  }),
});
const BINDING_KEYS = ['role', 'workerId', 'taskId', 'attemptId', 'generation'];
const STAMPED_KEYS = ['taskId', 'workerId'];
const FORBIDDEN_IDENTITY_KEYS = ['role', 'attemptId', 'generation', 'processStartedAt', 'host'];
// taskId, attemptId and generation copy validOwner's shapes in lifecycle.mjs; keep the two in step.
const validBinding = binding => isRecord(binding) && exactKeys(binding, BINDING_KEYS)
  && (binding.role === 'worker' || binding.role === 'qa') && matches(binding.workerId, /^\P{Cc}{1,128}$/u)
  && matches(binding.taskId, /^task-[A-Za-z0-9]{1,64}$/) && matches(binding.attemptId, /^attempt-[A-Za-z0-9]{1,64}$/)
  && Number.isSafeInteger(binding.generation) && binding.generation > 0;

// Binds one guest request to the host-owned identity from the host's claim and R06 ledger record, never a frame.
// Order: tool allowlist, identity keys, argument allowlist. The daemon still validates every forwarded value.
export function scopeRequest(request, binding) {
  if (!validBinding(binding)) throw bridgeError('BRIDGE_INPUT_INVALID');
  if (request?.kind !== 'request') throw bridgeError('BRIDGE_PROTOCOL_VIOLATION');
  const { id, tool, args } = parseGuestFrame(request);
  const tools = TOOLS[binding.role];
  if (!Object.hasOwn(tools, tool)) throw bridgeError('BRIDGE_TOOL_DENIED');
  if (FORBIDDEN_IDENTITY_KEYS.some(key => Object.hasOwn(args, key))
    || STAMPED_KEYS.some(key => Object.hasOwn(args, key) && args[key] !== binding[key])) {
    throw bridgeError('BRIDGE_IDENTITY_MISMATCH');
  }
  const allowed = tools[tool];
  const forwarded = {};
  for (const key of Object.keys(args)) {
    if (STAMPED_KEYS.includes(key)) continue;
    if (!allowed.args.includes(key)) throw bridgeError('BRIDGE_ARGUMENT_DENIED');
    forwarded[key] = args[key];
  }
  for (const key of STAMPED_KEYS) if (allowed[key]) forwarded[key] = binding[key];
  return Object.freeze({ id, tool, args: Object.freeze(forwarded) });
}

// cli -> the credential names its job may get. It mirrors guest-supervisor.py JOBS, the guest's own table (B17 pins it).
export const AGENT_JOBS = Object.freeze({
  claude: Object.freeze(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']),
  codex: Object.freeze(['OPENAI_API_KEY', 'CODEX_API_KEY']),
});

// The CQ-R10b job frame, the first bytes the host writes on the bridge's stdin; the guest's read_job checks the same shape.
// It is built from the named fields only, each read once. Any refusal, a throwing getter or proxy trap included, is
// BRIDGE_INPUT_INVALID, whose fixed text never carries the credential.
export function jobFrame(job) {
  try {
    const { cli, role, credential } = isRecord(job) && exactKeys(job, ['cli', 'role', 'credential']) ? job : {};
    const { name, value } = isRecord(credential) && exactKeys(credential, ['name', 'value']) ? credential : {};
    if (typeof cli === 'string' && Object.hasOwn(AGENT_JOBS, cli) && (role === 'worker' || role === 'qa')
      && AGENT_JOBS[cli].includes(name) && matches(value, /^[\x21-\x7e]{1,4096}$/)) {
      return encodeFrame({ kind: 'job', version: 1, cli, role, credential: { name, value } });
    }
  } catch { /* refused below */ }
  throw bridgeError('BRIDGE_INPUT_INVALID');
}

// The one Multipass argv that opens the bridge. Every element except the validated owned name is a constant, so
// no caller data reaches the guest command. --no-map-working-directory stops Multipass mapping the host cwd
// (see the exec.cpp note in guest-readiness.mjs).
export function bridgeArgv(name) {
  if (!isOwnedInstanceName(name)) throw bridgeError('BRIDGE_INPUT_INVALID');
  return Object.freeze(['exec', '--no-map-working-directory', name, '--', 'sudo', '-n', GUEST_LAYOUT.supervisor, 'bridge']);
}

// The one Multipass argv that runs a CQ-R11 check: bridgeArgv's, in the supervisor's check mode.
export const checkArgv = name => Object.freeze([...bridgeArgv(name).slice(0, -1), 'check']);

// The CQ-R11a check frame, the first and only bytes the host writes on a check session's stdin. Its rules are the
// supervisor's read_check, which mirrors the daemon's validateRequiredChecks; C2 pins the two sides together. It is
// built from copies, each field read once, so a later caller edit cannot change the bytes. Any refusal, a throwing
// getter or proxy trap included, is BRIDGE_INPUT_INVALID with its fixed text.
const CHECK_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const checkText = (value, max) => typeof value === 'string' && value.isWellFormed() && value.length <= max && !CHECK_CONTROL.test(value);
const protectedPath = path => checkText(path, 500) && path.trim() === path && !/[\\\ufffd]/.test(path)
  && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
const protectedEntry = entry => {
  const { path, oid } = isRecord(entry) && exactKeys(entry, ['path', 'oid']) ? entry : {};
  return { path, oid };
};

export function checkFrame(check) {
  try {
    const { id, command, protected: list } = isRecord(check) && exactKeys(check, ['id', 'command', 'protected']) ? check : {};
    const count = Array.isArray(list) ? list.length : -1;
    const entries = count >= 0 && count <= 2000 ? Array.from({ length: count }, (_, index) => protectedEntry(list[index])) : null;
    if (matches(id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/) && checkText(command, 1000) && command.trim() !== '' && entries
      && entries.every(({ path, oid }, index) => matches(oid, /^[0-9a-f]{40}$/) && protectedPath(path)
        && (index === 0 || Buffer.compare(Buffer.from(entries[index - 1].path), Buffer.from(path)) < 0))) {
      return encodeFrame({ kind: 'check', version: 1, id, command, protected: entries });
    }
  } catch { /* refused below */ }
  throw bridgeError('BRIDGE_INPUT_INVALID');
}
