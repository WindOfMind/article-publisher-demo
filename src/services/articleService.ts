import type { Client } from '@temporalio/client';
import {
  articleWorkflow,
  type ArticleWorkflowInput,
} from '../workflows/articleWorkflow';

export const DEFAULT_ARTICLE_TASK_QUEUE = 'article-publisher-poc';

export type PublishArticleInput = ArticleWorkflowInput;

export interface PublishArticleResult {
  workflowId: string;
  runId: string;
}

/**
 * Application control layer for publishing SEO articles.
 * Starts `articleWorkflow` for a given tenant; does not wait for completion.
 */
export class ArticleService {
  constructor(
    private readonly client: Client,
    private readonly taskQueue: string = DEFAULT_ARTICLE_TASK_QUEUE,
  ) {}

  async publishArticle(
    input: PublishArticleInput,
  ): Promise<PublishArticleResult> {
    const workflowId = `publish-${input.tenantId}-${input.articleId}`;
    const handle = await this.client.workflow.start(articleWorkflow, {
      taskQueue: this.taskQueue,
      workflowId,
      args: [input],
    });

    return {
      workflowId: handle.workflowId,
      runId: handle.firstExecutionRunId,
    };
  }
}
