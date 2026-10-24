import { Readability } from '@mozilla/readability';
import { extractTrueImageUrl, parseHighestResSrcset, resolveUrl } from '../utils/url-helpers.js';

export { extractTrueImageUrl, parseHighestResSrcset, resolveUrl };

export interface ExtractedArticle {
  title: string;
  byline: string | null;
  siteName: string | null;
  excerpt: string | null;
  contentHtml: string;
}

/**
 * Prepares a cloned or JSDOM Document prior to running @mozilla/readability:
 * 1. Resolves all <a href> attributes to absolute URLs
 * 2. Upgrades all <img> tags with their highest-resolution URL from <picture><source>,
 *    data-srcset, srcset, data-src, etc., and strips lazy-loading attributes
 * 3. Unwraps <picture> elements so <img> sits directly in the parent container
 * 4. Flattens custom elements containing <pre> blocks so Readability preserves code examples
 */
export function prepareDomForReadability(document: Document, baseUrl: string): void {
  // 1. Resolve all <a> relative href attributes to absolute URLs
  const anchors = Array.from(document.querySelectorAll('a[href]'));
  for (const anchor of anchors) {
    const rawHref = anchor.getAttribute('href');
    if (!rawHref) continue;
    const trimmed = rawHref.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('mailto:') || trimmed.startsWith('tel:')) {
      continue;
    }
    const resolved = resolveUrl(trimmed, baseUrl);
    if (resolved) {
      anchor.setAttribute('href', resolved);
    }
  }

  // 2. Upgrade all <img> tags with their true highest-resolution absolute URL
  const images = Array.from(document.querySelectorAll('img'));
  for (const img of images) {
    const trueUrl = extractTrueImageUrl(img, baseUrl);
    if (trueUrl) {
      img.setAttribute('src', trueUrl);
      // Clean up srcset/data-* attributes so Readability preserves the clean src
      img.removeAttribute('srcset');
      img.removeAttribute('data-srcset');
      img.removeAttribute('data-lazy-srcset');
      img.removeAttribute('data-src');
      img.removeAttribute('data-lazy-src');
      img.removeAttribute('data-original');
      img.removeAttribute('data-actualsrc');
      img.removeAttribute('data-hi-res-src');
      img.removeAttribute('sizes');
      img.removeAttribute('loading');
    } else {
      // Remove broken or empty <img> tags
      img.remove();
    }
  }

  // 3. Unwrap <picture> tags so <img> sits directly in the parent container
  const pictures = Array.from(document.querySelectorAll('picture'));
  for (const picture of pictures) {
    const parent = picture.parentNode;
    if (!parent) continue;

    const childImg = picture.querySelector('img');
    if (childImg) {
      parent.insertBefore(childImg, picture);
    }
    picture.remove();
  }

  // 4. Flatten custom elements (e.g., <mdn-code-example>) that hide <pre><code> inside Shadow DOM
  // or get stripped by Readability when their inner light DOM appears empty.
  const customElements = Array.from(document.querySelectorAll('*')).filter((el) =>
    el.tagName.includes('-')
  );
  for (const customEl of customElements) {
    const preChild = customEl.querySelector('pre');
    if (preChild && customEl.parentNode) {
      customEl.parentNode.insertBefore(preChild, customEl);
      customEl.remove();
    }
  }
}

/**
 * Prepares the DOM and executes Mozilla Readability to extract the primary article content
 * and metadata, with a graceful fallback to the main body container if Readability returns null.
 */
export function extractArticleFromDom(
  document: Document,
  baseUrl: string,
  onWarn?: (msg: string) => void
): ExtractedArticle {
  prepareDomForReadability(document, baseUrl);

  let hostnameFallback = 'untitled';
  try {
    hostnameFallback = new URL(baseUrl).hostname;
  } catch {
    // Ignore URL parse error
  }

  const fallbackTitle =
    document.title?.trim() ||
    document.querySelector('h1')?.textContent?.trim() ||
    hostnameFallback;
  const fallbackBodyHtml =
    document.querySelector('main, article, [role="main"]')?.innerHTML ||
    document.body?.innerHTML ||
    '';

  try {
    const reader = new Readability(document, {
      keepClasses: true,
    });
    const parsed = reader.parse();

    if (parsed && parsed.content && parsed.content.trim().length > 0) {
      return {
        title: parsed.title?.trim() || fallbackTitle,
        byline: parsed.byline?.trim() || null,
        siteName: parsed.siteName?.trim() || null,
        excerpt: parsed.excerpt?.trim() || null,
        contentHtml: parsed.content,
      };
    }
  } catch (err) {
    onWarn?.(
      `Readability parsing failed, falling back to main body container: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  onWarn?.('Readability returned empty content; falling back to primary document body.');
  return {
    title: fallbackTitle,
    byline: null,
    siteName: null,
    excerpt: null,
    contentHtml: fallbackBodyHtml,
  };
}
