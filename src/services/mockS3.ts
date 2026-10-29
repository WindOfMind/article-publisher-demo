/**
 * In-memory Mock S3 used for the Claim-Check pattern.
 * Large payloads (markdown, images) live here; Temporal activities only
 * exchange lightweight `s3://mock-bucket/...` URIs.
 */
const BUCKET = 'mock-bucket';
const URI_PREFIX = `s3://${BUCKET}/`;

export class MockS3 {
  private readonly store = new Map<string, Buffer | string>();

  async put(key: string, data: Buffer | string): Promise<string> {
    const normalizedKey = key.replace(/^\/+/, '');
    this.store.set(normalizedKey, data);
    return `${URI_PREFIX}${normalizedKey}`;
  }

  async get(uri: string): Promise<Buffer | string> {
    if (!uri.startsWith(URI_PREFIX)) {
      throw new Error(`Invalid mock S3 URI: ${uri}`);
    }
    const key = uri.slice(URI_PREFIX.length);
    const value = this.store.get(key);
    if (value === undefined) {
      throw new Error(`Object not found in mock S3: ${uri}`);
    }
    return value;
  }

  size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }
}

/** Process-wide singleton so Worker 1 and Worker 2 share the same store. */
export const mockS3 = new MockS3();
