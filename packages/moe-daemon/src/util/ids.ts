import crypto from 'crypto';

export function generateId(prefix: string): string {
  // Use the FULL randomUUID (128 bits of entropy) rather than just its first
  // 8 hex chars (32 bits) — truncating to 32 bits makes birthday collisions
  // likely at thousands of entities, which would silently overwrite files.
  // Dashes are stripped to keep the historical single-token `prefix-<id>` shape.
  const uuid = crypto.randomUUID().replace(/-/g, '');
  return `${prefix}-${uuid}`;
}
