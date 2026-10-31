import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from '../activities';
import {
  ArticleService,
  DEFAULT_ARTICLE_TASK_QUEUE,
} from '../services/article/articleService';
import { createArticleServer } from './articleServer';

/**
 * Starts the HTTP publish control API and a Temporal worker that polls
 * the article task queue. Requires a Temporal server (e.g. `temporal server start-dev`).
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
  const app = createArticleServer(articleService);

  await new Promise<void>((resolve) => {
    app.listen(port, () => resolve());
  });

  console.log(
    `Publish API listening on http://localhost:${port} (taskQueue=${taskQueue}, namespace=${namespace}, address=${address})`,
  );
  console.log(
    'POST /tenants/:tenantId/articles  { "topic": "...", "platforms": ["shopify","wix"] }',
  );
  console.log('GET  /tenants/:tenantId/articles/:articleId  → publish history');

  const nativeConnection = await NativeConnection.connect({ address });
  const worker = await Worker.create({
    connection: nativeConnection,
    namespace,
    taskQueue,
    workflowsPath: require.resolve('../workflows'),
    activities,
  });

  console.log(`Worker polling task queue ${taskQueue}`);
  await worker.run();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
