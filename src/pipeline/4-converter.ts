import { JSDOM, VirtualConsole } from 'jsdom';
import { convertHtmlToMarkdown as convertCoreHtmlToMarkdown } from '../core/converter.js';

/**
 * Stage 4: Converter
 * - Parses HTML into a JSDOM body element and delegates table normalization + Turndown GFM conversion
 *   to the shared browser-safe converter in src/core/converter.ts
 */
export function convertHtmlToMarkdown(contentHtml: string): string {
  return convertCoreHtmlToMarkdown(contentHtml, (html) => {
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('error', () => {});
    const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`, { virtualConsole });
    return dom.window.document.body;
  });
}
