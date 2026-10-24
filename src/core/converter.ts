import TurndownService from 'turndown';
import * as turndownPluginGfm from 'turndown-plugin-gfm';
import type { ExtractedArticle } from './dom-preparer.js';

/**
 * Extracts a normalized programming language identifier from a <pre> or <code> element.
 */
export function detectCodeLanguage(preNode: HTMLElement, codeNode: HTMLElement | null): string {
  const candidates = [
    codeNode?.getAttribute('data-language'),
    preNode.getAttribute('data-language'),
    codeNode?.getAttribute('data-lang'),
    preNode.getAttribute('data-lang'),
    codeNode?.className,
    preNode.className,
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    // Check direct data-language value (single word like "typescript" or "bash")
    if (/^[a-zA-Z0-9_+-]+$/.test(candidate.trim()) && !candidate.includes(' ')) {
      const token = candidate.trim().toLowerCase();
      if (!['code', 'pre', 'highlight', 'hljs', 'prism'].includes(token)) {
        return token;
      }
    }

    // Check class patterns like "language-ts", "lang-python", "brush: js"
    const match =
      candidate.match(/(?:language-|lang-|syntax-|brush:\s*)([a-zA-Z0-9_+-]+)/i) ||
      candidate.match(
        /\b(javascript|typescript|python|rust|go|java|cpp|csharp|html|css|json|yaml|bash|shell|sql|graphql|markdown|xml)\b/i
      );

    if (match && match[1]) {
      return match[1].toLowerCase();
    }
  }

  return '';
}

/**
 * Pre-normalizes an HTML container element before passing to Turndown:
 * - Ensures tables have a <thead> row if missing so GFM table plugin converts them properly
 * - Sanitizes <td> and <th> contents by replacing nested <p> and <div> blocks with inline spaces
 *   so multi-line cells do not break Markdown table syntax
 */
export function preprocessElementForMarkdown(container: HTMLElement): HTMLElement {
  const doc = container.ownerDocument;
  if (!doc) return container;

  const tables = Array.from(container.querySelectorAll('table'));
  for (const table of tables) {
    // Ensure table has a <thead> if it only has <tbody> or raw <tr> rows
    if (!table.querySelector('thead')) {
      const firstRow = table.querySelector('tr');
      if (firstRow) {
        const thead = doc.createElement('thead');
        // Convert first row cells to <th> if they are <td> so turndown-plugin-gfm recognizes the header row
        const cells = Array.from(firstRow.querySelectorAll('td, th'));
        for (const cell of cells) {
          if (cell.tagName.toLowerCase() === 'td') {
            const th = doc.createElement('th');
            th.innerHTML = cell.innerHTML;
            for (const attr of Array.from(cell.attributes)) {
              th.setAttribute(attr.name, attr.value);
            }
            cell.replaceWith(th);
          }
        }
        thead.appendChild(firstRow);
        table.insertBefore(thead, table.firstChild);
      }
    }

    // Sanitize all table cells (<td> and <th>) so multi-line blocks don't fracture Markdown table rows
    const cells = Array.from(table.querySelectorAll('td, th'));
    for (const cell of cells) {
      const blockElements = Array.from(cell.querySelectorAll('p, div'));
      for (const block of blockElements) {
        const parent = block.parentNode;
        if (!parent) continue;
        while (block.firstChild) {
          parent.insertBefore(block.firstChild, block);
        }
        if (block.nextSibling) {
          const spacer = doc.createTextNode(' ');
          parent.insertBefore(spacer, block);
        }
        block.remove();
      }
    }
  }

  return container;
}

/**
 * Creates a configured TurndownService instance with GFM tables, strikethrough, task lists,
 * and custom rules for single-line table cells, fenced code blocks with language detection,
 * and <figure> elements with <figcaption>.
 */
export function createMarkdownTurndownService(): TurndownService {
  const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    hr: '---',
    emDelimiter: '*',
    strongDelimiter: '**',
  });

  // Resolve CJS/ESM export shape for turndown-plugin-gfm
  // NOTE: Do NOT load gfm.highlightedCodeBlock because it matches <div class="highlight"><pre>...</pre></div>
  // and drops nested <pre><code> blocks when no highlight-* class is present (e.g., on MDN).
  const gfmModule = turndownPluginGfm as unknown as {
    tables?: TurndownService.Plugin;
    strikethrough?: TurndownService.Plugin;
    taskListItems?: TurndownService.Plugin;
    default?: {
      tables?: TurndownService.Plugin;
      strikethrough?: TurndownService.Plugin;
      taskListItems?: TurndownService.Plugin;
    };
  };
  const plugins = [
    gfmModule.tables ?? gfmModule.default?.tables,
    gfmModule.strikethrough ?? gfmModule.default?.strikethrough,
    gfmModule.taskListItems ?? gfmModule.default?.taskListItems,
  ].filter(Boolean) as TurndownService.Plugin[];

  if (plugins.length > 0) {
    turndownService.use(plugins);
  }

  // Custom Rule 1: Table Cell Sanitization (override cell output to guarantee single-line GFM cells)
  turndownService.addRule('tableCellSanitization', {
    filter: ['th', 'td'],
    replacement(content, node) {
      const cleaned = content
        .replace(/\r?\n+/g, ' <br> ')
        .replace(/\|/g, '\\|')
        .replace(/\s{2,}/g, ' ')
        .trim();

      const element = node as HTMLElement;
      const parent = element.parentElement;
      const index = parent ? Array.from(parent.children).indexOf(element) : 0;
      const prefix = index === 0 ? '| ' : ' ';
      return `${prefix}${cleaned || ' '} |`;
    },
  });

  // Custom Rule 2: Code Blocks with language preservation
  turndownService.addRule('fencedCodeBlockWithLanguage', {
    filter(node) {
      return node.nodeName === 'PRE';
    },
    replacement(_content, node) {
      const preElement = node as HTMLElement;
      const codeElement = preElement.querySelector('code') as HTMLElement | null;
      const language = detectCodeLanguage(preElement, codeElement);
      const rawCode = (codeElement ? codeElement.textContent : preElement.textContent) || '';
      const trimmedCode = rawCode.replace(/^\n+|\n+$/g, '');

      // Choose fence length that won't collide with backticks inside the code block
      const fence = trimmedCode.includes('```') ? '~~~~' : '```';
      return `\n\n${fence}${language}\n${trimmedCode}\n${fence}\n\n`;
    },
  });

  // Custom Rule 3: Figures containing an <img> and optional <figcaption>
  turndownService.addRule('figureWithCaption', {
    filter(node) {
      if (node.nodeName !== 'FIGURE') return false;
      const el = node as HTMLElement;
      return Boolean(el.querySelector('img'));
    },
    replacement(_content, node) {
      const figure = node as HTMLElement;
      const img = figure.querySelector('img');
      if (!img) return '';

      const src = img.getAttribute('src')?.trim() || '';
      if (!src) return '';

      const alt = (img.getAttribute('alt') || '')
        .replace(/\r?\n+/g, ' ')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .trim();

      const figcaption = figure.querySelector('figcaption');
      const captionText = figcaption?.textContent
        ? figcaption.textContent.replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim()
        : '';

      const imageMarkdown = `![${alt}](${src})`;
      if (captionText) {
        const escapedCaption = captionText.replace(/\*/g, '\\*');
        return `\n\n${imageMarkdown}\n*${escapedCaption}*\n\n`;
      }
      return `\n\n${imageMarkdown}\n\n`;
    },
  });

  return turndownService;
}

/**
 * Converts an HTML string or DOM element into GitHub Flavored Markdown.
 * In browser environments, parses HTML strings with native DOMParser.
 * In Node/JSDOM environments, callers can pass a pre-parsed HTMLElement or custom parseHtmlToElement callback.
 */
export function convertHtmlToMarkdown(
  input: string | HTMLElement,
  parseHtmlToElement?: (html: string) => HTMLElement
): string {
  const turndownService = createMarkdownTurndownService();

  let rootElement: HTMLElement;
  if (typeof input === 'string') {
    if (parseHtmlToElement) {
      rootElement = parseHtmlToElement(input);
    } else if (typeof DOMParser !== 'undefined') {
      const parser = new DOMParser();
      const doc = parser.parseFromString(`<!DOCTYPE html><html><body>${input}</body></html>`, 'text/html');
      rootElement = doc.body;
    } else {
      return turndownService.turndown(input).trim();
    }
  } else {
    rootElement = input;
  }

  const normalizedElement = preprocessElementForMarkdown(rootElement);
  const markdown = turndownService.turndown(normalizedElement);
  return markdown.trim();
}

/**
 * Safely escapes a string value for double-quoted YAML scalar emission.
 */
export function escapeYamlString(value: string | null | undefined): string {
  if (!value) return '""';
  const normalized = value
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  return `"${normalized}"`;
}

/**
 * Combines YAML frontmatter, an H1 title (deduplicated if already present), and the Markdown body.
 */
export function buildMarkdownDocument(params: {
  article: Pick<ExtractedArticle, 'title' | 'byline' | 'siteName' | 'excerpt'>;
  markdownBody: string;
  sourceUrl: string;
  dateScraped?: string;
}): string {
  const { article, markdownBody, sourceUrl } = params;
  const dateScraped = params.dateScraped ?? new Date().toISOString();

  let defaultSiteName = 'Unknown';
  try {
    defaultSiteName = new URL(sourceUrl).hostname;
  } catch {
    // Ignore invalid URL
  }

  const createdDate = dateScraped.slice(0, 10);
  const frontmatterLines = [
    '---',
    `title: ${escapeYamlString(article.title)}`,
    `source: ${escapeYamlString(sourceUrl)}`,
    `source_url: ${escapeYamlString(sourceUrl)}`,
    `author: ${escapeYamlString(article.byline || 'Unknown')}`,
    `site_name: ${escapeYamlString(article.siteName || defaultSiteName)}`,
    ...(article.excerpt ? [`excerpt: ${escapeYamlString(article.excerpt)}`] : []),
    `created: ${escapeYamlString(createdDate)}`,
    `date_scraped: ${escapeYamlString(dateScraped)}`,
    'tags: [clippings, markscrape]',
    '---',
  ];

  const cleanTitle = (article.title || 'Untitled').replace(/\r?\n+/g, ' ').trim();

  // Avoid duplicating the H1 if the Markdown body already begins with an identical H1 heading
  const leadingH1Regex = /^#\s+([^\r\n]+)\r?\n+/;
  const match = markdownBody.match(leadingH1Regex);
  let normalizedBody = markdownBody.trim();
  if (match && match[1].trim().toLowerCase() === cleanTitle.toLowerCase()) {
    normalizedBody = normalizedBody.replace(leadingH1Regex, '').trim();
  }

  const combined = `${frontmatterLines.join('\n')}\n\n# ${cleanTitle}\n\n${normalizedBody}\n`;

  // Normalize excessive blank lines (max 2 consecutive newlines -> \n\n)
  return combined.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}
