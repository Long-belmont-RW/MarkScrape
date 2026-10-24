import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page, type Response } from 'playwright';
import type { FetchedPageData, ImageCache, ScraperOptions } from '../types.js';
import { logger } from '../utils/logger.js';

/**
 * Launches Playwright Chromium with graceful fallback to any cached ms-playwright Chromium build
 * or system-installed Chrome/Edge if the default bundled revision is missing.
 */
async function launchChromiumBrowser(headless: boolean): Promise<Browser> {
  try {
    return await chromium.launch({ headless });
  } catch {
    // Check ms-playwright cache directory for an existing Chromium build
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      const msPlaywrightDir = path.join(localAppData, 'ms-playwright');
      if (fs.existsSync(msPlaywrightDir)) {
        const entries = fs.readdirSync(msPlaywrightDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name.startsWith('chromium-')) {
            const candidateExe = path.join(
              msPlaywrightDir,
              entry.name,
              'chrome-win64',
              'chrome.exe'
            );
            if (fs.existsSync(candidateExe)) {
              return await chromium.launch({ headless, executablePath: candidateExe });
            }
          }
        }
      }
    }

    // Fallback to system Chrome or Edge channel
    try {
      return await chromium.launch({ headless, channel: 'chrome' });
    } catch {
      return await chromium.launch({ headless, channel: 'msedge' });
    }
  }
}

/**
 * Scrolls down the page in 400px increments every 100ms until the bottom is reached
 * (or a safe maximum scroll threshold is hit) to trigger IntersectionObserver lazy-loaded images.
 */
async function autoScroll(page: Page): Promise<void> {
  try {
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => {
        let totalHeight = 0;
        const distance = 400;
        const delayMs = 100;
        const maxScrolls = 120; // Cap at ~48,000px / 12 seconds to avoid infinite scroll traps
        let scrollCount = 0;

        const timer = setInterval(() => {
          const scrollHeight = document.body ? document.body.scrollHeight : 0;
          window.scrollBy(0, distance);
          totalHeight += distance;
          scrollCount += 1;

          if (totalHeight >= scrollHeight - window.innerHeight || scrollCount >= maxScrolls) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            resolve();
          }
        }, delayMs);
      });
    });
    // Wait briefly for newly triggered network image requests to settle
    await page.waitForTimeout(500);

    // Promote any <pre><code> blocks residing inside open Shadow DOM roots into light DOM
    // so page.content() and Readability preserve them
    await page.evaluate(() => {
      const allElements = Array.from(document.querySelectorAll('*'));
      for (const el of allElements) {
        if (el.shadowRoot && !el.querySelector('pre')) {
          const shadowPres = Array.from(el.shadowRoot.querySelectorAll('pre'));
          for (const pre of shadowPres) {
            el.appendChild(pre.cloneNode(true));
          }
        }
      }
    });
  } catch (err) {
    logger.warn(
      `Auto-scroll encountered a non-fatal error: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

/**
 * Stage 1: Fetcher
 * - Launches Playwright Chromium
 * - Attaches page.on('response') listener before navigation to cache image buffers in memory
 * - Navigates with waitUntil: 'networkidle' (falling back to 'domcontentloaded' if timeout occurs)
 * - Runs autoScroll(page) to trigger lazy-loaded images
 * - Returns { rawHtml, finalUrl, imageCache, page, browser }
 */
export async function fetchPage(options: ScraperOptions): Promise<FetchedPageData> {
  const browser = await launchChromiumBrowser(options.headless);

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();
  const imageCache: ImageCache = new Map();

  // Attach response listener BEFORE navigation to capture incoming image payloads
  page.on('response', async (response: Response) => {
    try {
      const request = response.request();
      const resourceType = request.resourceType();
      const status = response.status();

      if (status >= 200 && status < 300) {
        const contentType = (response.headers()['content-type'] || '').toLowerCase();
        if (resourceType === 'image' || contentType.startsWith('image/')) {
          const buffer = await response.body();
          if (buffer && buffer.byteLength > 0) {
            imageCache.set(response.url(), {
              buffer,
              contentType: contentType || 'image/jpeg',
            });
          }
        }
      }
    } catch {
      // Ignore individual response body read failures (e.g., cancelled or redirected requests)
    }
  });

  const networkIdleTimeout = Math.min(options.timeout, 15000);

  try {
    await page.goto(options.url, {
      waitUntil: 'networkidle',
      timeout: networkIdleTimeout,
    });
  } catch {
    logger.warn(
      `Navigation with 'networkidle' timed out or failed after ${networkIdleTimeout}ms, falling back to 'domcontentloaded'...`
    );
    try {
      await page.goto(options.url, {
        waitUntil: 'domcontentloaded',
        timeout: options.timeout,
      });
    } catch (fallbackErr) {
      await browser.close().catch(() => {});
      throw new Error(
        `Failed to navigate to ${options.url}: ${
          fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
        }`
      );
    }
  }

  await autoScroll(page);

  const rawHtml = await page.content();
  const finalUrl = page.url() || options.url;

  return {
    rawHtml,
    finalUrl,
    imageCache,
    page,
    browser,
  };
}
