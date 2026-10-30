import type {
  PlatformId,
  PublishPostResult,
  UploadMediaResult,
} from '../platforms/types';

export interface MockCmsKey {
  platformId: PlatformId;
  tenantId: string;
  articleId: string;
}

function keyOf({ platformId, tenantId, articleId }: MockCmsKey): string {
  return `${platformId}:${tenantId}:${articleId}`;
}

/**
 * In-memory Mock CMS so upload/publish can be looked up on activity retry.
 * Process-wide singleton so Worker 1 and Worker 2 share the same records.
 */
export class MockCms {
  private readonly media = new Map<string, UploadMediaResult>();
  private readonly posts = new Map<string, PublishPostResult>();

  putMedia(key: MockCmsKey, result: UploadMediaResult): void {
    this.media.set(keyOf(key), result);
  }

  findMedia(key: MockCmsKey): UploadMediaResult | null {
    return this.media.get(keyOf(key)) ?? null;
  }

  putPost(key: MockCmsKey, result: PublishPostResult): void {
    this.posts.set(keyOf(key), result);
  }

  findPost(key: MockCmsKey): PublishPostResult | null {
    return this.posts.get(keyOf(key)) ?? null;
  }

  clear(): void {
    this.media.clear();
    this.posts.clear();
  }
}

export const mockCms = new MockCms();
