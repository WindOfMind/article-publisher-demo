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

## Failure handling

Temporal owns durable execution of `articleWorkflow`. If a worker process dies mid-flight (OOM, crash, restart), incomplete activities are not lost:

- Completed activity results are already recorded in workflow history, so text/image generation is not re-run after a crash.
- In-flight activities (e.g. media upload) are cancelled or timed out via heartbeats, then **retried on another worker** on the same task queue.
- Publish uses unbounded activity retries with `nextRetryDelay` for transient rate limits, so a temporary CMS throttle does not fail the article permanently.

Together this gives a publish guarantee: once `publishArticle` starts a workflow, Temporal continues until every listed platform succeeds or hits a terminal (non-retryable / max-attempts) failure — even across machine crashes. The crash harness in `test/fullFlow.integration.test.ts` hard-kills Worker 1 mid-upload and proves Worker 2 finishes every article with live URLs.

Terminal failures only are persisted as `failed` via `recordArticlePublishActivity` (cancellations from worker restart are not treated as publish outcomes).

## Idempotency

Side effects stay safe under Temporal retries and crash recovery:

- **LLM gateway** — topic is normalized and hashed (`SHA-256`); cache hits reuse prior text/image bytes and skip the provider.
- **CMS media upload** — on `attempt > 1`, `findMedia` returns an existing `cmsMediaId` if a prior attempt already succeeded at the CMS but failed to report back to Temporal.
- **CMS publish** — on `attempt > 1`, `findPost` returns an existing `liveUrl` before consuming rate-limit tokens, avoiding duplicate posts.
- **Publish history** — `recordArticlePublishActivity` upserts the same platform entry on retry.

Adapters are written so real CMS APIs that support idempotency keys (e.g. Shopify `Idempotency-Key`) can be wired the same way.

## Rate limiting

`publishCmsPostActivity` enforces dual token-bucket limits via `mockRateLimiter`:

| Scope        | Limit | Key shape                                         |
| ------------ | ----- | ------------------------------------------------- |
| Per tenant   | 2 RPS | `tenant:{tenantId}`                               |
| Per platform | 5 RPS | `platform:{platform}` (shared across all tenants) |

When a bucket is exhausted, the activity throws a retryable `ApplicationFailure` (`TENANT_RATE_LIMITED` / `PLATFORM_RATE_LIMITED`) with `nextRetryDelay: 1 second`. The workflow’s publish Retry Policy uses unbounded attempts and a 1s backoff so Temporal schedules the next try after the delay instead of failing the workflow.

## Image generation cost optimisation

Hero images go through the LLM gateway (`src/infra/llmGateway.ts`) so billable image-provider calls are avoided whenever possible:

1. **Prompt identity** — the topic is normalized (trim, lowercase, collapse whitespace) and hashed with SHA-256 to a stable cache key. Equivalent prompts (`"SEO Topic One"` / `"  seo  topic   one  "`) share one cache entry.
2. **Cache before provider** — on a hit, `generateImageActivity` returns cached WebP bytes and records `imageCacheHits` instead of calling the provider. Only cache misses increment `imageCalls`.
3. **Generate once per article** — the workflow runs image generation once, stores bytes in Mock S3 (`imageS3Uri`), and reuses that URI for every platform upload. Multi-platform publish does not multiply image cost.
4. **Crash durability** — after a successful image activity, Temporal history retains the result; a worker restart does not regenerate or re-bill the image.

The harness asserts `imageCalls ===` article batch size after a mid-flight worker kill, confirming zero duplicate image payment.

## Cost tracking

`metricsService` (`src/services/metrics/metricsService.ts`) counts billable work and CMS side effects in-process:

| Metric           | Meaning                                                |
| ---------------- | ------------------------------------------------------ |
| `llmCalls`       | Billable LLM text-provider invocations (cache misses)  |
| `textCacheHits`  | Text served from gateway cache (no provider cost)      |
| `imageCalls`     | Billable LLM image-provider invocations (cache misses) |
| `imageCacheHits` | Image served from gateway cache                        |
| `cmsUploads`     | CMS media upload calls that actually ran               |
| `cmsPublishes`   | CMS publish calls that actually ran                    |

Cache hits and retry-time `findMedia` / `findPost` lookups do not increment the corresponding billable counters. The crash harness asserts zero duplicate LLM/image payment after Worker 1 dies (`llmCalls` / `imageCalls` equal the article batch size).

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
