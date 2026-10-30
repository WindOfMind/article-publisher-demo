import {
  ActivityFailure,
  isCancellation,
  log,
  proxyActivities,
} from '@temporalio/workflow';
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

const {
  generateTextActivity,
  generateImageActivity,
  uploadCmsMediaActivity,
  recordArticlePublishActivity,
} = proxyActivities<typeof activities>({
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
 * Persist `failed` only after Temporal has given up on the activity:
 * retries exhausted, or a non-retryable / terminal ApplicationFailure.
 * Skip cancellations (worker restart, workflow cancel) — those are not publish outcomes.
 */
function shouldRecordPublishFailure(err: unknown): boolean {
  if (isCancellation(err)) {
    return false;
  }
  if (!(err instanceof ActivityFailure)) {
    return false;
  }
  return (
    err.retryState === 'MAXIMUM_ATTEMPTS_REACHED' ||
    err.retryState === 'NON_RETRYABLE_FAILURE'
  );
}

function failureMessage(err: unknown): string {
  if (err instanceof ActivityFailure && err.cause instanceof Error) {
    return err.cause.message;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * Orchestrates Text ∥ Image → per-platform (Media Upload → Publish).
 * Same article content is reused across every platform in `platforms`.
 * Rate-limited publish failures are retried via nextRetryDelay.
 */
export async function articleWorkflow(
  input: ArticleWorkflowInput,
): Promise<PublishedArticleUrl[]> {
  log.info('Article workflow started', {
    articleId: input.articleId,
    tenantId: input.tenantId,
    platforms: input.platforms,
    topic: input.topic,
  });

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

  log.info('Content generated', {
    articleId: input.articleId,
    textS3Uri,
    imageS3Uri,
  });

  const published = await Promise.all(
    input.platforms.map(async (platform) => {
      log.info('Publishing to platform', {
        articleId: input.articleId,
        platform,
      });

      let liveUrl: string;
      try {
        const { cmsMediaId } = await uploadCmsMediaActivity({
          articleId: input.articleId,
          tenantId: input.tenantId,
          platform,
          imageS3Uri,
        });

        ({ liveUrl } = await publishCmsPostActivity({
          articleId: input.articleId,
          tenantId: input.tenantId,
          platform,
          topic: input.topic,
          textS3Uri,
          cmsMediaId,
        }));
      } catch (err: unknown) {
        if (shouldRecordPublishFailure(err)) {
          await recordArticlePublishActivity({
            articleId: input.articleId,
            tenantId: input.tenantId,
            platform,
            status: 'failed',
            error: failureMessage(err),
          });
        }
        throw err;
      }

      await recordArticlePublishActivity({
        articleId: input.articleId,
        tenantId: input.tenantId,
        platform,
        status: 'published',
        liveUrl,
      });

      log.info('Published to platform', {
        articleId: input.articleId,
        platform,
        liveUrl,
      });

      return { platform, liveUrl };
    }),
  );

  log.info('Article workflow completed', {
    articleId: input.articleId,
    publishedCount: published.length,
  });

  return published;
}
