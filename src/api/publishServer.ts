import http from 'node:http';
import type { ArticleService } from '../services/articleService';

const TENANT_ARTICLES_PATH =
  /^\/tenants\/([^/]+)\/articles\/?$/;

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw.length === 0) {
    return {};
  }
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Thin HTTP control surface that imitates an app layer driving article publish.
 * POST /tenants/:tenantId/articles  { articleId, topic } → 202 { workflowId, runId }
 */
export function createPublishServer(
  articleService: ArticleService,
): http.Server {
  return http.createServer((req, res) => {
    void handleRequest(req, res, articleService);
  });
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  articleService: ArticleService,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = TENANT_ARTICLES_PATH.exec(url.pathname);

    if (req.method !== 'POST' || match === null) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    const tenantId = decodeURIComponent(match[1]!);
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, {
        error: err instanceof Error ? err.message : 'Invalid JSON body',
      });
      return;
    }

    const articleId = body.articleId;
    const topic = body.topic;
    if (typeof articleId !== 'string' || articleId.trim().length === 0) {
      sendJson(res, 400, { error: 'articleId is required (non-empty string)' });
      return;
    }
    if (typeof topic !== 'string' || topic.trim().length === 0) {
      sendJson(res, 400, { error: 'topic is required (non-empty string)' });
      return;
    }
    if (tenantId.trim().length === 0) {
      sendJson(res, 400, { error: 'tenantId is required (non-empty string)' });
      return;
    }

    const result = await articleService.publishArticle({
      tenantId,
      articleId,
      topic,
    });
    sendJson(res, 202, result);
  } catch (err) {
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
