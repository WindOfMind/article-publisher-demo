import { Context, log } from '@temporalio/activity';
import { llmGateway } from '../infra/llmGateway';
import {
  metricsService,
  type MetricsService,
} from '../services/metrics/metricsService';

export interface GenerateImageInput {
  articleId: string;
  tenantId: string;
  topic: string;
}

export interface GenerateImageResult {
  imageS3Uri: string;
  /** Present for observability / tests; not required by the workflow. */
  cacheHit: boolean;
}

/**
 * Generates an article hero image via the LLM gateway.
 * The gateway normalizes + hashes the topic, stores WebP in Mock S3
 * (claim-check), and returns a download URI — from cache when possible so
 * repeated prompts do not incur another billable provider call.
 */
export function createGenerateImageActivity(
  metrics: MetricsService = metricsService,
) {
  return async function generateImageActivity(
    input: GenerateImageInput,
  ): Promise<GenerateImageResult> {
    log.info('Generating article image', {
      articleId: input.articleId,
      tenantId: input.tenantId,
      topic: input.topic,
    });

    const ctx = Context.current();
    ctx.heartbeat({ phase: 'gateway', topic: input.topic });

    const { imageS3Uri, cacheHit, cacheKey } = await llmGateway.generateImage({
      prompt: input.topic,
    });

    if (cacheHit) {
      metrics.recordImageCacheHit();
      log.info('Image served from LLM gateway cache', {
        articleId: input.articleId,
        cacheKey,
        imageS3Uri,
      });
    } else {
      metrics.recordImageCall();
      log.info('Image generated via LLM provider and stored in S3', {
        articleId: input.articleId,
        cacheKey,
        imageS3Uri,
      });
    }

    ctx.heartbeat({ phase: 'done', cacheHit, cacheKey, imageS3Uri });

    return { imageS3Uri, cacheHit };
  };
}

export const generateImageActivity = createGenerateImageActivity();