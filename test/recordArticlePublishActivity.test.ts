import { MockActivityEnvironment } from '@temporalio/testing';
import { createRecordArticlePublishActivity } from '../src/activities/recordArticlePublishActivity';
import type { ArticlePublishHistory } from '../src/services/article/articleStorage';

describe('recordArticlePublishActivity', () => {
  const baseHistory: ArticlePublishHistory = {
    articleId: 'art-1',
    tenantId: 'tenant-a',
    topic: 'Topic',
    workflowId: 'wf-1',
    runId: 'run-1',
    entries: [],
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
  };

  it('returns recorded:true when savePublishResult updates history', async () => {
    const savePublishResult = jest.fn().mockReturnValue(baseHistory);
    const activity = createRecordArticlePublishActivity({ savePublishResult });

    const result = await new MockActivityEnvironment().run(activity, {
      articleId: 'art-1',
      tenantId: 'tenant-a',
      platform: 'shopify' as const,
      status: 'published' as const,
      liveUrl: 'https://tenant-a.myshopify.com/blogs/news/x',
    });

    expect(result).toEqual({ recorded: true });
    expect(savePublishResult).toHaveBeenCalledWith({
      articleId: 'art-1',
      tenantId: 'tenant-a',
      platform: 'shopify',
      status: 'published',
      liveUrl: 'https://tenant-a.myshopify.com/blogs/news/x',
      error: undefined,
    });
  });

  it('returns recorded:false when savePublishResult finds no history', async () => {
    const savePublishResult = jest.fn().mockReturnValue(null);
    const activity = createRecordArticlePublishActivity({ savePublishResult });

    const result = await new MockActivityEnvironment().run(activity, {
      articleId: 'missing',
      tenantId: 'tenant-a',
      platform: 'wix' as const,
      status: 'failed' as const,
      error: 'gave up',
    });

    expect(result).toEqual({ recorded: false });
    expect(savePublishResult).toHaveBeenCalledWith({
      articleId: 'missing',
      tenantId: 'tenant-a',
      platform: 'wix',
      status: 'failed',
      liveUrl: undefined,
      error: 'gave up',
    });
  });
});
