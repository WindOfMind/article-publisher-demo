import { Context, log } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import {
  createDefaultPlatformRegistry,
  getPlatformAdapter,
  type PlatformAdapterRegistry,
  type PlatformId,
} from '../platforms';
import { mockRateLimiter } from '../infra/mockRateLimiter';
import { mockS3 } from '../infra/mockS3';
import {
  metricsService,
  type MetricsService,
} from '../services/metrics/metricsService';

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

export interface PublishCmsPostDeps {
  registry?: PlatformAdapterRegistry;
  metrics?: MetricsService;
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
 *
 * On retry (attempt > 1), looks up an existing post first so a prior success
 * that failed to report does not create a duplicate or consume rate-limit tokens.
 */
export function createPublishCmsPostActivity(
  deps: PublishCmsPostDeps = {},
) {
  const registry = deps.registry ?? createDefaultPlatformRegistry();
  const metrics = deps.metrics ?? metricsService;

  return async function publishCmsPostActivity(
    input: PublishCmsPostInput,
  ): Promise<PublishCmsPostResult> {
    const { attempt } = Context.current().info;

    log.info('Publishing CMS post', {
      articleId: input.articleId,
      tenantId: input.tenantId,
      platform: input.platform,
      cmsMediaId: input.cmsMediaId,
      attempt,
    });

    const adapter = getPlatformAdapter(input.platform, registry);

    if (attempt > 1) {
      const existing = await adapter.findPost({
        articleId: input.articleId,
        tenantId: input.tenantId,
      });
      if (existing) {
        log.info('Reusing existing CMS post after retry', {
          articleId: input.articleId,
          platform: input.platform,
          liveUrl: existing.liveUrl,
          attempt,
        });
        return existing;
      }
    }

    const tKey = tenantKey(input.tenantId);
    const pKey = platformKey(input.platform);

    const exhausted = mockRateLimiter.tryAcquireAll([
      { key: tKey, limitRps: TENANT_PUBLISH_RPS },
      { key: pKey, limitRps: PLATFORM_PUBLISH_RPS },
    ]);

    if (exhausted === tKey) {
      log.warn('Tenant publish rate limit exceeded', {
        articleId: input.articleId,
        tenantId: input.tenantId,
        limitRps: TENANT_PUBLISH_RPS,
      });
      throw ApplicationFailure.create({
        message: `Tenant ${input.tenantId} exceeded publish rate limit of ${TENANT_PUBLISH_RPS} RPS`,
        type: 'TENANT_RATE_LIMITED',
        nextRetryDelay: '1 second',
      });
    }

    if (exhausted === pKey) {
      log.warn('Platform publish rate limit exceeded', {
        articleId: input.articleId,
        tenantId: input.tenantId,
        platform: input.platform,
        limitRps: PLATFORM_PUBLISH_RPS,
      });
      throw ApplicationFailure.create({
        message: `Platform ${input.platform} exceeded publish rate limit of ${PLATFORM_PUBLISH_RPS} RPS (tenant ${input.tenantId})`,
        type: 'PLATFORM_RATE_LIMITED',
        nextRetryDelay: '1 second',
      });
    }

    metrics.recordCmsPublish();

    // Claim-check: pull markdown from Mock S3 rather than receiving it as an activity arg.
    const markdown = await mockS3.get(input.textS3Uri);
    if (typeof markdown !== 'string' || markdown.length === 0) {
      log.error('Missing or empty markdown for publish', {
        articleId: input.articleId,
        textS3Uri: input.textS3Uri,
      });
      throw ApplicationFailure.create({
        message: `Missing or empty markdown at ${input.textS3Uri}`,
        type: 'INVALID_CONTENT',
        nonRetryable: true,
      });
    }

    const result = await adapter.publishPost({
      articleId: input.articleId,
      tenantId: input.tenantId,
      topic: input.topic,
      markdown,
      cmsMediaId: input.cmsMediaId,
    });

    log.info('CMS post published', {
      articleId: input.articleId,
      platform: input.platform,
      liveUrl: result.liveUrl,
    });

    return result;
  };
}

export const publishCmsPostActivity = createPublishCmsPostActivity();
