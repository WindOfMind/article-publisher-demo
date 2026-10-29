import type {
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
  return {
    platformId: 'shopify',

    async uploadMedia({
      articleId,
      tenantId,
      imageData,
    }: UploadMediaParams): Promise<UploadMediaResult> {
      return {
        cmsMediaId: `shopify-media-${tenantId}-${articleId}-${byteLength(imageData)}`,
      };
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
      return {
        liveUrl: `https://${tenantId}.myshopify.com/blogs/news/${slug}-${articleId}?media=${cmsMediaId}`,
      };
    },
  };
}
