// =============================================================================
// MoeError - Standardized error class for consistent error handling
// =============================================================================

/**
 * Error codes for categorizing errors.
 * Using negative numbers to align with JSON-RPC error code conventions.
 */
export enum MoeErrorCode {
  // Validation errors (user input issues)
  INVALID_INPUT = -32602,
  MISSING_REQUIRED = -32602,
  INVALID_ID = -32602,

  // Not found errors
  NOT_FOUND = -32001,
  TASK_NOT_FOUND = -32001,
  EPIC_NOT_FOUND = -32001,
  WORKER_NOT_FOUND = -32001,
  STEP_NOT_FOUND = -32001,

  // State errors
  INVALID_STATE = -32002,
  ALREADY_EXISTS = -32002,
  STATE_CONFLICT = -32002,

  // Permission/constraint errors
  NOT_ALLOWED = -32003,
  CONSTRAINT_VIOLATION = -32003,

  // Internal errors
  INTERNAL_ERROR = -32000,
  TIMEOUT = -32000,
}

/**
 * Standardized error class for Moe operations.
 * Provides consistent error message format across all tools.
 */
export class MoeError extends Error {
  readonly code: MoeErrorCode;
  readonly context?: Record<string, unknown>;

  constructor(
    code: MoeErrorCode,
    message: string,
    context?: Record<string, unknown>
  ) {
    // Format: [CATEGORY] message
    const formattedMessage = `[${MoeErrorCode[code]}] ${message}`;
    super(formattedMessage);
    this.name = 'MoeError';
    this.code = code;
    this.context = context;

    // Maintains proper stack trace for where our error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MoeError);
    }
  }

  /**
   * Get error details suitable for logging (includes context).
   */
  toLogObject(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      codeName: MoeErrorCode[this.code],
      message: this.message,
      context: this.context,
    };
  }

  /**
   * Get error details suitable for client response (excludes sensitive data).
   */
  toClientObject(): { code: number; message: string } {
    return {
      code: this.code,
      message: this.message,
    };
  }
}

// Convenience factory functions for common errors

export function notFound(entity: string, id: string): MoeError {
  return new MoeError(
    MoeErrorCode.NOT_FOUND,
    `${entity} not found: ${id}`,
    { entity, id }
  );
}

export function invalidInput(field: string, reason: string): MoeError {
  return new MoeError(
    MoeErrorCode.INVALID_INPUT,
    `Invalid ${field}: ${reason}`,
    { field, reason }
  );
}

export function missingRequired(field: string): MoeError {
  return new MoeError(
    MoeErrorCode.MISSING_REQUIRED,
    `Missing required field: ${field}`,
    { field }
  );
}

export function invalidState(entity: string, currentState: string, expectedState: string): MoeError {
  return new MoeError(
    MoeErrorCode.INVALID_STATE,
    `${entity} is in ${currentState} state, expected ${expectedState}`,
    { entity, currentState, expectedState }
  );
}

export function notAllowed(operation: string, reason: string): MoeError {
  return new MoeError(
    MoeErrorCode.NOT_ALLOWED,
    `${operation} not allowed: ${reason}`,
    { operation, reason }
  );
}

export function alreadyExists(entity: string, id: string): MoeError {
  return new MoeError(
    MoeErrorCode.ALREADY_EXISTS,
    `${entity} already exists: ${id}`,
    { entity, id }
  );
}
