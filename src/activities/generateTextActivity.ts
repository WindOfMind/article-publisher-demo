import { mockS3 } from '../services/mockS3';
import { metrics } from './metrics';

export interface GenerateTextInput {
  articleId: string;
  tenantId: string;
  topic: string;
}

export interface GenerateTextResult {
  textS3Uri: string;
}

/**
 * Simulates an LLM call. Stores generated markdown in Mock S3 (claim-check)
 * and returns only the URI — never the raw markdown payload.
 */
export async function generateTextActivity(
  input: GenerateTextInput,
): Promise<GenerateTextResult> {
  metrics.llmCalls += 1;

  // Simulate a short LLM latency so the harness can interleave work.
  await delay(40);

  const markdown = [
    `# ${input.topic}`,
    '',
    `*Tenant:* ${input.tenantId} · *Article:* ${input.articleId}`,
    '',
    `This is mock SEO content about **${input.topic}**.`,
    '',
    '## Key takeaways',
    '',
    '- Point one',
    '- Point two',
    '- Point three',
  ].join('\n');

  const textS3Uri = await mockS3.put(
    `articles/${input.tenantId}/${input.articleId}/content.md`,
    markdown,
  );

  return { textS3Uri };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
