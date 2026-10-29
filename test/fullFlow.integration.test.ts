import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { metrics, resetMetrics } from '../src/activities';
import * as activities from '../src/activities';
import {
  ArticleService,
  DEFAULT_ARTICLE_TASK_QUEUE,
} from '../src/services/articleService';
import { mockRateLimiter } from '../src/services/mockRateLimiter';
import { mockS3 } from '../src/services/mockS3';
import type { ArticleWorkflowInput } from '../src/workflows';

const TASK_QUEUE = DEFAULT_ARTICLE_TASK_QUEUE;
const BATCH_SIZE = 10;
const TENANTS = ['tenant-a', 'tenant-b'] as const;
const WORKER1_RUNTIME_MS = 600;

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function buildBatch(): ArticleWorkflowInput[] {
  return Array.from({ length: BATCH_SIZE }, (_, i) => {
    const tenantId = TENANTS[i % TENANTS.length]!;
    const articleId = `article-${String(i + 1).padStart(2, '0')}`;
    return {
      articleId,
      tenantId,
      topic: `SEO Topic ${i + 1}`,
    };
  });
}

async function createWorker(
  env: TestWorkflowEnvironment,
  label: string,
): Promise<Worker> {
  return Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve('../src/workflows'),
    activities,
    // Brief grace window so in-flight uploads see cancellation (OOM / restart).
    // Activities that ignore cancel would otherwise drain to completion.
    shutdownGraceTime: '50 ms',
    maxConcurrentActivityTaskExecutions: 20,
    identity: label,
  });
}

/** 
  1. Starts **10 workflows** across **2 tenants**.
  2. Starts **Worker 1**, runs ~600ms (text + image complete; uploads in flight).
  3. **Hard-kills Worker 1** (simulates OOM / restart).
  4. Asserts intermediate LLM/image calls already happened.
  5. Starts **Worker 2** on the same task queue.
  6. Awaits all handles, then asserts:
    - All 10 workflows return live CMS URLs
    - `metrics.llmCalls === 10` (no duplicate LLM payment)
    - `metrics.imageCalls === 10` (no duplicate image payment)
    - `metrics.cmsPublishes === 10`

  Uploads abandoned by Worker 1 are retried by Worker 2 (`cmsUploads` may be > 10); 
  completed LLM/image steps are not re-executed because Temporal recorded their results in workflow history.
*/

async function main(): Promise<void> {
  console.log('=== SEO Article Publisher PoC — Crash Harness ===\n');

  resetMetrics();
  mockS3.clear();
  mockRateLimiter.clear();

  const env = await TestWorkflowEnvironment.createLocal();

  try {
    const batch = buildBatch();
    console.log(
      `Starting ${batch.length} article workflows across tenants: ${TENANTS.join(', ')}`,
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
    console.log(`  llmCalls     = ${metrics.llmCalls}`);
    console.log(`  imageCalls   = ${metrics.imageCalls}`);
    console.log(`  cmsUploads   = ${metrics.cmsUploads}`);
    console.log(`  cmsPublishes = ${metrics.cmsPublishes}`);

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

    const results = await Promise.all(handles.map((h) => h.result()));

    worker2.shutdown();
    await worker2Run;

    console.log('\n=== Final Assertions ===\n');

    assert(
      results.length === BATCH_SIZE,
      `expected ${BATCH_SIZE} results, got ${results.length}`,
    );

    for (const [i, url] of results.entries()) {
      assert(
        typeof url === 'string' && url.startsWith('https://cms.example.com/'),
        `workflow ${i} did not return a live URL: ${String(url)}`,
      );
    }
    console.log(`✓ All ${BATCH_SIZE} workflows returned live URLs.`);

    assert(
      metrics.llmCalls === BATCH_SIZE,
      `zero-duplicate LLM payment violated: llmCalls=${metrics.llmCalls}, expected ${BATCH_SIZE}`,
    );
    console.log(
      `✓ metrics.llmCalls === ${BATCH_SIZE} (zero duplicate payment)`,
    );

    assert(
      metrics.imageCalls === BATCH_SIZE,
      `zero-duplicate image payment violated: imageCalls=${metrics.imageCalls}, expected ${BATCH_SIZE}`,
    );
    console.log(
      `✓ metrics.imageCalls === ${BATCH_SIZE} (zero duplicate payment)`,
    );

    assert(
      metrics.cmsPublishes === BATCH_SIZE,
      `cmsPublishes=${metrics.cmsPublishes}, expected ${BATCH_SIZE}`,
    );
    console.log(`✓ metrics.cmsPublishes === ${BATCH_SIZE}`);

    console.log('\nFinal metrics:');
    console.log(`  llmCalls     = ${metrics.llmCalls}`);
    console.log(`  imageCalls   = ${metrics.imageCalls}`);
    console.log(`  cmsUploads   = ${metrics.cmsUploads}`);
    console.log(`  cmsPublishes = ${metrics.cmsPublishes}`);
    console.log(`  mockS3 objects = ${mockS3.size()}`);

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
