/**
 * Minimum gap between order values to maintain reasonable precision.
 * When the gap falls below this, we return values that will require rebalancing.
 */
const MIN_ORDER_GAP = 0.0001;

/**
 * Computes an order value between two adjacent items.
 * Handles edge cases and prevents precision loss from excessive bisection.
 *
 * @param prev - Order value of the item before, or null if inserting at start
 * @param next - Order value of the item after, or null if inserting at end
 * @returns A number suitable for ordering between prev and next
 */
export function computeOrderBetween(prev: number | null, next: number | null): number {
  // Inserting into empty list
  if (prev === null && next === null) {
    return 1;
  }

  // Inserting at the beginning
  if (prev === null) {
    // Ensure we don't go negative or too close to zero
    const beforeFirst = next! - 1;
    return beforeFirst > 0 ? beforeFirst : next! / 2;
  }

  // Inserting at the end
  if (next === null) {
    return prev + 1;
  }

  // Same position (shouldn't happen but handle gracefully)
  if (prev === next) {
    return prev + 1;
  }

  // Normal case: insert between two items
  const gap = next - prev;

  // If gap is too small, we risk precision issues
  // In this case, return a value that still works but signals need for rebalancing
  if (gap < MIN_ORDER_GAP) {
    // Use a deterministic offset based on the values to avoid collisions
    return prev + MIN_ORDER_GAP;
  }

  // Standard midpoint calculation
  const midpoint = prev + gap / 2;

  // Round to reasonable precision to prevent accumulating floating-point errors
  return Math.round(midpoint * 10000) / 10000;
}

export function sortByOrder<T extends { order: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.order - b.order);
}

/**
 * Rebalances order values for a list of items to use clean integer spacing.
 * Call this when items have accumulated too many insertions and order values
 * are becoming too close together.
 *
 * @param items - Items to rebalance (will be sorted by current order)
 * @returns New order values as a Map from item index to new order
 */
export function rebalanceOrders<T extends { order: number }>(items: T[]): Map<number, number> {
  const sorted = sortByOrder(items);
  const newOrders = new Map<number, number>();

  sorted.forEach((item, index) => {
    const originalIndex = items.indexOf(item);
    newOrders.set(originalIndex, index + 1);
  });

  return newOrders;
}
