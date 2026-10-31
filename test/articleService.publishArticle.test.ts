import type { Client } from '@temporalio/client';
import { articleWorkflow } from '../src/workflows/articleWorkflow';
import {
  ArticleService,
  DEFAULT_ARTICLE_TASK_QUEUE,
  type PublishArticleInput,
} from '../src/services/article/articleService';
import { ArticleStorage } from '../src/services/article/articleStorage';

interface StartCall {
  workflow: unknown;
  options: {
    taskQueue: string;
    workflowId: string;
    args: unknown[];
  };
}

interface StartedHandle {
  workflowId: string;
  firstExecutionRunId: string;
}

function createMockClient(runId = 'run-abc'): {
  client: Client;
  starts: StartCall[];
} {
  const starts: StartCall[] = [];
  const client = {
    workflow: {
      async start(
        workflow: unknown,
        options: StartCall['options'],
      ): Promise<StartedHandle> {
        starts.push({ workflow, options });
        return {
          workflowId: options.workflowId,
          firstExecutionRunId: runId,
        };
      },
    },
  } as unknown as Client;

  return { client, starts };
}

describe('ArticleService.publishArticle', () => {
  it('creates pending history, starts articleWorkflow, and returns bound ids', async () => {
    const store = new ArticleStorage();
    const { client, starts } = createMockClient('run-1');
    const service = new ArticleService(
      client,
      DEFAULT_ARTICLE_TASK_QUEUE,
      store,
    );

    const input: PublishArticleInput = {
      tenantId: 'tenant-a',
      topic: 'SEO Topic One',
      platforms: ['shopify', 'wix'],
    };

    const result = await service.publishArticle(input);

    expect(starts).toHaveLength(1);
    const call = starts[0]!;
    expect(call.workflow).toBe(articleWorkflow);
    expect(call.options.taskQueue).toBe(DEFAULT_ARTICLE_TASK_QUEUE);
    expect(call.options.workflowId).toBe(
      `publish-${input.tenantId}-${result.articleId}`,
    );
    expect(call.options.args).toEqual([
      {
        ...input,
        articleId: result.articleId,
      },
    ]);
    expect(result).toEqual({
      articleId: result.articleId,
      workflowId: call.options.workflowId,
      runId: 'run-1',
    });

    const history = service.getPublishHistory(input.tenantId, result.articleId);
    expect(history).toMatchObject({
      topic: input.topic,
      workflowId: result.workflowId,
      runId: result.runId,
      entries: input.platforms.map((platform) => ({
        platform,
        status: 'pending',
        liveUrl: null,
        error: null,
      })),
    });
  });

  it('uses the injected task queue', async () => {
    const store = new ArticleStorage();
    const { client, starts } = createMockClient();
    const taskQueue = 'custom-article-queue';
    const service = new ArticleService(client, taskQueue, store);

    await service.publishArticle({
      tenantId: 'tenant-b',
      topic: 'Custom Queue Topic',
      platforms: ['shopify'],
    });

    expect(starts).toHaveLength(1);
    expect(starts[0]!.options.taskQueue).toBe(taskQueue);
  });

  it('assigns unique article and workflow ids per publish', async () => {
    const store = new ArticleStorage();
    const { client, starts } = createMockClient('run-shared');
    const service = new ArticleService(
      client,
      DEFAULT_ARTICLE_TASK_QUEUE,
      store,
    );

    const input: PublishArticleInput = {
      tenantId: 'tenant-a',
      topic: 'Same Topic',
      platforms: ['wix'],
    };

    const first = await service.publishArticle(input);
    const second = await service.publishArticle(input);

    expect(first.articleId).not.toBe(second.articleId);
    expect(first.workflowId).not.toBe(second.workflowId);
    expect(starts).toHaveLength(2);
    expect(starts[0]!.options.args[0]).toMatchObject({
      articleId: first.articleId,
    });
    expect(starts[1]!.options.args[0]).toMatchObject({
      articleId: second.articleId,
    });

    expect(
      service.getPublishHistory(input.tenantId, first.articleId),
    ).toMatchObject({ workflowId: first.workflowId });
    expect(
      service.getPublishHistory(input.tenantId, second.articleId),
    ).toMatchObject({ workflowId: second.workflowId });
  });
});
