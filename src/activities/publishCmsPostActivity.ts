import { ApplicationFailure } from '@temporalio/common';
import { mockRateLimiter } from '../services/mockRateLimiter';
import { mockS3 } from '../services/mockS3';
import { metrics } from './metrics';

export interface PublishCmsPostInput {
  articleId: string;
  tenantId: string;
  topic: string;
  textS3Uri: string;
  cmsMediaId: string;
}

export interface PublishCmsPostResult {
  liveUrl: string;
}

const TENANT_PUBLISH_RPS = 2;

/**
 * Publishes a CMS post subject to a per-tenant rate limit (2 RPS).
 * On exhaustion throws a non-retryable ApplicationFailure of type
 * TENANT_RATE_LIMITED so the workflow can sleep and retry cooperatively.
 */
export async function publishCmsPostActivity(
  input: PublishCmsPostInput,
): Promise<PublishCmsPostResult> {
  const acquired = mockRateLimiter.tryAcquire(
    input.tenantId,
    TENANT_PUBLISH_RPS,
  );

  if (!acquired) {
    throw ApplicationFailure.create({
      message: `Tenant ${input.tenantId} exceeded publish rate limit of ${TENANT_PUBLISH_RPS} RPS`,
      type: 'TENANT_RATE_LIMITED',
      nonRetryable: true,
    });
  }

  metrics.cmsPublishes += 1;

  // Claim-check: pull markdown from Mock S3 rather than receiving it as an activity arg.
  const markdown = await mockS3.get(input.textS3Uri);
  if (typeof markdown !== 'string' || markdown.length === 0) {
    throw ApplicationFailure.create({
      message: `Missing or empty markdown at ${input.textS3Uri}`,
      type: 'INVALID_CONTENT',
      nonRetryable: true,
    });
  }

  const slug = input.topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  const liveUrl = `https://cms.example.com/${input.tenantId}/${slug}-${input.articleId}?media=${input.cmsMediaId}`;
  return { liveUrl };
}
