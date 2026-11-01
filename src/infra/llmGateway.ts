import { createHash } from 'node:crypto';
import { MockS3, mockS3 } from './mockS3';

/**
 * Collapse prompt/topic variants that should share one generated result
 * (case, surrounding whitespace, repeated spaces).
 */
export function normalizePrompt(prompt: string): string {
  return prompt.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Stable cache key derived from a normalized prompt. */
export function hashPrompt(normalizedPrompt: string): string {
  return createHash('sha256').update(normalizedPrompt, 'utf8').digest('hex');
}

export function promptCacheKey(prompt: string): string {
  return hashPrompt(normalizePrompt(prompt));
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

export interface GenerateTextRequest {
  prompt: string;
}

export interface GenerateTextResponse {
  markdown: string;
  cacheHit: boolean;
  cacheKey: string;
}

export interface GenerateImageRequest {
  prompt: string;
}

export interface GenerateImageResponse {
  /** Claim-check URI; bytes live in Mock S3 (generated or cache hit). */
  imageS3Uri: string;
  cacheHit: boolean;
  cacheKey: string;
}

export interface LlmTextProvider {
  generateText(prompt: string): Promise<string>;
}

export interface LlmImageProvider {
  generateImage(prompt: string): Promise<Buffer>;
}

/**
 * Mock LLM text provider. Simulates paid generation latency; each call is a
 * billable event that the gateway avoids on cache hits.
 */
export class MockLlmTextProvider implements LlmTextProvider {
  async generateText(prompt: string): Promise<string> {
    await delay(40);
    return [
      `# ${prompt}`,
      '',
      `This is mock SEO content about **${prompt}**.`,
      '',
      '## Key takeaways',
      '',
      '- Point one',
      '- Point two',
      '- Point three',
    ].join('\n');
  }
}

/**
 * Mock LLM image provider. Simulates paid generation latency; each call is a
 * billable event that the gateway avoids on cache hits.
 */
export class MockLlmImageProvider implements LlmImageProvider {
  async generateImage(prompt: string): Promise<Buffer> {
    await delay(40);
    // Embed a short digest of the prompt so distinct topics produce distinct
    // buffers while staying a valid-looking WebP stand-in.
    const digest = createHash('sha256')
      .update(prompt, 'utf8')
      .digest()
      .subarray(0, 8);
    return Buffer.concat([MOCK_WEBP, digest]);
  }
}

/**
 * Cost-saving LLM gateway: normalize → hash → cache lookup → provider on miss.
 * Text results are cached in-memory; images are stored in Mock S3 and the
 * cache holds download URIs so repeated topics skip the LLM and never move
 * bytes through the gateway response.
 */
export class LlmGateway {
  private readonly textCache = new Map<string, string>();
  /** Prompt cache key → Mock S3 URI for the generated WebP. */
  private readonly imageCache = new Map<string, string>();

  constructor(
    private readonly textProvider: LlmTextProvider = new MockLlmTextProvider(),
    private readonly imageProvider: LlmImageProvider = new MockLlmImageProvider(),
    private readonly objectStore: MockS3 = mockS3,
  ) {}

  async generateText(
    request: GenerateTextRequest,
  ): Promise<GenerateTextResponse> {
    const cacheKey = promptCacheKey(request.prompt);
    const cached = this.textCache.get(cacheKey);
    if (cached !== undefined) {
      return {
        markdown: cached,
        cacheHit: true,
        cacheKey,
      };
    }

    const markdown = await this.textProvider.generateText(
      normalizePrompt(request.prompt),
    );
    this.textCache.set(cacheKey, markdown);

    return {
      markdown,
      cacheHit: false,
      cacheKey,
    };
  }

  async generateImage(
    request: GenerateImageRequest,
  ): Promise<GenerateImageResponse> {
    const cacheKey = promptCacheKey(request.prompt);
    const cachedUri = this.imageCache.get(cacheKey);
    if (cachedUri !== undefined) {
      return {
        imageS3Uri: cachedUri,
        cacheHit: true,
        cacheKey,
      };
    }

    const imageBytes = await this.imageProvider.generateImage(
      normalizePrompt(request.prompt),
    );
    const imageS3Uri = await this.objectStore.put(
      `llm-cache/images/${cacheKey}.webp`,
      Buffer.from(imageBytes),
    );
    this.imageCache.set(cacheKey, imageS3Uri);

    return {
      imageS3Uri,
      cacheHit: false,
      cacheKey,
    };
  }

  cacheSize(): number {
    return this.textCache.size + this.imageCache.size;
  }

  clear(): void {
    this.textCache.clear();
    this.imageCache.clear();
  }
}

/** Process-wide singleton so Worker 1 and Worker 2 share the same LLM caches. */
export const llmGateway = new LlmGateway();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
