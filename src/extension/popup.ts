import JSZip from 'jszip';
import { buildMarkdownDocument, convertHtmlToMarkdown } from '../core/converter.js';
import { resolveUrl } from '../core/dom-preparer.js';
import type {
  ScrapedPagePayload,
  ScrapePageMessage,
  ScrapePageResponse,
  StartPickerMessage,
  StartPickerResponse,
} from './content-script.js';
import type { PickerOutputMode } from './element-picker.js';
import type {
  EditorImageItem,
  FetchAssetMessage,
  FetchAssetResponse,
  OpenEditorTabMessage,
  OpenEditorTabResponse,
} from './background.js';

const MIN_IMAGE_BYTES = 300;
const MAX_CONCURRENCY = 5;

/**
 * Determines file extension from Content-Type header or URL pathname fallback (zero Node path imports).
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
      const match = parsedUrl.pathname.toLowerCase().match(/\.(jpg|jpeg|png|webp|svg|gif|avif)$/);
      if (match && match[1]) {
        const ext = `.${match[1]}`;
        return ext === '.jpeg' ? '.jpg' : ext;
      }
    }
  } catch {
    // Ignore URL parse error
  }

  return '.jpg';
}

/**
 * Decodes a data:image/... URI into an ArrayBuffer and Content-Type using native browser APIs.
 */
function decodeDataImageUri(dataUri: string): { buffer: ArrayBuffer; contentType: string } | null {
  const match = dataUri.match(
    /^data:(image\/[a-zA-Z0-9.+-]+)(?:;charset=[^;,]+)?(;base64)?,(.*)$/s
  );
  if (!match) return null;

  const contentType = match[1].toLowerCase();
  const isBase64 = Boolean(match[2]);
  const rawPayload = match[3] || '';

  try {
    if (isBase64) {
      const binaryString = atob(rawPayload.replace(/\s+/g, ''));
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return { buffer: bytes.buffer, contentType };
    } else {
      const decodedText = decodeURIComponent(rawPayload);
      const bytes = new TextEncoder().encode(decodedText);
      return { buffer: bytes.buffer, contentType };
    }
  } catch {
    return null;
  }
}

/**
 * Converts a Base64 string back into an ArrayBuffer.
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Computes a 12-character hex SHA-256 hash using the browser's native Web Crypto API.
 */
async function sha256Hex12(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(digest));
  const fullHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  return fullHex.slice(0, 12);
}

/**
 * Converts an article title or URL into a clean filesystem-safe slug for the .zip download.
 */
function createPageSlug(title: string, pageUrl: string): string {
  const base = (title || '').trim();
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

  if (slug.length > 0) {
    return slug;
  }

  try {
    const hostname = new URL(pageUrl).hostname.replace(/^www\./i, '').replace(/[^a-z0-9.-]/gi, '-');
    return `${hostname}-scrape`;
  } catch {
    return 'markscrape-bundle';
  }
}

/**
 * Simple concurrency limiter for browser async tasks (zero external dependencies).
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
 * Fetches an image binary with credentials included, falling back to background service worker if needed.
 */
async function fetchImageBinary(
  url: string
): Promise<{ buffer: ArrayBuffer; contentType: string }> {
  try {
    const response = await fetch(url, {
      credentials: 'include',
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    const contentType = (response.headers.get('content-type') || 'image/jpeg').toLowerCase();
    return { buffer, contentType };
  } catch {
    // Fallback: ask background service worker to fetch on behalf of the popup
    const message: FetchAssetMessage = { type: 'FETCH_ASSET_BASE64', url };
    const bgRes = (await chrome.runtime.sendMessage(message)) as FetchAssetResponse | undefined;
    if (!bgRes || !bgRes.ok) {
      throw new Error(bgRes?.error || 'Failed to fetch image');
    }
    return {
      buffer: base64ToArrayBuffer(bgRes.base64),
      contentType: bgRes.contentType,
    };
  }
}

/**
 * Sends SCRAPE_PAGE to the active tab, dynamically injecting content-script.js first if needed.
 */
async function requestScrapeFromTab(
  tabId: number,
  autoScroll: boolean
): Promise<ScrapedPagePayload> {
  const message: ScrapePageMessage = {
    type: 'SCRAPE_PAGE',
    autoScroll,
  };

  let response: ScrapePageResponse | undefined;
  try {
    response = (await chrome.tabs.sendMessage(tabId, message)) as ScrapePageResponse | undefined;
  } catch {
    // Content script not yet injected on this tab (e.g., tab was open prior to extension load)
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-script.js'],
    });
    response = (await chrome.tabs.sendMessage(tabId, message)) as ScrapePageResponse | undefined;
  }

  if (!response) {
    throw new Error('No response received from page content script.');
  }
  if (!response.ok) {
    throw new Error(response.error || 'Content script failed to extract page.');
  }
  return response.data;
}

/**
 * Sends START_PICKER to the active tab (injecting content-script.js first if needed)
 * and immediately closes the popup window so the user can interact with the webpage unobstructed.
 */
async function startElementPickerInTab(
  tabId: number,
  outputMode: PickerOutputMode
): Promise<void> {
  const message: StartPickerMessage = {
    type: 'START_PICKER',
    outputMode,
  };

  let response: StartPickerResponse | undefined;
  try {
    response = (await chrome.tabs.sendMessage(tabId, message)) as StartPickerResponse | undefined;
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-script.js'],
    });
    response = (await chrome.tabs.sendMessage(tabId, message)) as StartPickerResponse | undefined;
  }

  if (response && !response.ok) {
    throw new Error(response.error || 'Failed to start element picker on tab.');
  }

  window.close();
}

/**
 * Extracts the full article from the active tab, prepares Markdown + discovered image objects,
 * and opens the dedicated MarkScrape Preview & Edit Studio page (`editor.html`) in a new tab.
 */
async function openFullPagePreviewInTab(tabId: number, autoScroll: boolean): Promise<void> {
  setStatus(autoScroll ? 'Scrolling page...' : 'Extracting article...', 25);

  const payload = await requestScrapeFromTab(tabId, autoScroll);

  setStatus('Preparing Markdown & images...', 75);
  const parser = new DOMParser();
  const doc = parser.parseFromString(
    `<!DOCTYPE html><html><body>${payload.readableHtml}</body></html>`,
    'text/html'
  );

  const seenUrls = new Set<string>();
  const images: EditorImageItem[] = [];

  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const rawSrc = img.getAttribute('src');
    const resolved = resolveUrl(rawSrc, payload.pageUrl);
    if (!resolved) {
      img.remove();
      continue;
    }

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
      images.push({
        id: `img-${images.length + 1}`,
        url: resolved,
        remoteUrl: resolved,
        alt,
        included: true,
      });
    }
  }

  const markdownBody = convertHtmlToMarkdown(doc.body);
  const fullDocument = buildMarkdownDocument({
    article: {
      title: payload.title,
      byline: payload.byline,
      siteName: payload.siteName,
      excerpt: payload.excerpt,
    },
    markdownBody,
    sourceUrl: payload.pageUrl,
  });

  const fmMatch = fullDocument.match(/^(---\r?\n[\s\S]*?\r?\n---)\r?\n+([\s\S]*)$/);
  const frontmatterYaml = fmMatch ? fmMatch[1].trim() : '';
  const initialBodyMarkdown = fmMatch ? fmMatch[2].trim() : fullDocument.trim();

  setStatus('Opening Preview & Edit Studio...', 95);

  const openMsg: OpenEditorTabMessage = {
    type: 'OPEN_EDITOR_TAB',
    payload: {
      pageTitle: payload.title,
      pageUrl: payload.pageUrl,
      frontmatterYaml,
      initialBodyMarkdown,
      images,
      sourceTabId: tabId,
    },
  };

  const openRes = (await chrome.runtime.sendMessage(openMsg)) as OpenEditorTabResponse | undefined;
  if (!openRes || !openRes.ok) {
    throw new Error(openRes?.error || 'Failed to open Preview & Edit tab.');
  }

  window.close();
}

// UI Elements
const tabDomainEl = document.getElementById('tab-domain') as HTMLElement;
const tabTitleEl = document.getElementById('tab-title') as HTMLElement;
const autoScrollCheckbox = document.getElementById('auto-scroll-checkbox') as HTMLInputElement;
const pickZipBtn = document.getElementById('pick-zip-btn') as HTMLButtonElement;
const previewPageBtn = document.getElementById('preview-page-btn') as HTMLButtonElement;
const downloadZipBtn = document.getElementById('download-zip-btn') as HTMLButtonElement;
const copyMdBtn = document.getElementById('copy-md-btn') as HTMLButtonElement;
const statusPanel = document.getElementById('status-panel') as HTMLElement;
const statusText = document.getElementById('status-text') as HTMLElement;
const statusPercent = document.getElementById('status-percent') as HTMLElement;
const progressFill = document.getElementById('progress-fill') as HTMLElement;
const statsRow = document.getElementById('stats-row') as HTMLElement;
const statsImages = document.getElementById('stats-images') as HTMLElement;
const statsTime = document.getElementById('stats-time') as HTMLElement;

let activeTab: chrome.tabs.Tab | null = null;

function setStatus(
  text: string,
  percent: number,
  variant: 'normal' | 'success' | 'error' = 'normal'
): void {
  statusPanel.classList.add('visible');
  statusText.textContent = text;
  statusText.className = `status-text ${variant === 'normal' ? '' : variant}`.trim();
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  statusPercent.textContent = `${clamped}%`;
  progressFill.style.width = `${clamped}%`;
}

function setButtonsDisabled(disabled: boolean): void {
  pickZipBtn.disabled = disabled;
  previewPageBtn.disabled = disabled;
  downloadZipBtn.disabled = disabled;
  copyMdBtn.disabled = disabled;
  autoScrollCheckbox.disabled = disabled;
}

async function initPopup(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      tabDomainEl.textContent = 'Unavailable';
      tabTitleEl.textContent = 'No active browser tab found.';
      setButtonsDisabled(true);
      return;
    }

    activeTab = tab;
    const rawUrl = tab.url || '';
    let domain = 'Browser Page';
    try {
      const parsed = new URL(rawUrl);
      domain = parsed.hostname || parsed.protocol.replace(':', '');
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        tabDomainEl.textContent = domain;
        tabTitleEl.textContent =
          'Cannot scrape restricted browser internal pages (open an http/https webpage).';
        setButtonsDisabled(true);
        return;
      }
    } catch {
      // Keep default
    }

    tabDomainEl.textContent = domain;
    tabTitleEl.textContent = tab.title || rawUrl || 'Untitled Page';
  } catch (err) {
    tabDomainEl.textContent = 'Error';
    tabTitleEl.textContent = err instanceof Error ? err.message : String(err);
    setButtonsDisabled(true);
  }
}

pickZipBtn.addEventListener('click', async () => {
  if (!activeTab?.id) return;
  setButtonsDisabled(true);
  try {
    await startElementPickerInTab(activeTab.id, 'zip');
  } catch (err) {
    setButtonsDisabled(false);
    setStatus(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
      100,
      'error'
    );
  }
});

previewPageBtn.addEventListener('click', async () => {
  if (!activeTab?.id) return;
  setButtonsDisabled(true);
  try {
    const autoScroll = autoScrollCheckbox.checked;
    await openFullPagePreviewInTab(activeTab.id, autoScroll);
  } catch (err) {
    setButtonsDisabled(false);
    setStatus(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
      100,
      'error'
    );
  }
});

downloadZipBtn.addEventListener('click', async () => {
  if (!activeTab?.id) return;
  const startTime = performance.now();
  setButtonsDisabled(true);
  statsRow.classList.remove('visible');

  try {
    const autoScroll = autoScrollCheckbox.checked;
    setStatus(autoScroll ? 'Scrolling page...' : 'Extracting article...', 12);

    const payload = await requestScrapeFromTab(activeTab.id, autoScroll);

    // Parse the returned Readability HTML using browser DOMParser
    const parser = new DOMParser();
    const doc = parser.parseFromString(
      `<!DOCTYPE html><html><body>${payload.readableHtml}</body></html>`,
      'text/html'
    );

    const imgElements = Array.from(doc.querySelectorAll('img'));
    const totalImages = imgElements.length;

    const zip = new JSZip();
    const assetsFolder = zip.folder('assets');
    const hashToFilename = new Map<string, string>();
    const urlToLocalPath = new Map<string, { localPath: string; hash: string } | 'TRACKING_PIXEL'>();

    let imagesDownloaded = 0;
    let duplicatesSkipped = 0;
    let completedElements = 0;

    if (totalImages > 0) {
      setStatus(`Downloading ${totalImages} images...`, 25);
    } else {
      setStatus('Converting HTML to Markdown...', 65);
    }

    await runWithConcurrency(imgElements, MAX_CONCURRENCY, async (img) => {
      const rawSrc = img.getAttribute('src');
      const resolvedSrc = resolveUrl(rawSrc, payload.pageUrl);

      if (!resolvedSrc) {
        img.remove();
        completedElements += 1;
        return;
      }

      try {
        // Check if this exact URL was already fetched during this run
        const existingUrlEntry = urlToLocalPath.get(resolvedSrc);
        if (existingUrlEntry === 'TRACKING_PIXEL') {
          img.remove();
          completedElements += 1;
          return;
        }
        if (existingUrlEntry) {
          duplicatesSkipped += 1;
          img.setAttribute('src', existingUrlEntry.localPath);
          img.removeAttribute('srcset');
          img.removeAttribute('sizes');
          img.removeAttribute('loading');
          completedElements += 1;
          return;
        }

        let buffer: ArrayBuffer;
        let contentType = 'image/jpeg';

        if (resolvedSrc.startsWith('data:image/')) {
          const decoded = decodeDataImageUri(resolvedSrc);
          if (!decoded) {
            img.remove();
            completedElements += 1;
            return;
          }
          buffer = decoded.buffer;
          contentType = decoded.contentType;
        } else {
          const fetched = await fetchImageBinary(resolvedSrc);
          buffer = fetched.buffer;
          contentType = fetched.contentType;
        }

        // Filter out < 300 byte tracking pixels
        if (!buffer || buffer.byteLength < MIN_IMAGE_BYTES) {
          urlToLocalPath.set(resolvedSrc, 'TRACKING_PIXEL');
          img.remove();
          completedElements += 1;
          return;
        }

        const hash = await sha256Hex12(buffer);
        const ext = resolveImageExtension(contentType, resolvedSrc);
        const filename = hashToFilename.get(hash) ?? `img_${hash}${ext}`;
        const localPath = `./assets/${filename}`;

        if (hashToFilename.has(hash)) {
          duplicatesSkipped += 1;
        } else {
          hashToFilename.set(hash, filename);
          assetsFolder?.file(filename, buffer);
          imagesDownloaded += 1;
        }

        urlToLocalPath.set(resolvedSrc, { localPath, hash });
        img.setAttribute('src', localPath);
        img.removeAttribute('srcset');
        img.removeAttribute('sizes');
        img.removeAttribute('loading');
      } catch {
        // Keep remote URL if download fails
        img.setAttribute('src', resolvedSrc);
      } finally {
        completedElements += 1;
        if (totalImages > 0) {
          const progress = 25 + (completedElements / totalImages) * 50;
          setStatus(
            `Downloading ${totalImages} images (${completedElements}/${totalImages})...`,
            progress
          );
        }
      }
    });

    setStatus('Converting to GFM Markdown...', 80);
    const markdownBody = convertHtmlToMarkdown(doc.body);
    const finalMarkdown = buildMarkdownDocument({
      article: {
        title: payload.title,
        byline: payload.byline,
        siteName: payload.siteName,
        excerpt: payload.excerpt,
      },
      markdownBody,
      sourceUrl: payload.pageUrl,
    });

    setStatus('Generating ZIP...', 90);
    zip.file('index.md', finalMarkdown);

    const zipBlob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    const slug = createPageSlug(payload.title, payload.pageUrl);
    const blobUrl = URL.createObjectURL(zipBlob);

    await chrome.downloads.download({
      url: blobUrl,
      filename: `${slug}.zip`,
      saveAs: false,
    });

    // Release object URL after download starts
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);

    const elapsedSec = ((performance.now() - startTime) / 1000).toFixed(2);
    setStatus(`Downloaded ${slug}.zip`, 100, 'success');
    statsImages.textContent = `${imagesDownloaded} saved, ${duplicatesSkipped} deduped`;
    statsTime.textContent = `${elapsedSec}s`;
    statsRow.classList.add('visible');
  } catch (err) {
    setStatus(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
      100,
      'error'
    );
  } finally {
    setButtonsDisabled(false);
  }
});

copyMdBtn.addEventListener('click', async () => {
  if (!activeTab?.id) return;
  const startTime = performance.now();
  setButtonsDisabled(true);
  statsRow.classList.remove('visible');

  try {
    const autoScroll = autoScrollCheckbox.checked;
    setStatus(autoScroll ? 'Scrolling page...' : 'Extracting article...', 25);

    const payload = await requestScrapeFromTab(activeTab.id, autoScroll);

    setStatus('Converting HTML to Markdown...', 70);
    const parser = new DOMParser();
    const doc = parser.parseFromString(
      `<!DOCTYPE html><html><body>${payload.readableHtml}</body></html>`,
      'text/html'
    );

    const markdownBody = convertHtmlToMarkdown(doc.body);
    const finalMarkdown = buildMarkdownDocument({
      article: {
        title: payload.title,
        byline: payload.byline,
        siteName: payload.siteName,
        excerpt: payload.excerpt,
      },
      markdownBody,
      sourceUrl: payload.pageUrl,
    });

    await navigator.clipboard.writeText(finalMarkdown);

    const elapsedSec = ((performance.now() - startTime) / 1000).toFixed(2);
    setStatus('Copied Markdown to clipboard!', 100, 'success');
    statsImages.textContent = `${payload.imageUrls.length} remote image links`;
    statsTime.textContent = `${elapsedSec}s`;
    statsRow.classList.add('visible');
  } catch (err) {
    setStatus(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
      100,
      'error'
    );
  } finally {
    setButtonsDisabled(false);
  }
});

void initPopup();
