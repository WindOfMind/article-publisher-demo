import { ApplicationFailure } from '@temporalio/common';
import { MockActivityEnvironment } from '@temporalio/testing';
import {
  createPublishCmsPostActivity,
  type PublishCmsPostInput,
  type PublishCmsPostResult,
} from '../src/activities';
import { mockCms } from '../src/infra/mockCms';
import { mockRateLimiter } from '../src/infra/mockRateLimiter';
import { mockS3 } from '../src/infra/mockS3';
import {
  InMemoryMetricsService,
  metricsService,
} from '../src/services/metrics/metricsService';
import { createDefaultPlatformRegistry } from '../src/platforms';

describe('publishCmsPostActivity', () => {
  beforeEach(() => {
    metricsService.reset();
    mockS3.clear();
    mockCms.clear();
    mockRateLimiter.clear();
  });

  async function seedMarkdown(
    tenantId: string,
    articleId: string,
    body = '# Topic\n\nBody.',
  ): Promise<string> {
    return mockS3.put(`${tenantId}/${articleId}/content.md`, body);
  }

  function asFailure(err: unknown): ApplicationFailure {
    expect(err).toBeInstanceOf(ApplicationFailure);
    return err as ApplicationFailure;
  }

  it('throws TENANT_RATE_LIMITED with nextRetryDelay when tenant bucket is exhausted', async () => {
    const tenantId = 'tenant-rl';
    const articleId = 'article-rl-tenant';
    const textS3Uri = await seedMarkdown(tenantId, articleId);
    const metrics = new InMemoryMetricsService();
    const publish = createPublishCmsPostActivity({ metrics });

    const input: PublishCmsPostInput = {
      articleId,
      tenantId,
      platform: 'shopify',
      topic: 'Rate Limit Topic',
      textS3Uri,
      cmsMediaId: 'media-1',
    };

    // Exhaust per-tenant budget (2 RPS).
    expect(
      mockRateLimiter.tryAcquireAll([
        { key: `tenant:${tenantId}`, limitRps: 2 },
        { key: 'platform:shopify', limitRps: 5 },
      ]),
    ).toBeNull();
    expect(
      mockRateLimiter.tryAcquireAll([
        { key: `tenant:${tenantId}`, limitRps: 2 },
        { key: 'platform:shopify', limitRps: 5 },
      ]),
    ).toBeNull();

    try {
      await new MockActivityEnvironment({ attempt: 1 }).run(publish, input);
      fail('expected TENANT_RATE_LIMITED');
    } catch (err: unknown) {
      const failure = asFailure(err);
      expect(failure.type).toBe('TENANT_RATE_LIMITED');
      expect(failure.nextRetryDelay).toBe('1 second');
    }

    expect(metrics.snapshot().cmsPublishes).toBe(0);
  });

  it('throws PLATFORM_RATE_LIMITED when platform bucket is exhausted but tenant is free', async () => {
    const articleId = 'article-rl-platform';
    const tenantId = 'tenant-fresh';
    const textS3Uri = await seedMarkdown(tenantId, articleId);
    const metrics = new InMemoryMetricsService();
    const publish = createPublishCmsPostActivity({ metrics });

    for (let i = 0; i < 5; i++) {
      expect(
        mockRateLimiter.tryAcquireAll([
          { key: `tenant:exhaust-${i}`, limitRps: 2 },
          { key: 'platform:shopify', limitRps: 5 },
        ]),
      ).toBeNull();
    }

    const input: PublishCmsPostInput = {
      articleId,
      tenantId,
      platform: 'shopify',
      topic: 'Platform Limit Topic',
      textS3Uri,
      cmsMediaId: 'media-2',
    };

    try {
      await new MockActivityEnvironment({ attempt: 1 }).run(publish, input);
      fail('expected PLATFORM_RATE_LIMITED');
    } catch (err: unknown) {
      const failure = asFailure(err);
      expect(failure.type).toBe('PLATFORM_RATE_LIMITED');
      expect(failure.nextRetryDelay).toBe('1 second');
    }

    expect(metrics.snapshot().cmsPublishes).toBe(0);
  });

  it('throws non-retryable INVALID_CONTENT for empty markdown', async () => {
    const tenantId = 'tenant-invalid';
    const articleId = 'article-invalid';
    const textS3Uri = await mockS3.put(
      `${tenantId}/${articleId}/content.md`,
      '',
    );
    const metrics = new InMemoryMetricsService();
    const publish = createPublishCmsPostActivity({ metrics });

    const input: PublishCmsPostInput = {
      articleId,
      tenantId,
      platform: 'wix',
      topic: 'Invalid Content',
      textS3Uri,
      cmsMediaId: 'media-3',
    };

    try {
      await new MockActivityEnvironment({ attempt: 1 }).run(publish, input);
      fail('expected INVALID_CONTENT failure');
    } catch (err: unknown) {
      const failure = asFailure(err);
      expect(failure.type).toBe('INVALID_CONTENT');
      expect(failure.nonRetryable).toBe(true);
    }

    // Metric is recorded before the S3 content check.
    expect(metrics.snapshot().cmsPublishes).toBe(1);
  });

  it('on retry with existing post, skips rate limiter and metrics', async () => {
    const tenantId = 'tenant-reuse';
    const articleId = 'article-reuse';
    const topic = 'Reuse Topic';
    const textS3Uri = await seedMarkdown(tenantId, articleId);
    const metrics = new InMemoryMetricsService();
    const registry = createDefaultPlatformRegistry();
    const publish = createPublishCmsPostActivity({ metrics, registry });

    const input: PublishCmsPostInput = {
      articleId,
      tenantId,
      platform: 'shopify',
      topic,
      textS3Uri,
      cmsMediaId: 'media-reuse',
    };

    const first = (await new MockActivityEnvironment({ attempt: 1 }).run(
      publish,
      input,
    )) as PublishCmsPostResult;
    expect(metrics.snapshot().cmsPublishes).toBe(1);

    const acquireSpy = jest.spyOn(mockRateLimiter, 'tryAcquireAll');

    const retry = (await new MockActivityEnvironment({ attempt: 2 }).run(
      publish,
      input,
    )) as PublishCmsPostResult;

    expect(retry.liveUrl).toBe(first.liveUrl);
    expect(acquireSpy).not.toHaveBeenCalled();
    expect(metrics.snapshot().cmsPublishes).toBe(1);

    acquireSpy.mockRestore();
  });
});
