export interface UploadMediaParams {
  articleId: string;
  tenantId: string;
  imageData: Buffer | string;
}

export interface UploadMediaResult {
  cmsMediaId: string;
}

/** Client for the external CMS platform (media upload, etc.). */
export interface CmsPlatformClient {
  uploadMedia(params: UploadMediaParams): Promise<UploadMediaResult>;
}

/**
 * Default mock CMS platform client. Completes uploads immediately so production
 * and non-harness paths are not tied to crash-test timing.
 */
export function createCmsPlatformClient(): CmsPlatformClient {
  return {
    async uploadMedia({
      articleId,
      tenantId,
      imageData,
    }: UploadMediaParams): Promise<UploadMediaResult> {
      const byteLength =
        typeof imageData === 'string'
          ? Buffer.byteLength(imageData)
          : imageData.byteLength;
      return {
        cmsMediaId: `cms-media-${tenantId}-${articleId}-${byteLength}`,
      };
    },
  };
}
