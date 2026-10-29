export type {
  PlatformAdapter,
  PlatformId,
  PublishPostParams,
  PublishPostResult,
  UploadMediaParams,
  UploadMediaResult,
} from './types';
export { PLATFORM_IDS, isPlatformId, normalizePlatformIds } from './types';

export { createShopifyAdapter } from './shopifyAdapter';
export { createWixAdapter } from './wixAdapter';
export {
  createDefaultPlatformRegistry,
  getPlatformAdapter,
} from './registry';
export type { PlatformAdapterRegistry } from './registry';
