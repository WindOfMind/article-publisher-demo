import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities';

export interface ArticleWorkflowInput {
  articleId: string;
  tenantId: string;
  topic: string;
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
 * Orchestrates Text ∥ Image → Media Upload → Publish.
 * Text and image generation run in parallel. Rate-limited publish failures
 * are retried by the activity Retry Policy via nextRetryDelay.
 */
export async function articleWorkflow(
  input: ArticleWorkflowInput,
): Promise<string> {
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

  const { cmsMediaId } = await uploadCmsMediaActivity({
    articleId: input.articleId,
    tenantId: input.tenantId,
    imageS3Uri,
  });

  const { liveUrl } = await publishCmsPostActivity({
    articleId: input.articleId,
    tenantId: input.tenantId,
    topic: input.topic,
    textS3Uri,
    cmsMediaId,
  });
  return liveUrl;
}
