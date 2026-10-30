import { mockCms } from '../infra/mockCms';
import type {
  FindMediaParams,
  FindPostParams,
  PlatformAdapter,
  PublishPostParams,
  PublishPostResult,
  UploadMediaParams,
  UploadMediaResult,
} from './types';

function slugify(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function byteLength(imageData: Buffer | string): number {
  return typeof imageData === 'string'
    ? Buffer.byteLength(imageData)
    : imageData.byteLength;
}

/** Mock Shopify Online Store / Blog adaptor. */
export function createShopifyAdapter(): PlatformAdapter {
  const platformId = 'shopify' as const;

  return {
    platformId,

    async uploadMedia({
      articleId,
      tenantId,
      imageData,
    }: UploadMediaParams): Promise<UploadMediaResult> {
      const result: UploadMediaResult = {
        cmsMediaId: `shopify-media-${tenantId}-${articleId}-${byteLength(imageData)}`,
      };
      mockCms.putMedia({ platformId, tenantId, articleId }, result);
      return result;
    },

    async findMedia({
      articleId,
      tenantId,
    }: FindMediaParams): Promise<UploadMediaResult | null> {
      return mockCms.findMedia({ platformId, tenantId, articleId });
    },

    /**
     * In a real implementation, pass an idempotency key whenever the CMS API
     * supports it (e.g. Shopify's Idempotency-Key header) so activity retries
     * return the original post instead of creating a duplicate.
     */
    async publishPost({
      articleId,
      tenantId,
      topic,
      cmsMediaId,
    }: PublishPostParams): Promise<PublishPostResult> {
      const slug = slugify(topic);
      const result: PublishPostResult = {
        liveUrl: `https://${tenantId}.myshopify.com/blogs/news/${slug}-${articleId}?media=${cmsMediaId}`,
      };
      mockCms.putPost({ platformId, tenantId, articleId }, result);
      return result;
    },

    async findPost({
      articleId,
      tenantId,
    }: FindPostParams): Promise<PublishPostResult | null> {
      return mockCms.findPost({ platformId, tenantId, articleId });
    },
  };
}
