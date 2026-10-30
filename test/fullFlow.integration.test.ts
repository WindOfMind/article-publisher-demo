import { Context } from '@temporalio/activity';
import {
  MockActivityEnvironment,
  TestWorkflowEnvironment,
} from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import {
  createPublishCmsPostActivity,
  createUploadCmsMediaActivity,
  metrics,
  resetMetrics,
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
const BATCH_SIZE = 10;
const TENANTS = ['tenant-a', 'tenant-b'] as const;
/** Every article publishes to both demo platforms. */
const ARTICLE_PLATFORMS = [...PLATFORM_IDS];
const EXPECTED_PUBLISHES = BATCH_SIZE * ARTICLE_PLATFORMS.length;
const WORKER1_RUNTIME_MS = 600;
/** Keeps uploads in flight when Worker 1 is hard-killed (~600ms). */
const UPLOAD_DELAY_MS = 2_000;

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

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

/**
 * LLM gateway: normalize + hash cache key; miss calls provider once; hit skips it.
 */
async function assertTextGatewayCache(): Promise<void> {
  console.log('=== LLM text gateway cache ===\n');

  resetMetrics();
  mockS3.clear();
  llmGateway.clear();

  const first = (await new MockActivityEnvironment().run(
    activities.generateTextActivity,
    {
      articleId: 'txt-a',
      tenantId: 'tenant-cache',
      topic: '  SEO  Topic   One  ',
    },
  )) as GenerateTextResult;
  assert(!first.cacheHit, 'first generation must be a cache miss');
  const callsAfterMiss = metrics.llmCalls;
  const hitsAfterMiss = metrics.textCacheHits;
  assert(
    callsAfterMiss === 1,
    `expected llmCalls=1 after miss, got ${callsAfterMiss}`,
  );
  assert(
    hitsAfterMiss === 0,
    `expected textCacheHits=0 after miss, got ${hitsAfterMiss}`,
  );
  assert(llmGateway.cacheSize() === 1, 'miss should populate gateway cache');
  console.log('✓ Cache miss invokes mocked LLM text provider once.');

  const second = (await new MockActivityEnvironment().run(
    activities.generateTextActivity,
    {
      articleId: 'txt-b',
      tenantId: 'tenant-cache',
      topic: 'SEO Topic One',
    },
  )) as GenerateTextResult;
  assert(
    second.cacheHit,
    'second generation with same topic must be a cache hit',
  );
  const callsAfterHit = metrics.llmCalls;
  const hitsAfterHit = metrics.textCacheHits;
  assert(
    callsAfterHit === 1,
    `cache hit must not increment llmCalls, got ${callsAfterHit}`,
  );
  assert(
    hitsAfterHit === 1,
    `expected textCacheHits=1 after hit, got ${hitsAfterHit}`,
  );

  const firstMarkdown = await mockS3.get(first.textS3Uri);
  const secondMarkdown = await mockS3.get(second.textS3Uri);
  assert(
    typeof firstMarkdown === 'string' &&
      typeof secondMarkdown === 'string' &&
      firstMarkdown === secondMarkdown,
    'cached markdown must match the original generation',
  );
  console.log('✓ Cache hit reuses markdown and skips provider (cost saved).\n');
}

/**
 * LLM gateway: normalize + hash cache key; miss calls provider once; hit skips it.
 */
async function assertImageGatewayCache(): Promise<void> {
  console.log('=== LLM image gateway cache ===\n');

  resetMetrics();
  mockS3.clear();
  llmGateway.clear();

  const normalized = normalizePrompt('  SEO  Topic   One  ');
  assert(
    normalized === 'seo topic one',
    `expected normalized "seo topic one", got "${normalized}"`,
  );
  assert(
    promptCacheKey('SEO Topic One') === hashPrompt('seo topic one'),
    'cache key must be sha256 of normalized prompt',
  );
  assert(
    promptCacheKey('  SEO  Topic   One  ') === promptCacheKey('seo topic one'),
    'equivalent prompts must share a cache key',
  );
  console.log('✓ Prompt normalize + hash cache key.');

  const first = (await new MockActivityEnvironment().run(
    activities.generateImageActivity,
    {
      articleId: 'img-a',
      tenantId: 'tenant-cache',
      topic: '  SEO  Topic   One  ',
    },
  )) as GenerateImageResult;
  assert(!first.cacheHit, 'first generation must be a cache miss');
  const callsAfterMiss = metrics.imageCalls;
  const hitsAfterMiss = metrics.imageCacheHits;
  assert(
    callsAfterMiss === 1,
    `expected imageCalls=1 after miss, got ${callsAfterMiss}`,
  );
  assert(
    hitsAfterMiss === 0,
    `expected imageCacheHits=0 after miss, got ${hitsAfterMiss}`,
  );
  assert(llmGateway.cacheSize() === 1, 'miss should populate gateway cache');
  console.log('✓ Cache miss invokes mocked LLM provider once.');

  const second = (await new MockActivityEnvironment().run(
    activities.generateImageActivity,
    {
      articleId: 'img-b',
      tenantId: 'tenant-cache',
      topic: 'SEO Topic One',
    },
  )) as GenerateImageResult;
  assert(
    second.cacheHit,
    'second generation with same topic must be a cache hit',
  );
  const callsAfterHit = metrics.imageCalls;
  const hitsAfterHit = metrics.imageCacheHits;
  assert(
    callsAfterHit === 1,
    `cache hit must not increment imageCalls, got ${callsAfterHit}`,
  );
  assert(
    hitsAfterHit === 1,
    `expected imageCacheHits=1 after hit, got ${hitsAfterHit}`,
  );

  const firstBytes = await mockS3.get(first.imageS3Uri);
  const secondBytes = await mockS3.get(second.imageS3Uri);
  assert(
    Buffer.isBuffer(firstBytes) &&
      Buffer.isBuffer(secondBytes) &&
      firstBytes.equals(secondBytes),
    'cached image bytes must match the original generation',
  );
  console.log('✓ Cache hit reuses bytes and skips provider (cost saved).\n');
}

/**
 * First attempt creates; retry (attempt > 1) reuses CMS records without
 * incrementing cmsUploads / cmsPublishes.
 */
async function assertRetryOnlyCmsLookup(): Promise<void> {
  console.log('=== Retry-only CMS existence check ===\n');

  resetMetrics();
  mockS3.clear();
  mockCms.clear();
  mockRateLimiter.clear();
  llmGateway.clear();

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

  const upload = createUploadCmsMediaActivity();
  const publish = createPublishCmsPostActivity();
  const uploadInput = { articleId, tenantId, platform, imageS3Uri };
  const firstUpload = (await new MockActivityEnvironment({
    attempt: 1,
  }).run(upload, uploadInput)) as UploadCmsMediaResult;
  assert(
    metrics.cmsUploads === 1,
    `expected cmsUploads=1 after first upload, got ${metrics.cmsUploads}`,
  );

  const retryUpload = (await new MockActivityEnvironment({
    attempt: 2,
  }).run(upload, uploadInput)) as UploadCmsMediaResult;
  assert(
    retryUpload.cmsMediaId === firstUpload.cmsMediaId,
    `retry upload should reuse media id ${firstUpload.cmsMediaId}, got ${retryUpload.cmsMediaId}`,
  );
  assert(
    metrics.cmsUploads === 1,
    `retry upload must not increment cmsUploads, got ${metrics.cmsUploads}`,
  );
  console.log('✓ Upload retry reuses existing cmsMediaId without re-upload.');

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
  assert(
    metrics.cmsPublishes === 1,
    `expected cmsPublishes=1 after first publish, got ${metrics.cmsPublishes}`,
  );

  const retryPublish = (await new MockActivityEnvironment({
    attempt: 2,
  }).run(publish, publishInput)) as PublishCmsPostResult;
  assert(
    retryPublish.liveUrl === firstPublish.liveUrl,
    `retry publish should reuse liveUrl ${firstPublish.liveUrl}, got ${retryPublish.liveUrl}`,
  );
  assert(
    metrics.cmsPublishes === 1,
    `retry publish must not increment cmsPublishes, got ${metrics.cmsPublishes}`,
  );
  console.log('✓ Publish retry reuses existing liveUrl without re-publish.\n');
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
    uploadCmsMediaActivity: createUploadCmsMediaActivity(
      createSlowPlatformRegistry(UPLOAD_DELAY_MS),
    ),
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

/**
  1. Starts **10 workflows** across **2 tenants**; each article targets **shopify + wix**.
  2. Starts **Worker 1**, runs ~600ms (text + image complete; uploads in flight).
  3. **Hard-kills Worker 1** (simulates OOM / restart).
  4. Asserts intermediate LLM/image calls already happened.
  5. Starts **Worker 2** on the same task queue.
  6. Awaits all handles, then asserts:
    - All 10 workflows return live URLs for both platforms
    - `metrics.llmCalls === 10` (content generated once per article)
    - `metrics.imageCalls === 10`
    - `metrics.cmsPublishes === 20` (10 articles × 2 platforms)

  Uploads abandoned by Worker 1 are retried by Worker 2 (`cmsUploads` may be > 20);
  completed LLM/image steps are not re-executed because Temporal recorded their results in workflow history.
*/

async function main(): Promise<void> {
  await assertTextGatewayCache();
  await assertImageGatewayCache();
  await assertRetryOnlyCmsLookup();

  console.log('=== SEO Article Publisher PoC — Crash Harness ===\n');

  resetMetrics();
  mockS3.clear();
  mockCms.clear();
  mockRateLimiter.clear();
  llmGateway.clear();
  articleStorage.clear();

  const env = await TestWorkflowEnvironment.createLocal();

  try {
    const batch = buildBatch();
    console.log(
      `Starting ${batch.length} article workflows across tenants: ${TENANTS.join(', ')}, platforms per article: ${ARTICLE_PLATFORMS.join(', ')}`,
    );

    const articleService = new ArticleService(env.client, TASK_QUEUE);
    const started = await Promise.all(
      batch.map((input) => articleService.publishArticle(input)),
    );
    const handles = started.map((s) =>
      env.client.workflow.getHandle(s.workflowId, s.runId),
    );

    // --- Worker 1: run briefly, then hard-kill mid-flight ---
    const worker1 = await createWorker(env, 'worker-1');
    console.log(`Worker 1 started — running for ${WORKER1_RUNTIME_MS}ms…`);

    const worker1Run = worker1.run();
    await new Promise<void>((resolve) =>
      setTimeout(resolve, WORKER1_RUNTIME_MS),
    );

    console.log('Hard-killing Worker 1 (simulating OOM / server restart)…');
    worker1.shutdown();
    try {
      await worker1Run;
    } catch (err) {
      // Forced / mid-activity shutdown can surface as a worker run error; that is expected.
      console.log(
        `Worker 1 exited with: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    console.log('Worker 1 stopped.\n');

    // Intermediate progress must have been made before the crash.
    console.log('Intermediate metrics after Worker 1 crash:');
    console.log(`  llmCalls        = ${metrics.llmCalls}`);
    console.log(`  textCacheHits   = ${metrics.textCacheHits}`);
    console.log(`  imageCalls      = ${metrics.imageCalls}`);
    console.log(`  imageCacheHits  = ${metrics.imageCacheHits}`);
    console.log(`  cmsUploads      = ${metrics.cmsUploads}`);
    console.log(`  cmsPublishes    = ${metrics.cmsPublishes}`);

    assert(
      metrics.llmCalls > 0,
      `expected intermediate llmCalls > 0, got ${metrics.llmCalls}`,
    );
    assert(
      metrics.imageCalls > 0,
      `expected intermediate imageCalls > 0, got ${metrics.imageCalls}`,
    );
    console.log('✓ Intermediate LLM / image calls occurred before crash.\n');

    // --- Worker 2: resume on the same task queue ---
    const worker2 = await createWorker(env, 'worker-2');
    console.log(
      'Worker 2 started on the same task queue — awaiting workflows…',
    );

    const worker2Run = worker2.run();

    const results = (await Promise.all(
      handles.map((h) => h.result()),
    )) as PublishedArticleUrl[][];

    worker2.shutdown();
    await worker2Run;

    console.log('\n=== Final Assertions ===\n');

    assert(
      results.length === BATCH_SIZE,
      `expected ${BATCH_SIZE} results, got ${results.length}`,
    );

    for (const [i, published] of results.entries()) {
      assert(
        Array.isArray(published) &&
          published.length === ARTICLE_PLATFORMS.length,
        `workflow ${i} expected ${ARTICLE_PLATFORMS.length} platform URLs, got ${String(published)}`,
      );
      const platforms = new Set(published.map((p) => p.platform));
      for (const platform of ARTICLE_PLATFORMS) {
        assert(
          platforms.has(platform),
          `workflow ${i} missing platform ${platform}`,
        );
      }
      for (const { liveUrl } of published) {
        assert(
          isLivePlatformUrl(liveUrl),
          `workflow ${i} returned non-live URL: ${liveUrl}`,
        );
      }
    }
    console.log(
      `✓ All ${BATCH_SIZE} workflows returned live URLs for ${ARTICLE_PLATFORMS.join(' + ')}.`,
    );

    assert(
      metrics.llmCalls === BATCH_SIZE,
      `zero-duplicate LLM payment violated: llmCalls=${metrics.llmCalls}, expected ${BATCH_SIZE}`,
    );
    console.log(
      `✓ metrics.llmCalls === ${BATCH_SIZE} (one generation per article)`,
    );

    assert(
      metrics.imageCalls === BATCH_SIZE,
      `zero-duplicate image payment violated: imageCalls=${metrics.imageCalls}, expected ${BATCH_SIZE}`,
    );
    console.log(
      `✓ metrics.imageCalls === ${BATCH_SIZE} (one generation per article)`,
    );

    assert(
      metrics.cmsPublishes === EXPECTED_PUBLISHES,
      `cmsPublishes=${metrics.cmsPublishes}, expected ${EXPECTED_PUBLISHES}`,
    );
    console.log(
      `✓ metrics.cmsPublishes === ${EXPECTED_PUBLISHES} (${BATCH_SIZE} × ${ARTICLE_PLATFORMS.length} platforms)`,
    );

    for (const [i, startedItem] of started.entries()) {
      const input = batch[i]!;
      const history = articleService.getPublishHistory(
        input.tenantId,
        startedItem.articleId,
      );
      assert(
        history !== null,
        `missing publish history for ${input.tenantId}/${startedItem.articleId}`,
      );
      assert(
        history.entries.length === ARTICLE_PLATFORMS.length,
        `history ${startedItem.articleId} expected ${ARTICLE_PLATFORMS.length} entries, got ${history.entries.length}`,
      );
      for (const platform of ARTICLE_PLATFORMS) {
        const entry = history.entries.find((e) => e.platform === platform);
        assert(
          entry !== undefined,
          `history ${startedItem.articleId} missing platform ${platform}`,
        );
        assert(
          entry.status === 'published',
          `history ${startedItem.articleId}/${platform} status=${entry.status}, expected published`,
        );
        assert(
          entry.liveUrl !== null && isLivePlatformUrl(entry.liveUrl),
          `history ${startedItem.articleId}/${platform} missing live URL: ${String(entry.liveUrl)}`,
        );
      }
    }
    console.log(
      `✓ ArticleService publish history recorded for all ${BATCH_SIZE} articles (${ARTICLE_PLATFORMS.join(' + ')}).`,
    );

    console.log('\nFinal metrics:');
    console.log(`  llmCalls        = ${metrics.llmCalls}`);
    console.log(`  textCacheHits   = ${metrics.textCacheHits}`);
    console.log(`  imageCalls      = ${metrics.imageCalls}`);
    console.log(`  imageCacheHits  = ${metrics.imageCacheHits}`);
    console.log(`  cmsUploads      = ${metrics.cmsUploads}`);
    console.log(`  cmsPublishes    = ${metrics.cmsPublishes}`);
    console.log(`  mockS3 objects  = ${mockS3.size()}`);
    console.log(`  llm cache       = ${llmGateway.cacheSize()}`);

    console.log('\n=== PoC PASSED ===');
  } finally {
    await env.teardown();
  }
}

main().catch((err: unknown) => {
  console.error('\n=== PoC FAILED ===');
  console.error(err);
  process.exitCode = 1;
});
