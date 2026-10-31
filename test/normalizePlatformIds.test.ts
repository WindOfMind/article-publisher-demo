import {
  isPlatformId,
  normalizePlatformIds,
} from '../src/platforms/types';
import { getPlatformAdapter } from '../src/platforms/registry';

describe('normalizePlatformIds', () => {
  it('returns unique platforms preserving first-seen order', () => {
    expect(normalizePlatformIds(['wix', 'shopify', 'wix'])).toEqual([
      'wix',
      'shopify',
    ]);
  });

  it('returns null for empty, non-array, or invalid values', () => {
    expect(normalizePlatformIds([])).toBeNull();
    expect(normalizePlatformIds(undefined)).toBeNull();
    expect(normalizePlatformIds('shopify')).toBeNull();
    expect(normalizePlatformIds(['shopify', 'wordpress'])).toBeNull();
    expect(normalizePlatformIds([123])).toBeNull();
  });
});

describe('isPlatformId', () => {
  it('accepts only registered platform ids', () => {
    expect(isPlatformId('shopify')).toBe(true);
    expect(isPlatformId('wix')).toBe(true);
    expect(isPlatformId('wordpress')).toBe(false);
    expect(isPlatformId(null)).toBe(false);
  });
});

describe('getPlatformAdapter', () => {
  it('throws for an unknown platform id', () => {
    expect(() =>
      getPlatformAdapter('wordpress' as 'shopify', new Map()),
    ).toThrow('No platform adapter registered for "wordpress"');
  });
});
