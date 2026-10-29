import {
  ActivityFailure,
  ApplicationFailure,
  proxyActivities,
  sleep,
} from '@temporalio/workflow';
import type * as activities from '../activities';

export interface ArticleWorkflowInput {
  articleId: string;
  tenantId: string;
  topic: string;
}

const {
  generateTextActivity,
  generateImageActivity,
  uploadCmsMediaActivity,
  publishCmsPostActivity,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  heartbeatTimeout: '30 seconds',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumAttempts: 5,
  },
});

/**
 * Orchestrates Text ∥ Image → Media Upload → Publish.
 * Text and image generation run in parallel; CMS publish is wrapped in a
 * cooperative retry loop: on TENANT_RATE_LIMITED / PLATFORM_RATE_LIMITED the
 * workflow sleeps 1s (yielding the worker) and retries without failing.
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

  // Cooperative rate-limit handling — sleep yields the worker thread.
  for (;;) {
    try {
      const { liveUrl } = await publishCmsPostActivity({
        articleId: input.articleId,
        tenantId: input.tenantId,
        topic: input.topic,
        textS3Uri,
        cmsMediaId,
      });
      return liveUrl;
    } catch (err) {
      if (isRateLimited(err)) {
        await sleep('1 second');
        continue;
      }
      throw err;
    }
  }
}

const RATE_LIMIT_TYPES = new Set([
  'TENANT_RATE_LIMITED',
  'PLATFORM_RATE_LIMITED',
]);

function isRateLimited(err: unknown): boolean {
  if (!(err instanceof ActivityFailure)) {
    return false;
  }

  const cause = err.cause;

  return (
    cause instanceof ApplicationFailure &&
    typeof cause.type === 'string' &&
    RATE_LIMIT_TYPES.has(cause.type)
  );
}
