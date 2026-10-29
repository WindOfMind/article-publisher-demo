import { Client, Connection } from '@temporalio/client';
import {
  ArticleService,
  DEFAULT_ARTICLE_TASK_QUEUE,
} from '../services/articleService';
import { createPublishServer } from './publishServer';

/**
 * Starts the HTTP publish control API against a running Temporal server.
 * Requires a Temporal server and a worker polling the article task queue.
 */
async function main(): Promise<void> {
  const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
  const taskQueue =
    process.env.TEMPORAL_TASK_QUEUE ?? DEFAULT_ARTICLE_TASK_QUEUE;
  const port = Number(process.env.PORT ?? '3000');

  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });
  const articleService = new ArticleService(client, taskQueue);
  const app = createPublishServer(articleService);

  await new Promise<void>((resolve) => {
    app.listen(port, () => resolve());
  });

  console.log(
    `Publish API listening on http://localhost:${port} (taskQueue=${taskQueue}, namespace=${namespace}, address=${address})`,
  );
  console.log(
    'POST /tenants/:tenantId/articles  { "articleId": "...", "topic": "..." }',
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
