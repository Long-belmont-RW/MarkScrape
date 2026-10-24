import fs from 'node:fs/promises';
import path from 'node:path';
import type { ExtractedArticle } from '../types.js';
import { buildMarkdownDocument } from '../core/converter.js';

/**
 * Stage 5: Bundler
 * - Generates YAML frontmatter (title, source_url, author, site_name, excerpt, date_scraped)
 * - Combines frontmatter + # <title> + Markdown body via shared buildMarkdownDocument
 * - Writes to <outputDir>/index.md
 */
export async function bundleAndWriteMarkdown(params: {
  article: ExtractedArticle;
  markdownBody: string;
  sourceUrl: string;
  outputDir: string;
}): Promise<string> {
  const { article, markdownBody, sourceUrl, outputDir } = params;

  await fs.mkdir(outputDir, { recursive: true });

  const finalDocument = buildMarkdownDocument({
    article,
    markdownBody,
    sourceUrl,
  });

  const markdownPath = path.resolve(outputDir, 'index.md');
  await fs.writeFile(markdownPath, finalDocument, 'utf-8');

  return markdownPath;
}
