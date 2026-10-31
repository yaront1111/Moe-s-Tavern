import { invalidInput, MoeError, MoeErrorCode } from '../util/errors.js';

/** Wire support only, never trusted evidence or readiness certification.
 * attemptPhase is not managed runnerStatus; verified-local stays unavailable. */
const SERVER_CAPABILITIES = Object.freeze({
  executionProfiles: true, planRevisions: true, approvalRevisions: true,
  executionContracts: true, deliveryReceipts: true, requiredChecks: true,
  runnerStatus: false, modelReceipts: false, verifiedLocal: false,
});

export type ClientCapabilities = Record<keyof typeof SERVER_CAPABILITIES, boolean>;
export interface CapabilityAgreement {
  protocolVersion: 1;
  capabilities: Readonly<ClientCapabilities>;
  negotiatedCapabilities: ClientCapabilities;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Decode only fixed known keys; unknown optional input is never retained. */
export function decodeClientHello(payload: unknown): CapabilityAgreement {
  if (!isRecord(payload)) throw invalidInput('payload', 'must be an object');
  const { protocolVersion, capabilities } = payload;
  if (typeof protocolVersion !== 'number' || !Number.isSafeInteger(protocolVersion)) {
    throw invalidInput('protocolVersion', 'must be a safe integer');
  }
  if (!isRecord(capabilities)) throw invalidInput('capabilities', 'must be an object');
  const negotiated: ClientCapabilities = { ...SERVER_CAPABILITIES };
  for (const key of Object.keys(SERVER_CAPABILITIES) as (keyof ClientCapabilities)[]) {
    const present = Object.hasOwn(capabilities, key);
    if (present && typeof capabilities[key] !== 'boolean') {
      throw invalidInput(`capabilities.${key}`, 'must be a boolean');
    }
    negotiated[key] = SERVER_CAPABILITIES[key] && present && capabilities[key] === true;
  }
  if (protocolVersion !== 1) {
    throw new MoeError(MoeErrorCode.NOT_ALLOWED, 'Only client protocol version 1 is supported',
      undefined, 'UNSUPPORTED_CLIENT_PROTOCOL');
  }
  return { protocolVersion: 1, capabilities: SERVER_CAPABILITIES, negotiatedCapabilities: negotiated };
}
