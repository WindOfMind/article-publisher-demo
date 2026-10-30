import { log } from '@temporalio/activity';
import { llmGateway } from '../infra/llmGateway';
import { mockS3 } from '../infra/mockS3';
import { metrics } from './metrics';

export interface GenerateTextInput {
  articleId: string;
  tenantId: string;
  topic: string;
}

export interface GenerateTextResult {
  textS3Uri: string;
  /** Present for observability / tests; not required by the workflow. */
  cacheHit: boolean;
}

/**
 * Generates article markdown via the LLM gateway.
 * The gateway normalizes + hashes the topic and serves from cache when possible
 * so repeated prompts do not incur another billable provider call.
 * Stores markdown in Mock S3 (claim-check) and returns only the URI.
 */
export async function generateTextActivity(
  input: GenerateTextInput,
): Promise<GenerateTextResult> {
  log.info('Generating article text', {
    articleId: input.articleId,
    tenantId: input.tenantId,
    topic: input.topic,
  });

  const { markdown, cacheHit, cacheKey } = await llmGateway.generateText({
    prompt: input.topic,
  });

  if (cacheHit) {
    metrics.textCacheHits += 1;
    log.info('Text served from LLM gateway cache', {
      articleId: input.articleId,
      cacheKey,
    });
  } else {
    metrics.llmCalls += 1;
    log.info('Text generated via LLM provider and cached', {
      articleId: input.articleId,
      cacheKey,
    });
  }

  const textS3Uri = await mockS3.put(
    `articles/${input.tenantId}/${input.articleId}/content.md`,
    markdown,
  );

  log.info('Article text stored', {
    articleId: input.articleId,
    textS3Uri,
    cacheHit,
  });

  return { textS3Uri, cacheHit };
}
