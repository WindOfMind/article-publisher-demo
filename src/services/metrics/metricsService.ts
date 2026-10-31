/**
 * In-process metrics for billable LLM/image work and CMS side effects.
 * Shared across Worker 1 / Worker 2 in the crash harness so we can assert
 * zero duplicate LLM/image payments after a mid-flight worker death.
 *
 * `llmCalls` counts billable LLM text-provider invocations (cache misses).
 * `textCacheHits` counts gateway text cache hits that skipped the provider.
 * `imageCalls` counts billable LLM image-provider invocations (cache misses).
 * `imageCacheHits` counts gateway image cache hits that skipped the provider.
 */
export interface MetricsSnapshot {
  llmCalls: number;
  textCacheHits: number;
  imageCalls: number;
  imageCacheHits: number;
  cmsUploads: number;
  cmsPublishes: number;
}

export interface MetricsService {
  recordLlmCall(): void;
  recordTextCacheHit(): void;
  recordImageCall(): void;
  recordImageCacheHit(): void;
  recordCmsUpload(): void;
  recordCmsPublish(): void;
  reset(): void;
  snapshot(): MetricsSnapshot;
}

export class InMemoryMetricsService implements MetricsService {
  private counts: MetricsSnapshot = emptySnapshot();

  recordLlmCall(): void {
    this.counts.llmCalls += 1;
  }

  recordTextCacheHit(): void {
    this.counts.textCacheHits += 1;
  }

  recordImageCall(): void {
    this.counts.imageCalls += 1;
  }

  recordImageCacheHit(): void {
    this.counts.imageCacheHits += 1;
  }

  recordCmsUpload(): void {
    this.counts.cmsUploads += 1;
  }

  recordCmsPublish(): void {
    this.counts.cmsPublishes += 1;
  }

  reset(): void {
    this.counts = emptySnapshot();
  }

  snapshot(): MetricsSnapshot {
    return { ...this.counts };
  }
}

function emptySnapshot(): MetricsSnapshot {
  return {
    llmCalls: 0,
    textCacheHits: 0,
    imageCalls: 0,
    imageCacheHits: 0,
    cmsUploads: 0,
    cmsPublishes: 0,
  };
}

/** Shared default used by activity factories and the crash harness. */
export const metricsService: MetricsService = new InMemoryMetricsService();
