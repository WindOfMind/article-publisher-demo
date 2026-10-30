export const PLATFORM_IDS = ['shopify', 'wix'] as const;

export type PlatformId = (typeof PLATFORM_IDS)[number];

export function isPlatformId(value: unknown): value is PlatformId {
  return (
    typeof value === 'string' &&
    (PLATFORM_IDS as readonly string[]).includes(value)
  );
}

/** Dedupes while preserving first-seen order. Returns null if empty/invalid. */
export function normalizePlatformIds(value: unknown): PlatformId[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const seen = new Set<PlatformId>();
  const platforms: PlatformId[] = [];
  for (const item of value) {
    if (!isPlatformId(item)) {
      return null;
    }
    if (!seen.has(item)) {
      seen.add(item);
      platforms.push(item);
    }
  }
  return platforms;
}

export interface UploadMediaParams {
  articleId: string;
  tenantId: string;
  imageData: Buffer | string;
}

export interface UploadMediaResult {
  cmsMediaId: string;
}

export interface FindMediaParams {
  articleId: string;
  tenantId: string;
}

export interface PublishPostParams {
  articleId: string;
  tenantId: string;
  topic: string;
  markdown: string;
  cmsMediaId: string;
}

export interface PublishPostResult {
  liveUrl: string;
}

export interface FindPostParams {
  articleId: string;
  tenantId: string;
}

/**
 * Per-platform adaptor: upload media and publish a post.
 * Demo adapters are mocks; real ones would call Shopify/Wix APIs.
 * findMedia / findPost support retry-only idempotency in activities.
 */
export interface PlatformAdapter {
  readonly platformId: PlatformId;
  uploadMedia(params: UploadMediaParams): Promise<UploadMediaResult>;
  findMedia(params: FindMediaParams): Promise<UploadMediaResult | null>;
  publishPost(params: PublishPostParams): Promise<PublishPostResult>;
  findPost(params: FindPostParams): Promise<PublishPostResult | null>;
}
