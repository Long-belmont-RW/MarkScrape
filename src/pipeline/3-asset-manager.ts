import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import pLimit from 'p-limit';
import type { Browser, Page } from 'playwright';
import type { AssetLocalizationResult, ImageCache } from '../types.js';
import { resolveUrl } from '../utils/url-helpers.js';
import { logger } from '../utils/logger.js';

const MIN_IMAGE_BYTES = 300;

/**
 * Determines file extension from Content-Type header or URL fallback.
 */
function resolveImageExtension(contentType: string, sourceUrl: string): string {
  const mime = contentType.split(';')[0].trim().toLowerCase();
  const mimeMap: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/gif': '.gif',
    'image/avif': '.avif',
    'image/bmp': '.bmp',
    'image/x-icon': '.ico',
    'image/vnd.microsoft.icon': '.ico',
  };

  if (mimeMap[mime]) {
    return mimeMap[mime];
  }

  try {
    if (!sourceUrl.startsWith('data:')) {
      const parsedUrl = new URL(sourceUrl);
      const ext = path.extname(parsedUrl.pathname).toLowerCase();
      if (['.jpg', '.jpeg', '.png', '.webp', '.svg', '.gif', '.avif'].includes(ext)) {
        return ext === '.jpeg' ? '.jpg' : ext;
      }
    }
  } catch {
    // Ignore URL parse error
  }

  return '.jpg';
}

/**
 * Decodes a data:image/... URI into a Buffer and Content-Type.
 */
function decodeDataImageUri(dataUri: string): { buffer: Buffer; contentType: string } | null {
  const match = dataUri.match(/^data:(image\/[a-zA-Z0-9.+-]+)(?:;charset=[^;,]+)?(;base64)?,(.*)$/s);
  if (!match) return null;

  const contentType = match[1].toLowerCase();
  const isBase64 = Boolean(match[2]);
  const rawPayload = match[3] || '';

  try {
    const buffer = isBase64
      ? Buffer.from(rawPayload, 'base64')
      : Buffer.from(decodeURIComponent(rawPayload), 'utf-8');
    return { buffer, contentType };
  } catch {
    return null;
  }
}

/**
 * Stage 3: Asset Manager
 * - Parses contentHtml into a clean JSDOM instance
 * - Locates all <img> elements and processes concurrently with p-limit
 * - Handles data:image/... URIs, checks Stage 1 imageCache, and falls back to page.request.get() with Referer
 * - Filters out < 300 byte tracking pixels and removes their <img> node
 * - Hashes buffers with SHA-256 (img_<12-char-hash>.<ext>), writes to <outputDir>/assets/, and mutates img.src
 * - Closes Playwright browser in a finally block
 */
export async function localizeAssets(params: {
  contentHtml: string;
  finalUrl: string;
  outputDir: string;
  concurrency: number;
  imageCache: ImageCache;
  page: Page;
  browser: Browser;
}): Promise<AssetLocalizationResult> {
  const { contentHtml, finalUrl, outputDir, concurrency, imageCache, page, browser } = params;

  const virtualConsole = new VirtualConsole();
  virtualConsole.on('error', () => {});

  const dom = new JSDOM(contentHtml, {
    url: finalUrl,
    virtualConsole,
  });
  const { document } = dom.window;

  const imgElements = Array.from(document.querySelectorAll('img'));
  const assetsDir = path.join(outputDir, 'assets');
  await fs.mkdir(assetsDir, { recursive: true });

  const limit = pLimit(Math.max(1, concurrency));
  const writtenHashes = new Set<string>();
  let imagesDownloaded = 0;
  let duplicatesSkipped = 0;
  let failedAssets = 0;

  try {
    const tasks = imgElements.map((img) =>
      limit(async () => {
        const rawSrc = img.getAttribute('src');
        if (!rawSrc) {
          img.remove();
          return;
        }

        const resolvedSrc = resolveUrl(rawSrc, finalUrl);
        if (!resolvedSrc) {
          img.remove();
          return;
        }

        let buffer: Buffer | null = null;
        let contentType = 'image/jpeg';

        try {
          if (resolvedSrc.startsWith('data:image/')) {
            const decoded = decodeDataImageUri(resolvedSrc);
            if (!decoded) {
              logger.warn(`Failed to decode inline data:image URI; removing broken <img> tag.`);
              failedAssets += 1;
              img.remove();
              return;
            }
            buffer = decoded.buffer;
            contentType = decoded.contentType;
          } else {
            // 1. Check in-memory network cache from Stage 1
            const cached = imageCache.get(resolvedSrc);
            if (cached && cached.buffer.byteLength > 0) {
              buffer = cached.buffer;
              contentType = cached.contentType;
            } else {
              // 2. Fallback to Playwright page.request.get with Referer header
              const response = await page.request.get(resolvedSrc, {
                headers: {
                  Referer: finalUrl,
                  Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                },
                timeout: 15000,
              });

              if (!response.ok()) {
                logger.warn(
                  `Image download returned HTTP ${response.status()} for ${resolvedSrc}; keeping remote URL.`
                );
                failedAssets += 1;
                img.setAttribute('src', resolvedSrc);
                return;
              }

              buffer = await response.body();
              contentType = (response.headers()['content-type'] || 'image/jpeg').toLowerCase();
            }
          }

          if (!buffer || buffer.byteLength < MIN_IMAGE_BYTES) {
            // Discard tracking pixels (< 300 bytes) and remove their <img> node from the DOM
            img.remove();
            return;
          }

          const ext = resolveImageExtension(contentType, resolvedSrc);
          const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12);
          const filename = `img_${hash}${ext}`;
          const filePath = path.join(assetsDir, filename);

          if (writtenHashes.has(hash)) {
            duplicatesSkipped += 1;
          } else {
            writtenHashes.add(hash);
            await fs.writeFile(filePath, buffer);
            imagesDownloaded += 1;
          }

          img.setAttribute('src', `./assets/${filename}`);
          img.removeAttribute('srcset');
          img.removeAttribute('sizes');
          img.removeAttribute('loading');
        } catch (err) {
          logger.warn(
            `Failed to download image (${resolvedSrc}): ${
              err instanceof Error ? err.message : String(err)
            }. Keeping remote URL.`
          );
          failedAssets += 1;
          img.setAttribute('src', resolvedSrc);
        }
      })
    );

    await Promise.all(tasks);
  } finally {
    await browser.close().catch((err) => {
      logger.warn(`Failed to close browser cleanly: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  return {
    localizedHtml: document.body.innerHTML,
    imagesDownloaded,
    duplicatesSkipped,
    failedAssets,
  };
}
