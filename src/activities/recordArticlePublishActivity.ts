import { log } from '@temporalio/activity';
import type { PlatformId } from '../platforms/types';
import {
  articlePublishPersistence,
  type ArticleService,
} from '../services/articleService';
import type { PublishStatus } from '../services/articleStorage';

export interface RecordArticlePublishInput {
  articleId: string;
  tenantId: string;
  platform: PlatformId;
  status: Exclude<PublishStatus, 'pending'>;
  liveUrl?: string | null;
  error?: string | null;
}

export interface RecordArticlePublishResult {
  recorded: boolean;
}

/**
 * Persists per-platform publish outcome via the article service.
 * Idempotent upsert: retries overwrite the same platform entry.
 */
export function createRecordArticlePublishActivity(
  articleService: Pick<
    ArticleService,
    'savePublishResult'
  > = articlePublishPersistence,
) {
  return async function recordArticlePublishActivity(
    input: RecordArticlePublishInput,
  ): Promise<RecordArticlePublishResult> {
    log.info('Saving publish result via article service', {
      articleId: input.articleId,
      tenantId: input.tenantId,
      platform: input.platform,
      status: input.status,
      liveUrl: input.liveUrl ?? null,
    });

    const updated = articleService.savePublishResult({
      articleId: input.articleId,
      tenantId: input.tenantId,
      platform: input.platform,
      status: input.status,
      liveUrl: input.liveUrl,
      error: input.error,
    });

    if (!updated) {
      log.warn('No publish history found to update', {
        articleId: input.articleId,
        tenantId: input.tenantId,
        platform: input.platform,
      });
      return { recorded: false };
    }

    return { recorded: true };
  };
}

export const recordArticlePublishActivity = createRecordArticlePublishActivity();
