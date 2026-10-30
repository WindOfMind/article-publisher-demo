import { Context, log } from '@temporalio/activity';
import { mockS3 } from '../infra/mockS3';
import { metrics } from './metrics';

export interface GenerateImageInput {
  articleId: string;
  tenantId: string;
  topic: string;
}

export interface GenerateImageResult {
  imageS3Uri: string;
}

/** Minimal RIFF/WEBP header bytes used as a stand-in binary payload. */
const MOCK_WEBP: Buffer = Buffer.from([
  0x52,
  0x49,
  0x46,
  0x46, // "RIFF"
  0x1a,
  0x00,
  0x00,
  0x00, // size
  0x57,
  0x45,
  0x42,
  0x50, // "WEBP"
  0x56,
  0x50,
  0x38,
  0x20, // "VP8 "
  0x0e,
  0x00,
  0x00,
  0x00,
  0x30,
  0x01,
  0x00,
  0x9d,
  0x01,
  0x2a,
  0x01,
  0x00,
  0x01,
  0x00,
]);

/**
 * Simulates image generation. Heartbeats while "rendering", stores a mock
 * WebP binary in Mock S3, and returns only the claim-check URI.
 */
export async function generateImageActivity(
  input: GenerateImageInput,
): Promise<GenerateImageResult> {
  log.info('Generating article image', {
    articleId: input.articleId,
    tenantId: input.tenantId,
    topic: input.topic,
  });

  metrics.imageCalls += 1;

  const ctx = Context.current();

  // Pulse heartbeats while simulating a longer-running image job.
  for (let i = 0; i < 3; i++) {
    ctx.heartbeat({ phase: 'render', step: i + 1, topic: input.topic });
    await delay(30);
  }

  const imageS3Uri = await mockS3.put(
    `articles/${input.tenantId}/${input.articleId}/hero.webp`,
    Buffer.from(MOCK_WEBP),
  );

  log.info('Article image stored', { articleId: input.articleId, imageS3Uri });

  return { imageS3Uri };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
