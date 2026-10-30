import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { PLATFORM_IDS, normalizePlatformIds } from '../platforms';
import type { ArticleService } from '../services/articleService';

function tenantIdFromParams(req: Request): string {
  const tenantIdParam = req.params.tenantId;
  return Array.isArray(tenantIdParam)
    ? (tenantIdParam[0] ?? '')
    : (tenantIdParam ?? '');
}

function articleIdFromParams(req: Request): string {
  const articleIdParam = req.params.articleId;
  return Array.isArray(articleIdParam)
    ? (articleIdParam[0] ?? '')
    : (articleIdParam ?? '');
}

/**
 * Thin Express control surface that imitates an app layer driving article publish.
 * POST /tenants/:tenantId/articles
 *   { topic, platforms: ["shopify","wix"] } → 202 { articleId, workflowId, runId }
 * GET /tenants/:tenantId/articles/:articleId
 *   → 200 publish history (platform, liveUrl, status) or 404
 */
export function createPublishServer(articleService: ArticleService): Express {
  const app = express();
  app.use(express.json());

  app.post(
    '/tenants/:tenantId/articles',
    async (req: Request, res: Response) => {
      try {
        const tenantId = tenantIdFromParams(req);
        const body = req.body as unknown;

        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          res.status(400).json({ error: 'Request body must be a JSON object' });
          return;
        }

        const { topic, platforms: platformsRaw } = body as Record<
          string,
          unknown
        >;
        if (typeof topic !== 'string' || topic.trim().length === 0) {
          res.status(400).json({ error: 'topic is required (non-empty string)' });
          return;
        }
        const platforms = normalizePlatformIds(platformsRaw);
        if (platforms === null) {
          res.status(400).json({
            error: `platforms is required (non-empty array of: ${PLATFORM_IDS.join(', ')})`,
          });
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
          platforms,
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

  app.get(
    '/tenants/:tenantId/articles/:articleId',
    (req: Request, res: Response) => {
      const tenantId = tenantIdFromParams(req);
      const articleId = articleIdFromParams(req);
      if (tenantId.trim().length === 0 || articleId.trim().length === 0) {
        res.status(400).json({
          error: 'tenantId and articleId are required (non-empty strings)',
        });
        return;
      }

      const history = articleService.getPublishHistory(tenantId, articleId);
      if (!history) {
        res.status(404).json({ error: 'Article publish history not found' });
        return;
      }
      res.status(200).json(history);
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
