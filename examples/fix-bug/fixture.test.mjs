// Example fixture: small bug fix
// This fixture tests a simple function that needs fixing
export function calculateTotal(items) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  return items.reduce((sum, item) => sum + (item.price || 0), 0);
}

// Bug: calculateTotal returns NaN when an item has price: null
// Expected: should treat null/undefined/missing price as 0

import { describe, it } from 'node:test';
import { strictEqual } from 'node:assert';

describe('calculateTotal', () => {
  it('should return 0 for empty array', () => {
    strictEqual(calculateTotal([]), 0);
  });

  it('should sum up prices', () => {
    strictEqual(calculateTotal([{ price: 10 }, { price: 20 }]), 30);
  });

  it('should handle missing price field', () => {
    strictEqual(calculateTotal([{ name: 'item' }]), 0);
  });

  it('should handle null price', () => {
    // This test currently FAILS because null + number = NaN
    strictEqual(calculateTotal([{ price: null }]), 0);
  });
});