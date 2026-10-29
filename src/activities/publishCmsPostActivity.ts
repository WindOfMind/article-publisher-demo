import { ApplicationFailure } from '@temporalio/common';
import {
  createDefaultPlatformRegistry,
  getPlatformAdapter,
  type PlatformAdapterRegistry,
  type PlatformId,
} from '../platforms';
import { mockRateLimiter } from '../services/mockRateLimiter';
import { mockS3 } from '../services/mockS3';
import { metrics } from './metrics';

export interface PublishCmsPostInput {
  articleId: string;
  tenantId: string;
  platform: PlatformId;
  topic: string;
  textS3Uri: string;
  cmsMediaId: string;
}

export interface PublishCmsPostResult {
  liveUrl: string;
}

/** Per-tenant publish budget. */
const TENANT_PUBLISH_RPS = 2;
/** Shared publish budget per platform across every tenant. */
const PLATFORM_PUBLISH_RPS = 5;

function tenantKey(tenantId: string): string {
  return `tenant:${tenantId}`;
}

function platformKey(platformId: PlatformId): string {
  return `platform:${platformId}`;
}

/**
 * Publishes via the article's platform adaptor, subject to dual rate limits:
 * - per-tenant (2 RPS)
 * - per-platform (5 RPS total across all tenants on that platform)
 *
 * On exhaustion throws a retryable ApplicationFailure with nextRetryDelay so
 * Temporal's activity Retry Policy backs off and retries (Delayed Retry).
 */
export function createPublishCmsPostActivity(
  registry: PlatformAdapterRegistry = createDefaultPlatformRegistry(),
) {
  return async function publishCmsPostActivity(
    input: PublishCmsPostInput,
  ): Promise<PublishCmsPostResult> {
    const tKey = tenantKey(input.tenantId);
    const pKey = platformKey(input.platform);

    const exhausted = mockRateLimiter.tryAcquireAll([
      { key: tKey, limitRps: TENANT_PUBLISH_RPS },
      { key: pKey, limitRps: PLATFORM_PUBLISH_RPS },
    ]);

    if (exhausted === tKey) {
      throw ApplicationFailure.create({
        message: `Tenant ${input.tenantId} exceeded publish rate limit of ${TENANT_PUBLISH_RPS} RPS`,
        type: 'TENANT_RATE_LIMITED',
        nextRetryDelay: '1 second',
      });
    }

    if (exhausted === pKey) {
      throw ApplicationFailure.create({
        message: `Platform ${input.platform} exceeded publish rate limit of ${PLATFORM_PUBLISH_RPS} RPS (tenant ${input.tenantId})`,
        type: 'PLATFORM_RATE_LIMITED',
        nextRetryDelay: '1 second',
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

    const adapter = getPlatformAdapter(input.platform, registry);
    return adapter.publishPost({
      articleId: input.articleId,
      tenantId: input.tenantId,
      topic: input.topic,
      markdown,
      cmsMediaId: input.cmsMediaId,
    });
  };
}

export const publishCmsPostActivity = createPublishCmsPostActivity();
