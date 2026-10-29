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

/** Mock Wix Blog adaptor. */
export function createWixAdapter(): PlatformAdapter {
  return {
    platformId: 'wix',

    async uploadMedia({
      articleId,
      tenantId,
      imageData,
    }: UploadMediaParams): Promise<UploadMediaResult> {
      return {
        cmsMediaId: `wix-media-${tenantId}-${articleId}-${byteLength(imageData)}`,
      };
    },

    async publishPost({
      articleId,
      tenantId,
      topic,
      cmsMediaId,
    }: PublishPostParams): Promise<PublishPostResult> {
      const slug = slugify(topic);
      return {
        liveUrl: `https://${tenantId}.wixsite.com/blog/${slug}-${articleId}?media=${cmsMediaId}`,
      };
    },
  };
}
