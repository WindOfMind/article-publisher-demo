import { createHash } from 'node:crypto';

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
  imageBytes: Buffer;
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
 * Text and image results are cached by prompt identity so repeated topics skip
 * the LLM.
 */
export class LlmGateway {
  private readonly textCache = new Map<string, string>();
  private readonly imageCache = new Map<string, Buffer>();

  constructor(
    private readonly textProvider: LlmTextProvider = new MockLlmTextProvider(),
    private readonly imageProvider: LlmImageProvider = new MockLlmImageProvider(),
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
    const cached = this.imageCache.get(cacheKey);
    if (cached !== undefined) {
      return {
        imageBytes: Buffer.from(cached),
        cacheHit: true,
        cacheKey,
      };
    }

    const imageBytes = await this.imageProvider.generateImage(
      normalizePrompt(request.prompt),
    );
    this.imageCache.set(cacheKey, Buffer.from(imageBytes));

    return {
      imageBytes,
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
