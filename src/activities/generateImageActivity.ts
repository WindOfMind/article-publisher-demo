import { Context, log } from '@temporalio/activity';
import { llmGateway } from '../infra/llmGateway';
import { mockS3 } from '../infra/mockS3';
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
 * The gateway normalizes + hashes the topic and serves from cache when possible
 * so repeated prompts do not incur another billable provider call.
 * Heartbeats while generating / copying; stores bytes in Mock S3 (claim-check).
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

    const { imageBytes, cacheHit, cacheKey } = await llmGateway.generateImage({
      prompt: input.topic,
    });

    if (cacheHit) {
      metrics.recordImageCacheHit();
      log.info('Image served from LLM gateway cache', {
        articleId: input.articleId,
        cacheKey,
      });
    } else {
      metrics.recordImageCall();
      log.info('Image generated via LLM provider and cached', {
        articleId: input.articleId,
        cacheKey,
      });
    }

    ctx.heartbeat({ phase: 'store', cacheHit, cacheKey });

    const imageS3Uri = await mockS3.put(
      `articles/${input.tenantId}/${input.articleId}/hero.webp`,
      Buffer.from(imageBytes),
    );

    log.info('Article image stored', {
      articleId: input.articleId,
      imageS3Uri,
      cacheHit,
    });

    return { imageS3Uri, cacheHit };
  };
}

export const generateImageActivity = createGenerateImageActivity();
