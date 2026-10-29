import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import type { ArticleService } from '../services/articleService';

/**
 * Thin Express control surface that imitates an app layer driving article publish.
 * POST /tenants/:tenantId/articles  { articleId, topic } → 202 { workflowId, runId }
 */
export function createPublishServer(articleService: ArticleService): Express {
  const app = express();
  app.use(express.json());

  app.post(
    '/tenants/:tenantId/articles',
    async (req: Request, res: Response) => {
      try {
        const tenantIdParam = req.params.tenantId;
        const tenantId = Array.isArray(tenantIdParam)
          ? (tenantIdParam[0] ?? '')
          : (tenantIdParam ?? '');
        const body = req.body as unknown;

        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          res.status(400).json({ error: 'Request body must be a JSON object' });
          return;
        }

        const { articleId, topic } = body as Record<string, unknown>;
        if (typeof articleId !== 'string' || articleId.trim().length === 0) {
          res
            .status(400)
            .json({ error: 'articleId is required (non-empty string)' });
          return;
        }
        if (typeof topic !== 'string' || topic.trim().length === 0) {
          res.status(400).json({ error: 'topic is required (non-empty string)' });
          return;
        }
        if (tenantId.trim().length === 0) {
          res
            .status(400)
            .json({ error: 'tenantId is required (non-empty string)' });
          return;
        }

        const result = await articleService.publishArticle({
          tenantId,
          articleId,
          topic,
        });
        res.status(202).json(result);
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use(
    (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const isJsonParseError =
        err instanceof SyntaxError ||
        (typeof err === 'object' &&
          err !== null &&
          'type' in err &&
          (err as { type?: string }).type === 'entity.parse.failed');
      if (isJsonParseError) {
        res.status(400).json({ error: 'Invalid JSON body' });
        return;
      }
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    },
  );

  return app;
}
