import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import {
  MockActivityEnvironment,
  TestWorkflowEnvironment,
} from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import {
  createPublishCmsPostActivity,
  createUploadCmsMediaActivity,
  type PublishCmsPostResult,
  type UploadCmsMediaResult,
} from '../src/activities';
import * as activities from '../src/activities';
import {
  ArticleService,
  DEFAULT_ARTICLE_TASK_QUEUE,
  type PublishArticleInput,
} from '../src/services/article/articleService';
import { articleStorage } from '../src/services/article/articleStorage';
import { metricsService } from '../src/services/metrics/metricsService';
import {
  PLATFORM_IDS,
  createDefaultPlatformRegistry,
  type FindMediaParams,
  type FindPostParams,
  type PlatformAdapter,
  type PlatformAdapterRegistry,
  type PlatformId,
  type PublishPostParams,
  type UploadMediaParams,
  type UploadMediaResult,
} from '../src/platforms';
import { mockCms } from '../src/infra/mockCms';
import { mockRateLimiter } from '../src/infra/mockRateLimiter';
import { mockS3 } from '../src/infra/mockS3';
import {
  hashPrompt,
  llmGateway,
  normalizePrompt,
  promptCacheKey,
} from '../src/infra/llmGateway';
import type { PublishedArticleUrl } from '../src/workflows';
import type {
  GenerateImageResult,
  GenerateTextResult,
} from '../src/activities';

const TASK_QUEUE = DEFAULT_ARTICLE_TASK_QUEUE;
const FAILURE_TASK_QUEUE = `${DEFAULT_ARTICLE_TASK_QUEUE}-failure`;
const BATCH_SIZE = 10;
const TENANTS = ['tenant-a', 'tenant-b'] as const;
/** Every article publishes to both demo platforms. */
const ARTICLE_PLATFORMS = [...PLATFORM_IDS];
const EXPECTED_PUBLISHES = BATCH_SIZE * ARTICLE_PLATFORMS.length;
const WORKER1_RUNTIME_MS = 600;
/** Keeps uploads in flight when Worker 1 is hard-killed (~600ms). */
const UPLOAD_DELAY_MS = 2_000;
const CRASH_HARNESS_TIMEOUT_MS = 180_000;

function buildBatch(): PublishArticleInput[] {
  return Array.from({ length: BATCH_SIZE }, (_, i) => {
    const tenantId = TENANTS[i % TENANTS.length]!;
    return {
      tenantId,
      platforms: [...ARTICLE_PLATFORMS],
      topic: `SEO Topic ${i + 1}`,
    };
  });
}

/**
 * Test registry: same upload behaviour as the default adapters, but with a long
 * cancellable delay so the crash harness can kill Worker 1 mid-upload.
 */
function createSlowPlatformRegistry(delayMs: number): PlatformAdapterRegistry {
  const inner = createDefaultPlatformRegistry();
  const slow = new Map<PlatformId, PlatformAdapter>();

  for (const [platformId, adapter] of inner) {
    slow.set(platformId, {
      platformId: adapter.platformId,
      async uploadMedia(params: UploadMediaParams): Promise<UploadMediaResult> {
        await cancellableDelay(delayMs);
        return adapter.uploadMedia(params);
      },
      findMedia: (params: FindMediaParams) => adapter.findMedia(params),
      publishPost: (params: PublishPostParams) => adapter.publishPost(params),
      findPost: (params: FindPostParams) => adapter.findPost(params),
    });
  }

  return slow;
}

async function cancellableDelay(ms: number): Promise<void> {
  const ctx = Context.current();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
      // Rejects with CancelledFailure when the worker shuts down mid-upload.
      ctx.cancelled,
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function createHarnessActivities() {
  return {
    ...activities,
    uploadCmsMediaActivity: createUploadCmsMediaActivity({
      registry: createSlowPlatformRegistry(UPLOAD_DELAY_MS),
      metrics: metricsService,
    }),
  };
}

async function createWorker(
  env: TestWorkflowEnvironment,
  label: string,
): Promise<Worker> {
  return Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve('../src/workflows'),
    activities: createHarnessActivities(),
    // Brief grace window so in-flight uploads see cancellation (OOM / restart).
    // Activities that ignore cancel would otherwise drain to completion.
    shutdownGraceTime: '50 ms',
    maxConcurrentActivityTaskExecutions: 20,
    identity: label,
  });
}

function isLivePlatformUrl(url: string): boolean {
  return (
    url.startsWith('https://') &&
    (url.includes('.myshopify.com/') || url.includes('.wixsite.com/'))
  );
}

function resetSharedState(): void {
  metricsService.reset();
  mockS3.clear();
  mockCms.clear();
  mockRateLimiter.clear();
  llmGateway.clear();
  articleStorage.clear();
}

describe('articleWorkflow', () => {
  beforeEach(() => {
    resetSharedState();
  });

  describe('LLM text gateway cache', () => {
    it('misses once then reuses markdown without another provider call', async () => {
      const first = (await new MockActivityEnvironment().run(
        activities.generateTextActivity,
        {
          articleId: 'txt-a',
          tenantId: 'tenant-cache',
          topic: '  SEO  Topic   One  ',
        },
      )) as GenerateTextResult;

      expect(first.cacheHit).toBe(false);
      expect(metricsService.snapshot()).toMatchObject({
        llmCalls: 1,
        textCacheHits: 0,
      });
      expect(llmGateway.cacheSize()).toBe(1);

      const second = (await new MockActivityEnvironment().run(
        activities.generateTextActivity,
        {
          articleId: 'txt-b',
          tenantId: 'tenant-cache',
          topic: 'SEO Topic One',
        },
      )) as GenerateTextResult;

      expect(second.cacheHit).toBe(true);
      expect(metricsService.snapshot()).toMatchObject({
        llmCalls: 1,
        textCacheHits: 1,
      });

      const firstMarkdown = await mockS3.get(first.textS3Uri);
      const secondMarkdown = await mockS3.get(second.textS3Uri);
      expect(typeof firstMarkdown).toBe('string');
      expect(firstMarkdown).toBe(secondMarkdown);
    });
  });

  describe('LLM image gateway cache', () => {
    it('normalizes prompts and reuses image bytes on cache hit', async () => {
      expect(normalizePrompt('  SEO  Topic   One  ')).toBe('seo topic one');
      expect(promptCacheKey('SEO Topic One')).toBe(hashPrompt('seo topic one'));
      expect(promptCacheKey('  SEO  Topic   One  ')).toBe(
        promptCacheKey('seo topic one'),
      );

      const first = (await new MockActivityEnvironment().run(
        activities.generateImageActivity,
        {
          articleId: 'img-a',
          tenantId: 'tenant-cache',
          topic: '  SEO  Topic   One  ',
        },
      )) as GenerateImageResult;

      expect(first.cacheHit).toBe(false);
      expect(metricsService.snapshot()).toMatchObject({
        imageCalls: 1,
        imageCacheHits: 0,
      });
      expect(llmGateway.cacheSize()).toBe(1);

      const second = (await new MockActivityEnvironment().run(
        activities.generateImageActivity,
        {
          articleId: 'img-b',
          tenantId: 'tenant-cache',
          topic: 'SEO Topic One',
        },
      )) as GenerateImageResult;

      expect(second.cacheHit).toBe(true);
      expect(metricsService.snapshot()).toMatchObject({
        imageCalls: 1,
        imageCacheHits: 1,
      });

      const firstBytes = await mockS3.get(first.imageS3Uri);
      const secondBytes = await mockS3.get(second.imageS3Uri);
      expect(Buffer.isBuffer(firstBytes)).toBe(true);
      expect(Buffer.isBuffer(secondBytes)).toBe(true);
      expect((firstBytes as Buffer).equals(secondBytes as Buffer)).toBe(true);
    });
  });

  describe('Retry-only CMS existence check', () => {
    it('reuses cmsMediaId and liveUrl on attempt > 1 without re-billing', async () => {
      const articleId = 'retry-article';
      const tenantId = 'tenant-retry';
      const platform = 'shopify' as const;
      const topic = 'Retry Topic';

      const imageS3Uri = await mockS3.put(
        `${tenantId}/${articleId}/image.webp`,
        Buffer.from('webp'),
      );
      const textS3Uri = await mockS3.put(
        `${tenantId}/${articleId}/article.md`,
        '# Retry Topic\n\nBody.',
      );

      const upload = createUploadCmsMediaActivity({ metrics: metricsService });
      const publish = createPublishCmsPostActivity({ metrics: metricsService });
      const uploadInput = { articleId, tenantId, platform, imageS3Uri };

      const firstUpload = (await new MockActivityEnvironment({
        attempt: 1,
      }).run(upload, uploadInput)) as UploadCmsMediaResult;
      expect(metricsService.snapshot().cmsUploads).toBe(1);

      const retryUpload = (await new MockActivityEnvironment({
        attempt: 2,
      }).run(upload, uploadInput)) as UploadCmsMediaResult;
      expect(retryUpload.cmsMediaId).toBe(firstUpload.cmsMediaId);
      expect(metricsService.snapshot().cmsUploads).toBe(1);

      const publishInput = {
        articleId,
        tenantId,
        platform,
        topic,
        textS3Uri,
        cmsMediaId: firstUpload.cmsMediaId,
      };
      const firstPublish = (await new MockActivityEnvironment({
        attempt: 1,
      }).run(publish, publishInput)) as PublishCmsPostResult;
      expect(metricsService.snapshot().cmsPublishes).toBe(1);

      const retryPublish = (await new MockActivityEnvironment({
        attempt: 2,
      }).run(publish, publishInput)) as PublishCmsPostResult;
      expect(retryPublish.liveUrl).toBe(firstPublish.liveUrl);
      expect(metricsService.snapshot().cmsPublishes).toBe(1);
    });
  });

  describe('happy path', () => {
    let env: TestWorkflowEnvironment;

    beforeAll(async () => {
      env = await TestWorkflowEnvironment.createLocal();
    }, 60_000);

    afterAll(async () => {
      await env?.teardown();
    });

    it('generates content once and publishes live URLs to every platform', async () => {
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: TASK_QUEUE,
        workflowsPath: require.resolve('../src/workflows'),
        activities,
      });

      const input: PublishArticleInput = {
        tenantId: 'tenant-happy',
        platforms: [...ARTICLE_PLATFORMS],
        topic: 'Happy Path SEO Topic',
      };
      const articleService = new ArticleService(env.client, TASK_QUEUE);

      const { started, published } = await worker.runUntil(async () => {
        const started = await articleService.publishArticle(input);
        const handle = env.client.workflow.getHandle(
          started.workflowId,
          started.runId,
        );
        const published = (await handle.result()) as PublishedArticleUrl[];
        return { started, published };
      });

      expect(published).toHaveLength(ARTICLE_PLATFORMS.length);
      const platforms = new Set(published.map((p) => p.platform));
      for (const platform of ARTICLE_PLATFORMS) {
        expect(platforms.has(platform)).toBe(true);
      }
      for (const { liveUrl } of published) {
        expect(isLivePlatformUrl(liveUrl)).toBe(true);
      }

      expect(metricsService.snapshot()).toMatchObject({
        llmCalls: 1,
        imageCalls: 1,
        cmsUploads: ARTICLE_PLATFORMS.length,
        cmsPublishes: ARTICLE_PLATFORMS.length,
      });

      const history = articleService.getPublishHistory(
        input.tenantId,
        started.articleId,
      );
      expect(history).not.toBeNull();
      expect(history!.entries).toHaveLength(ARTICLE_PLATFORMS.length);
      for (const platform of ARTICLE_PLATFORMS) {
        const entry = history!.entries.find((e) => e.platform === platform);
        expect(entry).toBeDefined();
        expect(entry!.status).toBe('published');
        expect(entry!.liveUrl).not.toBeNull();
        expect(isLivePlatformUrl(entry!.liveUrl!)).toBe(true);
      }
    }, 60_000);
  });

  /**
   * 1. Starts 10 workflows across 2 tenants; each article targets shopify + wix.
   * 2. Starts Worker 1, runs ~600ms (text + image complete; uploads in flight).
   * 3. Hard-kills Worker 1 (simulates OOM / restart).
   * 4. Asserts intermediate LLM/image calls already happened.
   * 5. Starts Worker 2 on the same task queue.
   * 6. Awaits all handles, then asserts live URLs, zero-duplicate LLM/image
   *    payment, cmsPublishes, and ArticleService publish history.
   */
  describe('crash harness', () => {
    let env: TestWorkflowEnvironment;

    beforeAll(async () => {
      env = await TestWorkflowEnvironment.createLocal();
    }, CRASH_HARNESS_TIMEOUT_MS);

    afterAll(async () => {
      await env?.teardown();
    });

    it(
      'resumes after Worker 1 crash without duplicate LLM/image payment',
      async () => {
        const batch = buildBatch();
        const articleService = new ArticleService(env.client, TASK_QUEUE);
        const started = await Promise.all(
          batch.map((input) => articleService.publishArticle(input)),
        );
        const handles = started.map((s) =>
          env.client.workflow.getHandle(s.workflowId, s.runId),
        );

        const worker1 = await createWorker(env, 'worker-1');
        const worker1Run = worker1.run();
        await new Promise<void>((resolve) =>
          setTimeout(resolve, WORKER1_RUNTIME_MS),
        );

        worker1.shutdown();
        try {
          await worker1Run;
        } catch {
          // Forced / mid-activity shutdown can surface as a worker run error.
        }

        const mid = metricsService.snapshot();
        expect(mid.llmCalls).toBeGreaterThan(0);
        expect(mid.imageCalls).toBeGreaterThan(0);

        const worker2 = await createWorker(env, 'worker-2');
        const worker2Run = worker2.run();

        const results = (await Promise.all(
          handles.map((h) => h.result()),
        )) as PublishedArticleUrl[][];

        worker2.shutdown();
        await worker2Run;

        expect(results).toHaveLength(BATCH_SIZE);

        for (const published of results) {
          expect(published).toHaveLength(ARTICLE_PLATFORMS.length);
          const platforms = new Set(published.map((p) => p.platform));
          for (const platform of ARTICLE_PLATFORMS) {
            expect(platforms.has(platform)).toBe(true);
          }
          for (const { liveUrl } of published) {
            expect(isLivePlatformUrl(liveUrl)).toBe(true);
          }
        }

        const finalMetrics = metricsService.snapshot();
        expect(finalMetrics.llmCalls).toBe(BATCH_SIZE);
        expect(finalMetrics.imageCalls).toBe(BATCH_SIZE);
        expect(finalMetrics.cmsPublishes).toBe(EXPECTED_PUBLISHES);

        for (const [i, startedItem] of started.entries()) {
          const input = batch[i]!;
          const history = articleService.getPublishHistory(
            input.tenantId,
            startedItem.articleId,
          );
          expect(history).not.toBeNull();
          expect(history!.entries).toHaveLength(ARTICLE_PLATFORMS.length);
          for (const platform of ARTICLE_PLATFORMS) {
            const entry = history!.entries.find((e) => e.platform === platform);
            expect(entry).toBeDefined();
            expect(entry!.status).toBe('published');
            expect(entry!.liveUrl).not.toBeNull();
            expect(isLivePlatformUrl(entry!.liveUrl!)).toBe(true);
          }
        }
      },
      CRASH_HARNESS_TIMEOUT_MS,
    );
  });

  describe('failure recording', () => {
    let env: TestWorkflowEnvironment;

    beforeAll(async () => {
      env = await TestWorkflowEnvironment.createLocal();
    }, 60_000);

    afterAll(async () => {
      await env?.teardown();
    });

    it('records failed history on non-retryable publish failure', async () => {
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: FAILURE_TASK_QUEUE,
        workflowsPath: require.resolve('../src/workflows'),
        activities: {
          ...activities,
          async publishCmsPostActivity() {
            throw ApplicationFailure.create({
              message: 'Missing or empty markdown',
              type: 'INVALID_CONTENT',
              nonRetryable: true,
            });
          },
        },
      });

      const articleService = new ArticleService(env.client, FAILURE_TASK_QUEUE);
      const tenantId = 'tenant-fail-nonretry';
      let articleId = '';

      await worker.runUntil(async () => {
        const started = await articleService.publishArticle({
          tenantId,
          platforms: ['shopify'],
          topic: 'Nonretry Failure Topic',
        });
        articleId = started.articleId;
        const handle = env.client.workflow.getHandle(
          started.workflowId,
          started.runId,
        );
        await expect(handle.result()).rejects.toThrow();
      });

      const history = articleService.getPublishHistory(tenantId, articleId);
      expect(history).not.toBeNull();
      expect(history!.entries).toHaveLength(1);
      expect(history!.entries[0]).toMatchObject({
        platform: 'shopify',
        status: 'failed',
        liveUrl: null,
        error: 'Missing or empty markdown',
      });
    }, 60_000);

    it('records failed history when upload retries are exhausted', async () => {
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: FAILURE_TASK_QUEUE,
        workflowsPath: require.resolve('../src/workflows'),
        activities: {
          ...activities,
          async uploadCmsMediaActivity() {
            throw ApplicationFailure.create({
              message: 'transient CMS upload error',
              type: 'UPLOAD_TRANSIENT',
            });
          },
        },
      });

      const articleService = new ArticleService(env.client, FAILURE_TASK_QUEUE);
      const tenantId = 'tenant-fail-maxattempts';
      let articleId = '';

      await worker.runUntil(async () => {
        const started = await articleService.publishArticle({
          tenantId,
          platforms: ['wix'],
          topic: 'Max Attempts Topic',
        });
        articleId = started.articleId;
        const handle = env.client.workflow.getHandle(
          started.workflowId,
          started.runId,
        );
        await expect(handle.result()).rejects.toThrow();
      });

      const history = articleService.getPublishHistory(tenantId, articleId);
      expect(history).not.toBeNull();
      expect(history!.entries[0]).toMatchObject({
        platform: 'wix',
        status: 'failed',
        liveUrl: null,
      });
      expect(history!.entries[0]!.error).toContain(
        'transient CMS upload error',
      );
    }, 90_000);

    it('does not record failed history when the workflow is cancelled', async () => {
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: FAILURE_TASK_QUEUE,
        workflowsPath: require.resolve('../src/workflows'),
        activities: {
          ...activities,
          async uploadCmsMediaActivity() {
            // Park until cancellation (worker restart / workflow cancel).
            await Context.current().cancelled;
          },
        },
        shutdownGraceTime: '50 ms',
      });

      const articleService = new ArticleService(env.client, FAILURE_TASK_QUEUE);
      const tenantId = 'tenant-fail-cancel';

      await worker.runUntil(async () => {
        const started = await articleService.publishArticle({
          tenantId,
          platforms: ['shopify'],
          topic: 'Cancel Topic',
        });
        const handle = env.client.workflow.getHandle(
          started.workflowId,
          started.runId,
        );

        // Wait until content gen finishes and upload is parked.
        await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
        await handle.cancel();
        await expect(handle.result()).rejects.toThrow();

        const history = articleService.getPublishHistory(
          tenantId,
          started.articleId,
        );
        expect(history).not.toBeNull();
        expect(history!.entries[0]).toMatchObject({
          platform: 'shopify',
          status: 'pending',
          liveUrl: null,
          error: null,
        });
      });
    }, 60_000);
  });
});
