import { createShopifyAdapter } from './shopifyAdapter';
import { createWixAdapter } from './wixAdapter';
import type { PlatformAdapter, PlatformId } from './types';

export type PlatformAdapterRegistry = ReadonlyMap<PlatformId, PlatformAdapter>;

export function createDefaultPlatformRegistry(): PlatformAdapterRegistry {
  const adapters: PlatformAdapter[] = [
    createShopifyAdapter(),
    createWixAdapter(),
  ];
  return new Map(adapters.map((a) => [a.platformId, a]));
}

const defaultRegistry = createDefaultPlatformRegistry();

export function getPlatformAdapter(
  platformId: PlatformId,
  registry: PlatformAdapterRegistry = defaultRegistry,
): PlatformAdapter {
  const adapter = registry.get(platformId);
  if (adapter === undefined) {
    throw new Error(`No platform adapter registered for "${platformId}"`);
  }
  return adapter;
}
