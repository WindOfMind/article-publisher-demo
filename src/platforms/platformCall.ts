import { log } from '@temporalio/activity';
import type { PlatformId } from './types';

export type PlatformOperation =
  | 'uploadMedia'
  | 'findMedia'
  | 'publishPost'
  | 'findPost';

export interface PlatformCallMeta {
  platformId: PlatformId;
  operation: PlatformOperation;
  articleId: string;
  tenantId: string;
}

/**
 * Runs a platform API call and logs any thrown error with call context,
 * then rethrows so Temporal can retry / fail the activity as usual.
 */
export async function platformCall<T>(
  meta: PlatformCallMeta,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    log.error('Platform call failed', {
      platformId: meta.platformId,
      operation: meta.operation,
      articleId: meta.articleId,
      tenantId: meta.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
