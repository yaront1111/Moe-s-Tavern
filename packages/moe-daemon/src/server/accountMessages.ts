// =============================================================================
// Plugin edits of the machine's Claude account list (the IDE's Accounts tab)
// =============================================================================
//
// The list is machine-level (accounts/registry.ts), so an edit made through
// one project's daemon reaches every daemon on the machine through its account
// watch. Signing in and out is not here: the daemon never runs claude, so the
// IDE runs the `accounts` CLI in a terminal for that.

import type { StateManager } from '../state/StateManager.js';
import {
  addAccount,
  moveAccount,
  registryFilePath,
  removeAccount,
  renameAccount,
  setSwitchAtPercent,
} from '../accounts/registry.js';
import { invalidateAccountRegistry, refreshAccounts } from '../state/accountStore.js';
import { invalidInput } from '../util/errors.js';

export type AccountMessageType =
  | 'ADD_ACCOUNT'
  | 'REMOVE_ACCOUNT'
  | 'MOVE_ACCOUNT'
  | 'RENAME_ACCOUNT'
  | 'SET_ACCOUNT_SWITCH_PERCENT';

export interface AccountAddedReply {
  type: 'ACCOUNT_ADDED';
  payload: { accountId: string };
}

/** Apply one edit and broadcast the new list. Returns the sender's reply (ADD_ACCOUNT only). Throws on bad input. */
export function applyAccountMessage(state: StateManager, type: AccountMessageType, payload: unknown): AccountAddedReply | null {
  const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const file = registryFilePath();
  const accountId = (): string => {
    if (typeof body.accountId !== 'string' || !body.accountId) throw invalidInput('accountId', 'is required');
    return body.accountId;
  };
  let reply: AccountAddedReply | null = null;
  switch (type) {
    case 'ADD_ACCOUNT':
      reply = { type: 'ACCOUNT_ADDED', payload: { accountId: addAccount(file, body.label).id } };
      break;
    case 'REMOVE_ACCOUNT':
      removeAccount(file, accountId());
      break;
    case 'MOVE_ACCOUNT': {
      const offset = body.offset;
      if (offset !== -1 && offset !== 1) throw invalidInput('offset', 'must be -1 (up) or 1 (down)');
      moveAccount(file, accountId(), offset);
      break;
    }
    case 'RENAME_ACCOUNT':
      renameAccount(file, accountId(), body.label);
      break;
    case 'SET_ACCOUNT_SWITCH_PERCENT': {
      const percent = body.switchAtPercent;
      if (typeof percent !== 'number' || !Number.isInteger(percent) || percent < 1 || percent > 100) {
        throw invalidInput('switchAtPercent', 'must be a whole number from 1 to 100');
      }
      setSwitchAtPercent(file, percent);
      break;
    }
  }
  invalidateAccountRegistry(state);
  refreshAccounts(state);
  return reply;
}
