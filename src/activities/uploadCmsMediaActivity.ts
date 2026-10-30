import { log } from '@temporalio/activity';
import {
  createDefaultPlatformRegistry,
  getPlatformAdapter,
  type PlatformAdapterRegistry,
  type PlatformId,
} from '../platforms';
import { mockS3 } from '../infra/mockS3';
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
    log.info('Uploading CMS media', {
      articleId: input.articleId,
      tenantId: input.tenantId,
      platform: input.platform,
      imageS3Uri: input.imageS3Uri,
    });

    metrics.cmsUploads += 1;

    const imageData = await mockS3.get(input.imageS3Uri);
    const adapter = getPlatformAdapter(input.platform, registry);
    const result = await adapter.uploadMedia({
      articleId: input.articleId,
      tenantId: input.tenantId,
      imageData,
    });

    log.info('CMS media uploaded', {
      articleId: input.articleId,
      platform: input.platform,
      cmsMediaId: result.cmsMediaId,
    });

    return result;
  };
}

export const uploadCmsMediaActivity = createUploadCmsMediaActivity();
