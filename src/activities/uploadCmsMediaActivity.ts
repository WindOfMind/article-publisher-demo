import {
  createDefaultPlatformRegistry,
  getPlatformAdapter,
  type PlatformAdapterRegistry,
  type PlatformId,
} from '../platforms';
import { mockS3 } from '../services/mockS3';
import { metrics } from './metrics';

export interface UploadCmsMediaInput {
  articleId: string;
  tenantId: string;
  platform: PlatformId;
  imageS3Uri: string;
}

export interface UploadCmsMediaResult {
  cmsMediaId: string;
}

/**
 * Fetches the image from Mock S3 (claim-check) and uploads it via the
 * platform adaptor for the article's target platform. Returns only the media id.
 */
export function createUploadCmsMediaActivity(
  registry: PlatformAdapterRegistry = createDefaultPlatformRegistry(),
) {
  return async function uploadCmsMediaActivity(
    input: UploadCmsMediaInput,
  ): Promise<UploadCmsMediaResult> {
    metrics.cmsUploads += 1;

    const imageData = await mockS3.get(input.imageS3Uri);
    const adapter = getPlatformAdapter(input.platform, registry);
    return adapter.uploadMedia({
      articleId: input.articleId,
      tenantId: input.tenantId,
      imageData,
    });
  };
}

export const uploadCmsMediaActivity = createUploadCmsMediaActivity();
