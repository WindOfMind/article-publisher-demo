import { Context, log } from '@temporalio/activity';
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
 *
 * On retry (attempt > 1), looks up existing CMS media first to avoid duplicates
 * when a prior attempt succeeded at the CMS but failed to report to Temporal.
 */
export function createUploadCmsMediaActivity(
  registry: PlatformAdapterRegistry = createDefaultPlatformRegistry(),
) {
  return async function uploadCmsMediaActivity(
    input: UploadCmsMediaInput,
  ): Promise<UploadCmsMediaResult> {
    const { attempt } = Context.current().info;

    log.info('Uploading CMS media', {
      articleId: input.articleId,
      tenantId: input.tenantId,
      platform: input.platform,
      imageS3Uri: input.imageS3Uri,
      attempt,
    });

    const adapter = getPlatformAdapter(input.platform, registry);

    if (attempt > 1) {
      const existing = await adapter.findMedia({
        articleId: input.articleId,
        tenantId: input.tenantId,
      });
      if (existing) {
        log.info('Reusing existing CMS media after retry', {
          articleId: input.articleId,
          platform: input.platform,
          cmsMediaId: existing.cmsMediaId,
          attempt,
        });
        return existing;
      }
    }

    metrics.cmsUploads += 1;

    const imageData = await mockS3.get(input.imageS3Uri);
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
