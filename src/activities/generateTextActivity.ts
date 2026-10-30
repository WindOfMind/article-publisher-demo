import { log } from '@temporalio/activity';
import { mockS3 } from '../infra/mockS3';
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
  log.info('Generating article text', {
    articleId: input.articleId,
    tenantId: input.tenantId,
    topic: input.topic,
  });

  metrics.llmCalls += 1;

  // Simulate a short LLM latency.
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

  log.info('Article text stored', { articleId: input.articleId, textS3Uri });

  return { textS3Uri };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
