// =============================================================================
// Sanitize - Consistent field sanitization utilities
// =============================================================================

import { logger } from './logger.js';

/**
 * Validates and truncates a string field to max length.
 * Returns default value if input is null, undefined, or not a string.
 */
export function sanitizeString(
  value: unknown,
  fieldName: string,
  maxLength: number,
  defaultVal: string = ''
): string {
  if (value === null || value === undefined || typeof value !== 'string') {
    return defaultVal;
  }
  if (value.length > maxLength) {
    logger.warn({ fieldName, originalLength: value.length, maxLength }, 'Field truncated');
    return value.substring(0, maxLength);
  }
  return value;
}

/**
 * Validates and clamps a numeric value to valid bounds.
 * Returns default value if input is null, undefined, NaN, or not a number.
 */
export function sanitizeNumber(
  value: unknown,
  defaultVal: number,
  min: number,
  max: number
): number {
  if (value === null || value === undefined || typeof value !== 'number' || isNaN(value)) {
    return defaultVal;
  }
  return Math.max(min, Math.min(max, value));
}

/**
 * Sanitizes a pattern string to prevent shell injection.
 * Removes potentially dangerous characters like backticks, $, (), {}, etc.
 */
export function sanitizePattern(
  value: unknown,
  defaultVal: string,
  maxLength: number = 256
): string {
  if (value === null || value === undefined || typeof value !== 'string') {
    return defaultVal;
  }
  if (value.length > maxLength) {
    logger.warn({ pattern: value.substring(0, 50) }, 'Pattern too long, using default');
    return defaultVal;
  }
  // Remove potentially dangerous characters (shell injection prevention)
  const sanitized = value.replace(/[`$(){}[\]|;&<>]/g, '');
  if (sanitized !== value) {
    logger.warn({ original: value, sanitized }, 'Pattern sanitized');
  }
  return sanitized || defaultVal;
}

/**
 * Validates that an entity ID is safe (no path traversal).
 * IDs should only contain alphanumeric characters, hyphens, and underscores.
 * Throws an error if the ID is invalid.
 */
export function validateEntityId(id: unknown): string {
  if (!id || typeof id !== 'string') {
    throw new Error('Entity ID is required');
  }
  // Only allow safe characters: alphanumeric, hyphen, underscore
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid entity ID: ${id}. IDs must contain only alphanumeric characters, hyphens, and underscores.`);
  }
  // Prevent overly long IDs
  if (id.length > 128) {
    throw new Error(`Entity ID too long: ${id.length} chars (max 128)`);
  }
  return id;
}

/**
 * Sanitizes an array of strings, filtering out non-strings and enforcing limits.
 * @param value - The array to sanitize
 * @param maxItems - Maximum number of items allowed
 * @param maxItemLength - Maximum length per item
 * @param defaultVal - Default value if input is invalid
 */
export function sanitizeStringArray(
  value: unknown,
  maxItems: number,
  maxItemLength: number,
  defaultVal: string[] = []
): string[] {
  if (!Array.isArray(value)) {
    return defaultVal;
  }
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .slice(0, maxItems)
    .map((item) => item.substring(0, maxItemLength));
}

/**
 * Sanitizes a boolean value, returning default if not a boolean.
 */
export function sanitizeBoolean(value: unknown, defaultVal: boolean): boolean {
  if (typeof value !== 'boolean') {
    return defaultVal;
  }
  return value;
}

/**
 * Sanitizes an enum value, returning default if not in allowed values.
 */
export function sanitizeEnum<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  defaultVal: T
): T {
  if (typeof value !== 'string' || !allowedValues.includes(value as T)) {
    return defaultVal;
  }
  return value as T;
}

/**
 * Sanitizes a URL string, ensuring it's a valid URL format.
 * Returns null if invalid (for optional URL fields).
 */
export function sanitizeUrl(value: unknown, maxLength: number = 2048): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  if (value.length > maxLength) {
    logger.warn({ urlLength: value.length, maxLength }, 'URL too long');
    return null;
  }
  // Basic URL validation - must start with http:// or https://
  if (!/^https?:\/\/.+/.test(value)) {
    return null;
  }
  return value;
}

/**
 * Sanitizes an ISO date string.
 * Returns current time if invalid.
 */
export function sanitizeIsoDate(value: unknown): string {
  if (typeof value !== 'string') {
    return new Date().toISOString();
  }
  // Try to parse the date
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    return new Date().toISOString();
  }
  return value;
}
