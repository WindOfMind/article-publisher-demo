import type { Client } from '@temporalio/client';
import {
  articleWorkflow,
  type ArticleWorkflowInput,
} from '../../workflows/articleWorkflow';
import {
  articleStorage,
  type ArticlePublishHistory,
  type ArticleStorage,
  type RecordPlatformPublishInput,
} from './articleStorage';

export const DEFAULT_ARTICLE_TASK_QUEUE = 'article-publisher-poc';

export type PublishArticleInput = Omit<ArticleWorkflowInput, 'articleId'>;

export interface PublishArticleResult {
  articleId: string;
  workflowId: string;
  runId: string;
}

/**
 * Application control layer for publishing SEO articles.
 * Starts `articleWorkflow` for a given tenant; does not wait for completion.
 * Owns publish history: where each article went live, URL, and status.
 */
export class ArticleService {
  constructor(
    private readonly client: Client,
    private readonly taskQueue: string = DEFAULT_ARTICLE_TASK_QUEUE,
    private readonly publishStore: ArticleStorage = articleStorage,
  ) {}

  async publishArticle(
    input: PublishArticleInput,
  ): Promise<PublishArticleResult> {
    const record = this.publishStore.create({
      tenantId: input.tenantId,
      topic: input.topic,
      platforms: input.platforms,
    });
    const articleId = record.articleId;
    const workflowInput: ArticleWorkflowInput = { ...input, articleId };

    const workflowId = `publish-${input.tenantId}-${articleId}`;
    const handle = await this.client.workflow.start(articleWorkflow, {
      taskQueue: this.taskQueue,
      workflowId,
      args: [workflowInput],
    });

    this.publishStore.bindWorkflow({
      tenantId: input.tenantId,
      articleId,
      workflowId: handle.workflowId,
      runId: handle.firstExecutionRunId,
    });

    return {
      articleId,
      workflowId: handle.workflowId,
      runId: handle.firstExecutionRunId,
    };
  }

  /**
   * Saves a per-platform publish outcome (URL + status) into article history.
   * Called from Temporal activities when a platform publish succeeds or fails.
   */
  savePublishResult(
    input: RecordPlatformPublishInput,
  ): ArticlePublishHistory | null {
    return this.publishStore.recordPlatform(input);
  }

  getPublishHistory(
    tenantId: string,
    articleId: string,
  ): ArticlePublishHistory | null {
    return this.publishStore.get(tenantId, articleId);
  }
}

/**
 * Persistence-only ArticleService binder for workers/activities that have no
 * Temporal client. Shares the same in-memory history as HTTP control API.
 */
export const articlePublishPersistence: Pick<
  ArticleService,
  'savePublishResult'
> = {
  savePublishResult(input) {
    return articleStorage.recordPlatform(input);
  },
};

export type {
  ArticlePublishHistory,
  PlatformPublishEntry,
  PublishStatus,
} from './articleStorage';
export type { RecordPlatformPublishInput } from './articleStorage';
