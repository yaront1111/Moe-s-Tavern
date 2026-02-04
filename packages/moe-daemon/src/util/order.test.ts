import { describe, it, expect } from 'vitest';
import { computeOrderBetween, sortByOrder, rebalanceOrders } from './order.js';

describe('computeOrderBetween', () => {
  it('returns 1 for empty list (null, null)', () => {
    expect(computeOrderBetween(null, null)).toBe(1);
  });

  it('returns value before first item when inserting at beginning', () => {
    expect(computeOrderBetween(null, 5)).toBe(4);
    expect(computeOrderBetween(null, 1)).toBe(0.5); // Can't go negative
    expect(computeOrderBetween(null, 0.5)).toBe(0.25);
  });

  it('returns value after last item when inserting at end', () => {
    expect(computeOrderBetween(5, null)).toBe(6);
    expect(computeOrderBetween(10, null)).toBe(11);
  });

  it('returns midpoint between two items', () => {
    expect(computeOrderBetween(1, 3)).toBe(2);
    expect(computeOrderBetween(1, 2)).toBe(1.5);
    expect(computeOrderBetween(0, 1)).toBe(0.5);
  });

  it('handles same values gracefully', () => {
    expect(computeOrderBetween(5, 5)).toBe(6);
  });

  it('handles very small gaps by using MIN_ORDER_GAP', () => {
    const result = computeOrderBetween(1, 1.00001);
    expect(result).toBeGreaterThan(1);
    expect(result).toBeLessThan(1.001);
  });

  it('rounds to reasonable precision', () => {
    const result = computeOrderBetween(1, 2);
    expect(result).toBe(1.5);

    const result2 = computeOrderBetween(1, 1.1);
    expect(result2).toBe(1.05);
  });
});

describe('sortByOrder', () => {
  it('sorts items by order value ascending', () => {
    const items = [
      { order: 3, name: 'c' },
      { order: 1, name: 'a' },
      { order: 2, name: 'b' },
    ];
    const sorted = sortByOrder(items);
    expect(sorted.map(i => i.name)).toEqual(['a', 'b', 'c']);
  });

  it('returns a new array (does not mutate original)', () => {
    const items = [
      { order: 2, name: 'b' },
      { order: 1, name: 'a' },
    ];
    const sorted = sortByOrder(items);
    expect(sorted).not.toBe(items);
    expect(items[0].name).toBe('b'); // Original unchanged
  });

  it('handles empty array', () => {
    expect(sortByOrder([])).toEqual([]);
  });

  it('handles single item', () => {
    const items = [{ order: 5, name: 'only' }];
    expect(sortByOrder(items)).toEqual([{ order: 5, name: 'only' }]);
  });

  it('handles decimal order values', () => {
    const items = [
      { order: 1.5, name: 'b' },
      { order: 1.2, name: 'a' },
      { order: 1.8, name: 'c' },
    ];
    const sorted = sortByOrder(items);
    expect(sorted.map(i => i.name)).toEqual(['a', 'b', 'c']);
  });
});

describe('rebalanceOrders', () => {
  it('rebalances orders to clean integers starting at 1', () => {
    const items = [
      { order: 0.1, name: 'a' },
      { order: 0.15, name: 'b' },
      { order: 0.2, name: 'c' },
    ];
    const newOrders = rebalanceOrders(items);
    expect(newOrders.get(0)).toBe(1);
    expect(newOrders.get(1)).toBe(2);
    expect(newOrders.get(2)).toBe(3);
  });

  it('preserves relative ordering', () => {
    const items = [
      { order: 100, name: 'c' },
      { order: 1, name: 'a' },
      { order: 50, name: 'b' },
    ];
    const newOrders = rebalanceOrders(items);
    // Index 0 (order 100) should become 3
    // Index 1 (order 1) should become 1
    // Index 2 (order 50) should become 2
    expect(newOrders.get(0)).toBe(3);
    expect(newOrders.get(1)).toBe(1);
    expect(newOrders.get(2)).toBe(2);
  });

  it('handles empty array', () => {
    const newOrders = rebalanceOrders([]);
    expect(newOrders.size).toBe(0);
  });

  it('handles single item', () => {
    const items = [{ order: 99, name: 'only' }];
    const newOrders = rebalanceOrders(items);
    expect(newOrders.get(0)).toBe(1);
  });
});
