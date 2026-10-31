import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { createArticleServer } from '../src/server/articleServer';
import type {
  ArticleService,
  PublishArticleResult,
} from '../src/services/article/articleService';
import type { ArticlePublishHistory } from '../src/services/article/articleStorage';

function createMockArticleService(
  overrides: Partial<ArticleService> = {},
): ArticleService {
  return {
    publishArticle: jest.fn(),
    getPublishHistory: jest.fn(),
    savePublishResult: jest.fn(),
    ...overrides,
  } as unknown as ArticleService;
}

async function withServer(
  app: Express,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

describe('createArticleServer', () => {
  it('returns 202 with ids on successful POST', async () => {
    const result: PublishArticleResult = {
      articleId: 'art-1',
      workflowId: 'wf-1',
      runId: 'run-1',
    };
    const publishArticle = jest.fn().mockResolvedValue(result);
    const app = createArticleServer(
      createMockArticleService({ publishArticle }),
    );

    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/tenants/tenant-a/articles`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          topic: 'SEO Topic',
          platforms: ['shopify', 'wix'],
        }),
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual(result);
      expect(publishArticle).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        topic: 'SEO Topic',
        platforms: ['shopify', 'wix'],
      });
    });
  });

  it('dedupes platforms before calling the service', async () => {
    const publishArticle = jest.fn().mockResolvedValue({
      articleId: 'art-2',
      workflowId: 'wf-2',
      runId: 'run-2',
    });
    const app = createArticleServer(
      createMockArticleService({ publishArticle }),
    );

    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/tenants/tenant-a/articles`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          topic: 'Dedupe',
          platforms: ['wix', 'shopify', 'wix'],
        }),
      });
      expect(res.status).toBe(202);
      expect(publishArticle).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        topic: 'Dedupe',
        platforms: ['wix', 'shopify'],
      });
    });
  });

  it('returns 400 for invalid POST bodies', async () => {
    const app = createArticleServer(createMockArticleService());

    await withServer(app, async (baseUrl) => {
      const post = (body: string) =>
        fetch(`${baseUrl}/tenants/tenant-a/articles`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });

      const arrayBody = await post('[]');
      expect(arrayBody.status).toBe(400);
      expect(((await arrayBody.json()) as { error: string }).error).toContain(
        'JSON object',
      );

      const cases: Array<{ body: unknown; errorIncludes: string }> = [
        { body: { topic: '', platforms: ['shopify'] }, errorIncludes: 'topic' },
        {
          body: { topic: '  ', platforms: ['shopify'] },
          errorIncludes: 'topic',
        },
        {
          body: { topic: 'Ok', platforms: [] },
          errorIncludes: 'platforms',
        },
        {
          body: { topic: 'Ok', platforms: ['wordpress'] },
          errorIncludes: 'platforms',
        },
        {
          body: { topic: 'Ok', platforms: 'shopify' },
          errorIncludes: 'platforms',
        },
      ];

      for (const { body, errorIncludes } of cases) {
        const res = await post(JSON.stringify(body));
        expect(res.status).toBe(400);
        const json = (await res.json()) as { error: string };
        expect(json.error.toLowerCase()).toContain(errorIncludes.toLowerCase());
      }
    });
  });

  it('returns 500 when publishArticle throws', async () => {
    const publishArticle = jest
      .fn()
      .mockRejectedValue(new Error('temporal down'));
    const app = createArticleServer(
      createMockArticleService({ publishArticle }),
    );

    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/tenants/tenant-a/articles`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          topic: 'Boom',
          platforms: ['shopify'],
        }),
      });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'temporal down' });
    });
  });

  it('returns 400 for invalid JSON body', async () => {
    const app = createArticleServer(createMockArticleService());

    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/tenants/tenant-a/articles`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not-json',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid JSON body' });
    });
  });

  it('GET returns 200 history or 404 when missing', async () => {
    const history: ArticlePublishHistory = {
      articleId: 'art-9',
      tenantId: 'tenant-a',
      topic: 'Stored',
      workflowId: 'wf-9',
      runId: 'run-9',
      entries: [
        {
          platform: 'shopify',
          status: 'pending',
          liveUrl: null,
          error: null,
          updatedAt: '2020-01-01T00:00:00.000Z',
        },
      ],
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    };
    const getPublishHistory = jest
      .fn()
      .mockImplementation((_tenantId: string, articleId: string) =>
        articleId === 'art-9' ? history : null,
      );
    const app = createArticleServer(
      createMockArticleService({ getPublishHistory }),
    );

    await withServer(app, async (baseUrl) => {
      const found = await fetch(`${baseUrl}/tenants/tenant-a/articles/art-9`);
      expect(found.status).toBe(200);
      expect(await found.json()).toEqual(history);

      const missing = await fetch(
        `${baseUrl}/tenants/tenant-a/articles/missing`,
      );
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({
        error: 'Article publish history not found',
      });
    });
  });

  it('returns 404 for unknown routes', async () => {
    const app = createArticleServer(createMockArticleService());

    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/nope`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    });
  });
});
