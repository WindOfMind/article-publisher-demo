# SEO Article Publisher Demo

Self-contained Temporal PoC for an SEO article publishing pipeline. Runs entirely locally via `@temporalio/testing` — no Redis, Postgres, or real S3 required.

Diagram: https://excalidraw.com/#json=1czBNeuUHZUpKTX6Qfkd6,47UoavjMlSc1LzmMvdT-vA

## Pipeline

```
Article -> Text (LLM) ∥ Image → CMS Media Upload → CMS Publish
```

1. **generateTextActivity** / **generateImageActivity** — run in parallel. Text: mock LLM call; stores markdown in Mock S3; returns `textS3Uri` (claim-check). Image: mock render with heartbeats; stores WebP in Mock S3; returns `imageS3Uri`.
2. **uploadCmsMediaActivity** — fetches image from Mock S3; returns `cmsMediaId`.
3. **publishCmsPostActivity** — dual rate limits: per-tenant (2 RPS) and per-platform (5 RPS total across all tenants). On exhaustion throws retryable `TENANT_RATE_LIMITED` / `PLATFORM_RATE_LIMITED` with `nextRetryDelay: 1s` so the activity Retry Policy backs off and retries.

Large payloads never travel through Temporal activity return values — only S3 URIs and CMS IDs do.

## Layout

```
src/
  services/
    articleService.ts    # Control layer: start articleWorkflow per tenant
    mockS3.ts            # In-memory Map store (claim-check)
    mockRateLimiter.ts   # Token buckets keyed by tenant + platform
  api/
    publishServer.ts     # Express POST /tenants/:tenantId/articles
    main.ts              # Connect Temporal client + listen (PORT=3000)
  activities/
    generateTextActivity.ts
    generateImageActivity.ts
    uploadCmsMediaActivity.ts
    publishCmsPostActivity.ts
    metrics.ts           # llmCalls / imageCalls / cmsUploads / cmsPublishes
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
npm run publish:api   # POST http://localhost:3000/tenants/:tenantId/articles
```

Body: `{ "articleId": "article-01", "topic": "SEO Topic 1" }` → `202` `{ workflowId, runId }`.

## Crash harness

`test/fullFlow.integration.test.ts` proves durability and zero duplicate payment.
