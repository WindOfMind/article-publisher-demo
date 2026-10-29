import {
  createCmsPlatformClient,
  type CmsPlatformClient,
} from '../clients/cmsPlatformClient';
import { mockS3 } from '../services/mockS3';
import { metrics } from './metrics';

export interface UploadCmsMediaInput {
  articleId: string;
  tenantId: string;
  imageS3Uri: string;
}

export interface UploadCmsMediaResult {
  cmsMediaId: string;
}

/**
 * Fetches the image from Mock S3 (claim-check) and uploads it via the CMS
 * platform client. Returns only the CMS media id.
 */
export function createUploadCmsMediaActivity(client: CmsPlatformClient) {
  return async function uploadCmsMediaActivity(
    input: UploadCmsMediaInput,
  ): Promise<UploadCmsMediaResult> {
    metrics.cmsUploads += 1;

    const imageData = await mockS3.get(input.imageS3Uri);
    return client.uploadMedia({
      articleId: input.articleId,
      tenantId: input.tenantId,
      imageData,
    });
  };
}

export const uploadCmsMediaActivity = createUploadCmsMediaActivity(
  createCmsPlatformClient(),
);
