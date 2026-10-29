import { proxyActivities } from '@temporalio/workflow';
import type { PlatformId } from '../platforms/types';
import type * as activities from '../activities';

export interface ArticleWorkflowInput {
  articleId: string;
  tenantId: string;
  /**
   * Target CMS platform(s) from request/config.
   * Content is generated once; media upload + publish fan out per platform.
   */
  platforms: PlatformId[];
  topic: string;
}

export interface PublishedArticleUrl {
  platform: PlatformId;
  liveUrl: string;
}

const { generateTextActivity, generateImageActivity, uploadCmsMediaActivity } =
  proxyActivities<typeof activities>({
    startToCloseTimeout: '2 minutes',
    heartbeatTimeout: '30 seconds',
    retry: {
      initialInterval: '1 second',
      backoffCoefficient: 2,
      maximumAttempts: 5,
    },
  });

/** Publish uses Temporal activity retries for rate limits (nextRetryDelay). */
const { publishCmsPostActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 1,
    maximumInterval: '1 second',
    // Unbounded: rate limits are transient; delay comes from nextRetryDelay.
    maximumAttempts: Number.POSITIVE_INFINITY,
  },
});

/**
 * Orchestrates Text ∥ Image → per-platform (Media Upload → Publish).
 * Same article content is reused across every platform in `platforms`.
 * Rate-limited publish failures are retried via nextRetryDelay.
 */
export async function articleWorkflow(
  input: ArticleWorkflowInput,
): Promise<PublishedArticleUrl[]> {
  const [{ textS3Uri }, { imageS3Uri }] = await Promise.all([
    generateTextActivity({
      articleId: input.articleId,
      tenantId: input.tenantId,
      topic: input.topic,
    }),
    generateImageActivity({
      articleId: input.articleId,
      tenantId: input.tenantId,
      topic: input.topic,
    }),
  ]);

  return Promise.all(
    input.platforms.map(async (platform) => {
      const { cmsMediaId } = await uploadCmsMediaActivity({
        articleId: input.articleId,
        tenantId: input.tenantId,
        platform,
        imageS3Uri,
      });

      const { liveUrl } = await publishCmsPostActivity({
        articleId: input.articleId,
        tenantId: input.tenantId,
        platform,
        topic: input.topic,
        textS3Uri,
        cmsMediaId,
      });

      return { platform, liveUrl };
    }),
  );
}
