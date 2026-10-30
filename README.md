# SEO Article Publisher Demo

Self-contained Temporal PoC for an SEO article publishing pipeline. Runs entirely locally via `@temporalio/testing` — no Redis, Postgres, or real S3 required.

Diagram: https://excalidraw.com/#json=BvfLeXX9qyqCkJ7rWQAcg,PKqk1F-vFp02OC4tAfLekA

## Pipeline

```
Article (platforms[]) -> Text (LLM) ∥ Image → per platform: Media Upload → Publish
```

1. **generateTextActivity** / **generateImageActivity** — run in parallel once per article. Both go through the **LLM gateway** (normalize topic → SHA-256 cache key → cache hit or mocked provider). Text stores markdown in Mock S3 and returns `textS3Uri` (claim-check); image stores WebP and returns `imageS3Uri`. Repeated / equivalent prompts skip the provider and do not increment `llmCalls` / `imageCalls`.
2. **uploadCmsMediaActivity** — for each platform in the request/config, fetches image from Mock S3 and uploads via that platform's adaptor; returns `cmsMediaId`. On retry (`attempt > 1`), looks up existing CMS media first so a prior success that failed to report does not upload again.
3. **publishCmsPostActivity** — dual rate limits: per-tenant (2 RPS) and per-platform (5 RPS total across all tenants on that platform). Publishes via the same adaptor. On exhaustion throws retryable `TENANT_RATE_LIMITED` / `PLATFORM_RATE_LIMITED` with `nextRetryDelay: 1s` so the activity Retry Policy backs off and retries. On retry (`attempt > 1`), looks up an existing post first (before rate-limit tokens) and returns its `liveUrl` when found.
4. **recordArticlePublishActivity** — saves per-platform outcome (`published` + `liveUrl`, or `failed`) via `ArticleService.savePublishResult`. `ArticleService.publishArticle` seeds entries as `pending` when the workflow starts.

The same generated content is reused across every target platform. Large payloads never travel through Temporal activity return values — only S3 URIs and CMS IDs do.

## Platforms

Each article request lists one or more `platforms`. Adaptors implement `uploadMedia` + `publishPost`:

| Platform  | Adaptor                | Live URL shape                                  |
| --------- | ---------------------- | ----------------------------------------------- |
| `shopify` | `createShopifyAdapter` | `https://{tenant}.myshopify.com/blogs/news/...` |
| `wix`     | `createWixAdapter`     | `https://{tenant}.wixsite.com/blog/...`         |

Register new platforms in `src/platforms/registry.ts`.

## Layout

```
src/
  platforms/
    types.ts             # PlatformId, PlatformAdapter
    shopifyAdapter.ts    # Mock Shopify blog adaptor
    wixAdapter.ts        # Mock Wix blog adaptor
    registry.ts          # Lookup adaptor by platform
  infra/
    mockS3.ts            # In-memory Map store (claim-check)
    mockCms.ts           # In-memory media/post records for retry lookup
    mockRateLimiter.ts   # Token buckets keyed by tenant + platform
    llmGateway.ts        # Normalize/hash prompt cache + mocked text/image providers
  services/
    article/
      articleService.ts     # Control layer: start workflow + read publish history
      articleStorage.ts     # In-memory platform/URL/status history
  server/
    publishServer.ts     # Express POST + GET /tenants/:tenantId/articles
    main.ts              # Connect Temporal client + listen (PORT=3000)
  activities/
    generateTextActivity.ts
    generateImageActivity.ts
    uploadCmsMediaActivity.ts
    publishCmsPostActivity.ts
    recordArticlePublishActivity.ts
    metrics.ts           # llmCalls / textCacheHits / imageCalls / imageCacheHits / cmsUploads / cmsPublishes
  workflows/
    articleWorkflow.ts   # Orchestration; publish rate limits via activity retries
test/
  fullFlow.integration.test.ts  # Crash / recovery harness
```

## Prerequisites

- Node.js 18+
- npm

## Setup & run

```bash
npm install
npm test    # tsc + crash harness
```

`npm run build` compiles TypeScript to `dist/` only.

### Publish control API (optional)

Requires a Temporal server and a worker on task queue `article-publisher-poc`.

```bash
npm run build
npm run publish:server   # POST http://localhost:3000/tenants/:tenantId/articles
```

Body: `{ "articleId": "article-01", "topic": "SEO Topic 1", "platforms": ["shopify", "wix"] }` → `202` `{ workflowId, runId }`.

`GET /tenants/:tenantId/articles/:articleId` → `200` publish history (`entries[].platform`, `liveUrl`, `status`: `pending` | `published` | `failed`) or `404`.

`platforms` is a non-empty array of `shopify` and/or `wix`. One workflow generates content once and publishes to every listed platform.

## Crash harness

`test/fullFlow.integration.test.ts` proves durability and zero duplicate LLM/image payment when each article fans out to both platforms.
