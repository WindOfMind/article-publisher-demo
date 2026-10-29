import { Context } from '@temporalio/activity';
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
 * Fetches the image from Mock S3 (claim-check) and "uploads" it to a mock CMS.
 * Intentionally slow so the crash harness can kill Worker 1 mid-pipeline
 * after text/image generation have already completed.
 */
export async function uploadCmsMediaActivity(
  input: UploadCmsMediaInput,
): Promise<UploadCmsMediaResult> {
  metrics.cmsUploads += 1;

  const imageData = await mockS3.get(input.imageS3Uri);
  const byteLength =
    typeof imageData === 'string'
      ? Buffer.byteLength(imageData)
      : imageData.byteLength;

  // Long delay: Worker 1 is hard-killed here in the harness (~600ms).
  // Honour cancellation so a forced worker shutdown abandons the upload.
  await cancellableDelay(2_000);

  const cmsMediaId = `cms-media-${input.tenantId}-${input.articleId}-${byteLength}`;
  return { cmsMediaId };
}

async function cancellableDelay(ms: number): Promise<void> {
  const ctx = Context.current();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
      // Rejects with CancelledFailure when the worker shuts down mid-upload.
      ctx.cancelled,
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
