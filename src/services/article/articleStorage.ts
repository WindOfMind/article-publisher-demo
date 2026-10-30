import { randomUUID } from 'node:crypto';
import type { PlatformId } from '../../platforms/types';

export const PUBLISH_STATUSES = ['pending', 'published', 'failed'] as const;

export type PublishStatus = (typeof PUBLISH_STATUSES)[number];

export interface PlatformPublishEntry {
  platform: PlatformId;
  status: PublishStatus;
  /** Present once status is `published`. */
  liveUrl: string | null;
  /** Present when status is `failed`. */
  error: string | null;
  updatedAt: string;
}

export interface ArticlePublishHistory {
  articleId: string;
  tenantId: string;
  topic: string;
  /** Empty until Temporal workflow is started and bound. */
  workflowId: string;
  /** Empty until Temporal workflow is started and bound. */
  runId: string;
  entries: PlatformPublishEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface StartPublishHistoryInput {
  tenantId: string;
  topic: string;
  platforms: PlatformId[];
}

export interface BindWorkflowInput {
  tenantId: string;
  articleId: string;
  workflowId: string;
  runId: string;
}

export interface RecordPlatformPublishInput {
  articleId: string;
  tenantId: string;
  platform: PlatformId;
  status: Exclude<PublishStatus, 'pending'>;
  liveUrl?: string | null;
  error?: string | null;
}

function historyKey(tenantId: string, articleId: string): string {
  return `${tenantId}:${articleId}`;
}

/**
 * In-memory publish history for the demo control layer.
 * Process-wide singleton so the HTTP API and worker activities share state.
 */
export class ArticleStorage {
  private readonly history = new Map<string, ArticlePublishHistory>();

  /**
   * Creates a publish history row and assigns a new `articleId`.
   * Call `bindWorkflow` once the Temporal run has started.
   */
  create(input: StartPublishHistoryInput): ArticlePublishHistory {
    const now = new Date().toISOString();
    const articleId = randomUUID();
    const record: ArticlePublishHistory = {
      articleId,
      tenantId: input.tenantId,
      topic: input.topic,
      workflowId: '',
      runId: '',
      entries: input.platforms.map((platform) => ({
        platform,
        status: 'pending',
        liveUrl: null,
        error: null,
        updatedAt: now,
      })),
      createdAt: now,
      updatedAt: now,
    };
    this.history.set(historyKey(input.tenantId, articleId), record);
    return structuredClone(record);
  }

  bindWorkflow(input: BindWorkflowInput): ArticlePublishHistory | null {
    const key = historyKey(input.tenantId, input.articleId);
    const existing = this.history.get(key);
    if (!existing) {
      return null;
    }
    existing.workflowId = input.workflowId;
    existing.runId = input.runId;
    existing.updatedAt = new Date().toISOString();
    return structuredClone(existing);
  }

  recordPlatform(input: RecordPlatformPublishInput): ArticlePublishHistory | null {
    const key = historyKey(input.tenantId, input.articleId);
    const existing = this.history.get(key);
    if (!existing) {
      return null;
    }

    const now = new Date().toISOString();
    const entry = existing.entries.find((e) => e.platform === input.platform);
    if (!entry) {
      existing.entries.push({
        platform: input.platform,
        status: input.status,
        liveUrl: input.liveUrl ?? null,
        error: input.error ?? null,
        updatedAt: now,
      });
    } else {
      entry.status = input.status;
      entry.liveUrl = input.liveUrl ?? null;
      entry.error = input.error ?? null;
      entry.updatedAt = now;
    }
    existing.updatedAt = now;
    return structuredClone(existing);
  }

  get(tenantId: string, articleId: string): ArticlePublishHistory | null {
    const record = this.history.get(historyKey(tenantId, articleId));
    return record ? structuredClone(record) : null;
  }

  clear(): void {
    this.history.clear();
  }
}

export const articleStorage = new ArticleStorage();
