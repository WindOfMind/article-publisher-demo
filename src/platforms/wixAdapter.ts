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

/** Mock Wix Blog adaptor. */
export function createWixAdapter(): PlatformAdapter {
  const platformId = 'wix' as const;

  return {
    platformId,

    async uploadMedia({
      articleId,
      tenantId,
      imageData,
    }: UploadMediaParams): Promise<UploadMediaResult> {
      const result: UploadMediaResult = {
        cmsMediaId: `wix-media-${tenantId}-${articleId}-${byteLength(imageData)}`,
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

    async publishPost({
      articleId,
      tenantId,
      topic,
      cmsMediaId,
    }: PublishPostParams): Promise<PublishPostResult> {
      const slug = slugify(topic);
      const result: PublishPostResult = {
        liveUrl: `https://${tenantId}.wixsite.com/blog/${slug}-${articleId}?media=${cmsMediaId}`,
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
