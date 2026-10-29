/**
 * Global in-process metrics counters.
 * Shared across Worker 1 / Worker 2 in the crash harness so we can assert
 * zero duplicate LLM/image payments after a mid-flight worker death.
 */
export interface MetricsSnapshot {
  llmCalls: number;
  imageCalls: number;
  cmsUploads: number;
  cmsPublishes: number;
}

export const metrics: MetricsSnapshot = {
  llmCalls: 0,
  imageCalls: 0,
  cmsUploads: 0,
  cmsPublishes: 0,
};

export function resetMetrics(): void {
  metrics.llmCalls = 0;
  metrics.imageCalls = 0;
  metrics.cmsUploads = 0;
  metrics.cmsPublishes = 0;
}
