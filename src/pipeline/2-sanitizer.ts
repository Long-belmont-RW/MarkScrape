import { JSDOM, VirtualConsole } from 'jsdom';
import type { ExtractedArticle } from '../types.js';
import { extractArticleFromDom } from '../core/dom-preparer.js';
import { logger } from '../utils/logger.js';

/**
 * Stage 2: Sanitizer
 * - Parses rawHtml using JSDOM(rawHtml, { url: finalUrl })
 * - Runs shared browser-safe DOM preparation and Readability extraction from src/core/dom-preparer.ts
 */
export function sanitizeAndExtract(rawHtml: string, finalUrl: string): ExtractedArticle {
  const virtualConsole = new VirtualConsole();
  // Suppress noisy JSDOM CSS parsing errors
  virtualConsole.on('error', () => {});

  const dom = new JSDOM(rawHtml, {
    url: finalUrl,
    virtualConsole,
  });

  const { document } = dom.window;

  return extractArticleFromDom(document, finalUrl, (msg) => {
    logger.warn(msg);
  });
}
