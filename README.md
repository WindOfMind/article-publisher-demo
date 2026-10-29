# SEO Article Publisher Demo

Self-contained Temporal PoC for an SEO article publishing pipeline. Runs entirely locally via `@temporalio/testing` — no Redis, Postgres, or real S3 required.

Diagram: https://excalidraw.com/#json=1czBNeuUHZUpKTX6Qfkd6,47UoavjMlSc1LzmMvdT-vA

## Pipeline

```
Article -> Text (LLM) ∥ Image → CMS Media Upload → CMS Publish
```

1. **generateTextActivity** / **generateImageActivity** — run in parallel. Text: mock LLM call; stores markdown in Mock S3; returns `textS3Uri` (claim-check). Image: mock render with heartbeats; stores WebP in Mock S3; returns `imageS3Uri`.
2. **uploadCmsMediaActivity** — fetches image from Mock S3; returns `cmsMediaId`.
3. **publishCmsPostActivity** — dual rate limits: per-tenant (2 RPS) and per-platform (5 RPS total across all tenants). On exhaustion throws `TENANT_RATE_LIMITED` or `PLATFORM_RATE_LIMITED`; the workflow sleeps 1s and retries without failing.

Large payloads never travel through Temporal activity return values — only S3 URIs and CMS IDs do.

## Layout

```
src/
  services/
    mockS3.ts            # In-memory Map store (claim-check)
    mockRateLimiter.ts   # Token buckets keyed by tenant + platform
  activities/
    generateTextActivity.ts
    generateImageActivity.ts
    uploadCmsMediaActivity.ts
    publishCmsPostActivity.ts
    metrics.ts           # llmCalls / imageCalls / cmsUploads / cmsPublishes
  workflows/
    articleWorkflow.ts   # Orchestration + cooperative rate-limit retry
  testHarness.ts         # Crash / recovery harness
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

## Crash harness

`src/testHarness.ts` proves durability and zero duplicate payment.
