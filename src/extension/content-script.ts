import { buildMarkdownDocument, convertHtmlToMarkdown } from '../core/converter.js';
import {
  extractArticleFromDom,
  prepareDomForReadability,
  resolveUrl,
  type ExtractedArticle,
} from '../core/dom-preparer.js';
import type {
  BuildAndDownloadZipMessage,
  BuildAndDownloadZipResponse,
  FetchAndHashAssetMessage,
  FetchAndHashAssetResponse,
  ZipAssetEntry,
} from './background.js';
import { ElementPicker, type PickerOutputMode } from './element-picker.js';
import {
  PreviewModal,
  type PreviewImageItem,
  type PreviewModalDownloadRequest,
  type PreviewModalDownloadResult,
} from './preview-modal.js';

export interface ScrapePageMessage {
  type: 'SCRAPE_PAGE';
  autoScroll: boolean;
}

export interface StartPickerMessage {
  type: 'START_PICKER';
  outputMode?: PickerOutputMode;
}

export interface OpenFullPagePreviewMessage {
  type: 'OPEN_FULL_PAGE_PREVIEW';
  autoScroll: boolean;
}

export interface ScrapedPagePayload {
  title: string;
  byline: string | null;
  siteName: string | null;
  excerpt: string | null;
  pageUrl: string;
  readableHtml: string;
  imageUrls: string[];
}

export type ScrapePageResponse =
  | { ok: true; data: ScrapedPagePayload }
  | { ok: false; error: string };

export type StartPickerResponse = { ok: true } | { ok: false; error: string };

export type OpenFullPagePreviewResponse = { ok: true } | { ok: false; error: string };

declare global {
  interface Window {
    __markScrapeContentScriptLoaded?: boolean;
    __markScrapeActivePicker?: ElementPicker | null;
    __markScrapeActiveModal?: PreviewModal | null;
  }
}

const MAX_IMAGE_CONCURRENCY = 5;

/**
 * Smoothly scrolls the active window down in increments (capped at 20 iterations)
 * to trigger IntersectionObserver lazy-loaded images, then restores the scroll position.
 */
async function autoScrollLivePage(): Promise<void> {
  const originalScrollX = window.scrollX;
  const originalScrollY = window.scrollY;
  const maxIterations = 20;
  const stepDistance = Math.max(window.innerHeight * 0.75, 450);
  const stepDelayMs = 110;

  await new Promise<void>((resolve) => {
    let iteration = 0;
    let currentScroll = window.scrollY;

    const timer = window.setInterval(() => {
      const maxScrollY =
        Math.max(
          document.body?.scrollHeight || 0,
          document.documentElement?.scrollHeight || 0
        ) - window.innerHeight;

      window.scrollBy({ top: stepDistance, behavior: 'smooth' });
      currentScroll += stepDistance;
      iteration += 1;

      if (currentScroll >= maxScrollY || iteration >= maxIterations) {
        window.clearInterval(timer);
        window.scrollTo({
          left: originalScrollX,
          top: originalScrollY,
          behavior: 'instant' as ScrollBehavior,
        });
        resolve();
      }
    }, stepDelayMs);
  });

  // Allow newly triggered lazy-loaded image DOM mutations to settle
  await new Promise<void>((resolve) => window.setTimeout(resolve, 350));
}

/**
 * Copies open Shadow DOM <pre> blocks from live custom elements into the corresponding
 * cloned elements without mutating the user's live DOM.
 */
function transferShadowCodeBlocksToClone(liveRoot: ParentNode, clonedRoot: ParentNode): void {
  const liveCustomElements = Array.from(liveRoot.querySelectorAll('*')).filter(
    (el) => el.shadowRoot && el.tagName.includes('-')
  );
  if (liveCustomElements.length === 0) return;

  const clonedCustomElements = Array.from(clonedRoot.querySelectorAll('*')).filter((el) =>
    el.tagName.includes('-')
  );

  const count = Math.min(liveCustomElements.length, clonedCustomElements.length);
  for (let i = 0; i < count; i++) {
    const liveEl = liveCustomElements[i];
    const cloneEl = clonedCustomElements[i];
    if (liveEl.tagName === cloneEl.tagName && liveEl.shadowRoot && !cloneEl.querySelector('pre')) {
      const shadowPres = Array.from(liveEl.shadowRoot.querySelectorAll('pre'));
      for (const pre of shadowPres) {
        cloneEl.appendChild(pre.cloneNode(true));
      }
    }
  }
}

/**
 * Extracts unique resolved image URLs from an HTML string.
 */
function collectImageUrlsFromHtml(html: string, baseUrl: string): string[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(
    `<!DOCTYPE html><html><body>${html}</body></html>`,
    'text/html'
  );
  const urls = new Set<string>();

  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const rawSrc = img.getAttribute('src');
    const resolved = resolveUrl(rawSrc, baseUrl);
    if (resolved) {
      urls.add(resolved);
    }
  }

  return Array.from(urls);
}

/**
 * Normalizes <img> elements in a container to use resolved absolute URLs and extracts
 * a deduplicated list of PreviewImageItem objects for the PreviewModal gallery.
 */
function extractPreviewImagesFromContainer(
  container: HTMLElement,
  baseUrl: string
): PreviewImageItem[] {
  const seenUrls = new Set<string>();
  const items: PreviewImageItem[] = [];

  for (const img of Array.from(container.querySelectorAll('img'))) {
    const rawSrc = img.getAttribute('src');
    const resolved = resolveUrl(rawSrc, baseUrl);
    if (!resolved) {
      img.remove();
      continue;
    }

    // Ensure the DOM node has the exact resolved URL so Turndown emits matching Markdown links
    img.setAttribute('src', resolved);
    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
    img.removeAttribute('loading');

    const alt = (img.getAttribute('alt') || '')
      .replace(/\r?\n+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!seenUrls.has(resolved)) {
      seenUrls.add(resolved);
      items.push({
        id: `img-${items.length + 1}`,
        url: resolved,
        remoteUrl: resolved,
        alt,
        included: true,
      });
    }
  }

  return items;
}

/**
 * Splits a full Markdown document (produced by buildMarkdownDocument) into its YAML frontmatter
 * block and the remaining Markdown body.
 */
function splitFrontmatterAndBody(fullMarkdown: string): {
  frontmatterYaml: string;
  bodyMarkdown: string;
} {
  const match = fullMarkdown.match(/^(---\r?\n[\s\S]*?\r?\n---)\r?\n+([\s\S]*)$/);
  if (!match) {
    return {
      frontmatterYaml: '',
      bodyMarkdown: fullMarkdown.trim(),
    };
  }
  return {
    frontmatterYaml: match[1].trim(),
    bodyMarkdown: match[2].trim(),
  };
}

/**
 * Simple concurrency limiter for browser async tasks.
 */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  let currentIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  const runners = Array.from({ length: workerCount }, async () => {
    while (currentIndex < items.length) {
      const idx = currentIndex++;
      await worker(items[idx], idx);
    }
  });

  await Promise.all(runners);
}

/**
 * Clones a selected DOM element, strips noisy tags & small SVG icons while bypassing
 * @mozilla/readability, and runs prepareDomForReadability on the isolated subtree.
 */
function cloneAndSanitizeSelectedElement(
  selectedElement: HTMLElement,
  baseUrl: string
): Document {
  const clonedSubtree = selectedElement.cloneNode(true) as HTMLElement;
  transferShadowCodeBlocksToClone(selectedElement, clonedSubtree);

  // Strip small SVG icons (< 24x24) by inspecting live bounding boxes and attributes
  const liveSvgs = Array.from(selectedElement.querySelectorAll('svg'));
  const clonedSvgs = Array.from(clonedSubtree.querySelectorAll('svg'));
  const svgCount = Math.min(liveSvgs.length, clonedSvgs.length);
  for (let i = 0; i < svgCount; i++) {
    const liveRect = liveSvgs[i].getBoundingClientRect();
    const widthAttr = parseFloat(clonedSvgs[i].getAttribute('width') || '0');
    const heightAttr = parseFloat(clonedSvgs[i].getAttribute('height') || '0');

    const isSmallLive =
      liveRect.width > 0 && liveRect.height > 0 && liveRect.width < 24 && liveRect.height < 24;
    const isSmallAttr =
      widthAttr > 0 && heightAttr > 0 && widthAttr < 24 && heightAttr < 24;

    if (isSmallLive || isSmallAttr) {
      clonedSvgs[i].remove();
    }
  }

  // Strip noisy tags and hidden elements from the cloned subtree
  const noisySelectors = [
    'script',
    'style',
    'noscript',
    'iframe',
    'button',
    'nav',
    '[aria-hidden="true"]',
    '[hidden]',
    '#markscrape-picker-host',
    `#${PreviewModal.HOST_ID}`,
  ].join(', ');

  for (const noisyEl of Array.from(clonedSubtree.querySelectorAll(noisySelectors))) {
    noisyEl.remove();
  }

  const tempDoc = document.implementation.createHTMLDocument(
    document.title || 'Scraped Element'
  );

  // Ensure partial table selections (tr, thead, tbody, td, th) are wrapped in a valid <table>
  const tag = clonedSubtree.tagName.toLowerCase();
  if (tag === 'tr' || tag === 'thead' || tag === 'tbody') {
    const tableWrapper = tempDoc.createElement('table');
    tableWrapper.appendChild(clonedSubtree);
    tempDoc.body.appendChild(tableWrapper);
  } else if (tag === 'td' || tag === 'th') {
    const tableWrapper = tempDoc.createElement('table');
    const rowWrapper = tempDoc.createElement('tr');
    rowWrapper.appendChild(clonedSubtree);
    tableWrapper.appendChild(rowWrapper);
    tempDoc.body.appendChild(tableWrapper);
  } else {
    tempDoc.body.appendChild(clonedSubtree);
  }

  // Resolve relative <a href> links, upgrade lazy <img> attributes, and unwrap <picture> tags
  prepareDomForReadability(tempDoc, baseUrl);

  return tempDoc;
}

/**
 * Copies text to the clipboard using the Clipboard API with a fallback to execCommand('copy').
 */
async function copyTextToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) {
      throw new Error('Clipboard write permission denied.');
    }
  }
}

/**
 * Triggers a fallback anchor download in the content script if chrome.downloads in background fails.
 */
function triggerAnchorZipDownload(zipBase64: string, filename: string): void {
  const binary = atob(zipBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: 'application/zip' });
  const blobUrl = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
}

/**
 * Stage B (Post-Edit Localization & ZIP Bundler):
 * Concurrently fetches & SHA-256 hashes only the user-selected images (`included === true`),
 * replaces every occurrence of each `remoteUrl` inside the user's edited `markdownText`
 * with `./assets/img_<12-char-hash>.<ext>`, bundles `index.md` + `/assets` into a `.zip`,
 * and triggers the browser download.
 */
async function handleCuratedZipDownload(
  request: PreviewModalDownloadRequest
): Promise<PreviewModalDownloadResult> {
  const { markdownText, selectedImages, pageTitle, pageUrl, onProgress } = request;

  // Filter to unique URLs that are selected
  const uniqueSelectedUrls = Array.from(
    new Set(
      selectedImages
        .filter((img) => img.included)
        .map((img) => img.remoteUrl || img.url)
        .filter(Boolean)
    )
  );

  const totalImages = uniqueSelectedUrls.length;
  const urlToLocalPath = new Map<string, string>();
  const hashToAsset = new Map<string, ZipAssetEntry>();
  let completedImages = 0;

  if (totalImages > 0) {
    onProgress(0, totalImages, `Fetching 0/${totalImages} images...`);

    await runWithConcurrency(uniqueSelectedUrls, MAX_IMAGE_CONCURRENCY, async (remoteUrl) => {
      try {
        const fetchMsg: FetchAndHashAssetMessage = {
          type: 'FETCH_AND_HASH_ASSET',
          url: remoteUrl,
        };
        const res = (await chrome.runtime.sendMessage(fetchMsg)) as
          | FetchAndHashAssetResponse
          | undefined;

        if (res && res.ok && !res.skippedTrackingPixel) {
          const existingAsset = hashToAsset.get(res.hash);
          const filename = existingAsset ? existingAsset.filename : res.filename;
          const localPath = `./assets/${filename}`;

          if (!existingAsset) {
            hashToAsset.set(res.hash, {
              filename,
              base64: res.base64,
            });
          }

          urlToLocalPath.set(remoteUrl, localPath);
        }
      } catch {
        // Keep remote URL in Markdown if an individual image fails to fetch
      } finally {
        completedImages += 1;
        onProgress(
          completedImages,
          totalImages,
          `Fetching ${completedImages}/${totalImages} images...`
        );
      }
    });
  }

  onProgress(totalImages, totalImages, 'Localizing Markdown links & building .ZIP...');

  // Replace every occurrence of each remoteUrl in the user's edited markdownText with ./assets/img_<hash>.<ext>
  let finalMarkdown = markdownText;
  for (const [remoteUrl, localPath] of urlToLocalPath.entries()) {
    finalMarkdown = finalMarkdown.split(remoteUrl).join(localPath);
  }

  const assets = Array.from(hashToAsset.values());
  const zipMsg: BuildAndDownloadZipMessage = {
    type: 'BUILD_AND_DOWNLOAD_ZIP',
    title: pageTitle,
    pageUrl,
    markdown: finalMarkdown,
    assets,
    selectedImageUrls: uniqueSelectedUrls,
  };

  const zipRes = (await chrome.runtime.sendMessage(zipMsg)) as
    | BuildAndDownloadZipResponse
    | undefined;

  if (!zipRes || !zipRes.ok) {
    throw new Error(zipRes?.error || 'Failed to build ZIP bundle.');
  }

  if (!zipRes.triggeredDownload && zipRes.zipBase64) {
    triggerAnchorZipDownload(zipRes.zipBase64, zipRes.filename);
  }

  return {
    filename: zipRes.filename,
    downloadedImagesCount: assets.length,
  };
}

/**
 * Extracts Markdown + discovered images and opens the dedicated MarkScrape Editor Studio tab
 * (`editor.html`) via the background service worker, with an in-page PreviewModal fallback.
 */
async function openEditorForContent(params: {
  article: Pick<ExtractedArticle, 'title' | 'byline' | 'siteName' | 'excerpt'>;
  container: HTMLElement;
  pageUrl: string;
  pickerOutputMode?: PickerOutputMode;
}): Promise<void> {
  const { article, container, pageUrl, pickerOutputMode = 'zip' } = params;

  if (window.__markScrapeActiveModal) {
    window.__markScrapeActiveModal.close();
    window.__markScrapeActiveModal = null;
  }

  // Extract discovered images and ensure all <img> tags have resolved https:// URLs
  const images = extractPreviewImagesFromContainer(container, pageUrl);

  // Convert sanitized HTML subtree to GFM Markdown (with remote image URLs intact)
  const markdownBody = convertHtmlToMarkdown(container);
  const fullDocument = buildMarkdownDocument({
    article,
    markdownBody,
    sourceUrl: pageUrl,
  });

  const { frontmatterYaml, bodyMarkdown } = splitFrontmatterAndBody(fullDocument);

  const modal = new PreviewModal({
    pageTitle: article.title,
    pageUrl,
    initialBodyMarkdown: bodyMarkdown,
    frontmatterYaml,
    images,
    includeFrontmatterByDefault: true,
    onRepickElement: () => {
      startInteractivePicker(pickerOutputMode);
    },
    onCopyMarkdown: async (text) => {
      await copyTextToClipboard(text);
    },
    onDownloadZip: async (request) => {
      return handleCuratedZipDownload(request);
    },
    onClose: () => {
      if (window.__markScrapeActiveModal === modal) {
        window.__markScrapeActiveModal = null;
      }
    },
  });

  window.__markScrapeActiveModal = modal;
  modal.open();
}

/**
 * Stage A (Instant Preview Generation for Picked Element):
 * Clones & sanitizes the picked element, upgrades lazy images to absolute URLs,
 * converts to Markdown with Turndown, extracts discovered image objects, and opens the Editor Tab.
 */
async function handleElementSelected(
  selectedElement: HTMLElement,
  outputMode: PickerOutputMode,
  picker: ElementPicker
): Promise<void> {
  try {
    picker.showProgress('Preparing Markdown & opening Preview Studio...', 'loading');

    const pageUrl = window.location.href;
    const tempDoc = cloneAndSanitizeSelectedElement(selectedElement, pageUrl);

    const sectionHeading = tempDoc.querySelector('h1, h2, h3')?.textContent?.trim();
    const pageTitle = document.title?.trim() || sectionHeading || 'Scraped Section';

    await openEditorForContent({
      article: {
        title: pageTitle,
        byline: null,
        siteName: null,
        excerpt: null,
      },
      container: tempDoc.body,
      pageUrl,
      pickerOutputMode: outputMode,
    });

    picker.cleanup();
  } catch (err: unknown) {
    picker.showProgress(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
      'error'
    );
    window.setTimeout(() => {
      picker.cleanup();
    }, 3000);
  } finally {
    if (window.__markScrapeActivePicker === picker) {
      window.__markScrapeActivePicker = null;
    }
  }
}

function startInteractivePicker(outputMode: PickerOutputMode = 'zip'): void {
  if (window.__markScrapeActiveModal) {
    window.__markScrapeActiveModal.close();
    window.__markScrapeActiveModal = null;
  }

  if (window.__markScrapeActivePicker) {
    window.__markScrapeActivePicker.cleanup();
    window.__markScrapeActivePicker = null;
  }

  const picker = new ElementPicker({
    outputMode,
    onSelect: async (selectedElement, activePicker) => {
      await handleElementSelected(selectedElement, outputMode, activePicker);
    },
    onCancel: () => {
      if (window.__markScrapeActivePicker === picker) {
        window.__markScrapeActivePicker = null;
      }
    },
  });

  window.__markScrapeActivePicker = picker;
  picker.start();
}

/**
 * Stage A (Full-Page Readability Preview):
 * Optionally auto-scrolls the page, clones the document, runs @mozilla/readability,
 * converts the article HTML to Markdown, extracts discovered images, and opens the Editor Tab.
 */
async function openFullPagePreviewModal(autoScroll: boolean): Promise<void> {
  if (window.__markScrapeActiveModal) {
    window.__markScrapeActiveModal.close();
    window.__markScrapeActiveModal = null;
  }
  if (window.__markScrapeActivePicker) {
    window.__markScrapeActivePicker.cleanup();
    window.__markScrapeActivePicker = null;
  }

  if (autoScroll) {
    await autoScrollLivePage();
  }

  const pageUrl = window.location.href;
  const docClone = document.cloneNode(true) as Document;
  transferShadowCodeBlocksToClone(document, docClone);

  const article = extractArticleFromDom(docClone, pageUrl);
  const parser = new DOMParser();
  const parsedArticleDoc = parser.parseFromString(
    `<!DOCTYPE html><html><body>${article.contentHtml}</body></html>`,
    'text/html'
  );

  await openEditorForContent({
    article: {
      title: article.title,
      byline: article.byline,
      siteName: article.siteName,
      excerpt: article.excerpt,
    },
    container: parsedArticleDoc.body,
    pageUrl,
    pickerOutputMode: 'zip',
  });
}

async function handleScrapePage(autoScroll: boolean): Promise<ScrapedPagePayload> {
  if (autoScroll) {
    await autoScrollLivePage();
  }

  const pageUrl = window.location.href;

  // Clone the live document so we never mutate the user's visible tab
  const docClone = document.cloneNode(true) as Document;
  transferShadowCodeBlocksToClone(document, docClone);

  const article = extractArticleFromDom(docClone, pageUrl);
  const imageUrls = collectImageUrlsFromHtml(article.contentHtml, pageUrl);

  return {
    title: article.title,
    byline: article.byline,
    siteName: article.siteName,
    excerpt: article.excerpt,
    pageUrl,
    readableHtml: article.contentHtml,
    imageUrls,
  };
}

if (!window.__markScrapeContentScriptLoaded) {
  window.__markScrapeContentScriptLoaded = true;

  chrome.runtime.onMessage.addListener(
    (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (
        response: ScrapePageResponse | StartPickerResponse | OpenFullPagePreviewResponse
      ) => void
    ) => {
      if (!message || typeof message !== 'object') {
        return false;
      }

      const msgObj = message as {
        type?: string;
        action?: string;
        outputMode?: PickerOutputMode;
        autoScroll?: boolean;
      };

      if (msgObj.type === 'START_PICKER' || msgObj.action === 'START_ELEMENT_PICKER') {
        const outputMode: PickerOutputMode =
          msgObj.outputMode === 'clipboard' ? 'clipboard' : 'zip';
        try {
          startInteractivePicker(outputMode);
          sendResponse({ ok: true });
        } catch (err: unknown) {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return false;
      }

      if (msgObj.type === 'OPEN_FULL_PAGE_PREVIEW') {
        void openFullPagePreviewModal(Boolean(msgObj.autoScroll));
        sendResponse({ ok: true });
        return false;
      }

      if (msgObj.type === 'SCRAPE_PAGE') {
        handleScrapePage(Boolean(msgObj.autoScroll))
          .then((data) => {
            sendResponse({ ok: true, data });
          })
          .catch((err: unknown) => {
            sendResponse({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          });

        // Keep the message channel open for the async response
        return true;
      }

      return false;
    }
  );
}
