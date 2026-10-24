/**
 * MarkScrape Manifest V3 Background Service Worker
 * Handles cross-origin image fetching, Web Crypto SHA-256 hashing, JSZip archive creation,
 * and browser download triggering so scraping jobs survive after popup.html closes.
 */

import JSZip from 'jszip';

const MIN_IMAGE_BYTES = 300;

export interface FetchAssetMessage {
  type: 'FETCH_ASSET_BASE64';
  url: string;
}

export type FetchAssetResponse =
  | { ok: true; base64: string; contentType: string; byteLength: number }
  | { ok: false; error: string };

export interface FetchAndHashAssetMessage {
  type: 'FETCH_AND_HASH_ASSET';
  url: string;
}

export type FetchAndHashAssetResponse =
  | {
      ok: true;
      skippedTrackingPixel: true;
    }
  | {
      ok: true;
      skippedTrackingPixel: false;
      hash: string;
      ext: string;
      filename: string;
      localPath: string;
      base64: string;
      contentType: string;
      byteLength: number;
    }
  | {
      ok: false;
      error: string;
    };

export interface ZipAssetEntry {
  filename: string;
  base64: string;
}

export interface BuildAndDownloadZipMessage {
  type: 'BUILD_AND_DOWNLOAD_ZIP';
  title: string;
  pageUrl: string;
  markdown: string;
  assets: ZipAssetEntry[];
  selectedImageUrls?: string[];
  sanitizedHtml?: string;
  imageUrls?: string[];
}

export type BuildAndDownloadZipResponse =
  | {
      ok: true;
      filename: string;
      triggeredDownload: boolean;
      downloadedImagesCount: number;
      zipBase64?: string;
    }
  | {
      ok: false;
      error: string;
    };

export interface EditorImageItem {
  id: string;
  url: string;
  remoteUrl: string;
  alt: string;
  included: boolean;
}

export interface EditorSessionPayload {
  pageTitle: string;
  pageUrl: string;
  frontmatterYaml: string;
  initialBodyMarkdown: string;
  images: EditorImageItem[];
  sourceTabId?: number;
}

export interface OpenEditorTabMessage {
  type: 'OPEN_EDITOR_TAB';
  payload: EditorSessionPayload;
}

export type OpenEditorTabResponse =
  | { ok: true; editorTabId?: number }
  | { ok: false; error: string };

export interface GetEditorSessionMessage {
  type: 'GET_EDITOR_SESSION';
}

export type GetEditorSessionResponse =
  | { ok: true; session: EditorSessionPayload }
  | { ok: false; error: string };

type BackgroundMessage =
  | FetchAssetMessage
  | FetchAndHashAssetMessage
  | BuildAndDownloadZipMessage
  | OpenEditorTabMessage
  | GetEditorSessionMessage;

let latestEditorSession: EditorSessionPayload | null = null;
const SESSION_STORAGE_KEY = 'markscrape_editor_session';

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Determines file extension from Content-Type header or URL pathname fallback.
 */
export function resolveImageExtension(contentType: string, sourceUrl: string): string {
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
 * Decodes a data:image/... URI into an ArrayBuffer and Content-Type.
 */
export function decodeDataImageUri(
  dataUri: string
): { buffer: ArrayBuffer; contentType: string } | null {
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
 * Computes a 12-character hex SHA-256 hash using the Web Crypto API.
 */
export async function sha256Hex12(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(digest));
  const fullHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  return fullHex.slice(0, 12);
}

/**
 * Converts an article title or URL into a clean filesystem-safe slug for the .zip download.
 */
export function createPageSlug(title: string, pageUrl: string): string {
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

async function fetchRawAssetBuffer(
  url: string
): Promise<{ buffer: ArrayBuffer; contentType: string }> {
  if (url.startsWith('data:image/')) {
    const decoded = decodeDataImageUri(url);
    if (!decoded) {
      throw new Error('Invalid data:image URI');
    }
    return decoded;
  }

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
}

async function handleFetchAndHashAsset(url: string): Promise<FetchAndHashAssetResponse> {
  try {
    const { buffer, contentType } = await fetchRawAssetBuffer(url);
    if (!buffer || buffer.byteLength < MIN_IMAGE_BYTES) {
      return {
        ok: true,
        skippedTrackingPixel: true,
      };
    }

    const hash = await sha256Hex12(buffer);
    const ext = resolveImageExtension(contentType, url);
    const filename = `img_${hash}${ext}`;
    const localPath = `./assets/${filename}`;

    return {
      ok: true,
      skippedTrackingPixel: false,
      hash,
      ext,
      filename,
      localPath,
      base64: arrayBufferToBase64(buffer),
      contentType,
      byteLength: buffer.byteLength,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function handleBuildAndDownloadZip(
  msg: BuildAndDownloadZipMessage
): Promise<BuildAndDownloadZipResponse> {
  try {
    const zip = new JSZip();
    const assetsFolder = zip.folder('assets');
    let finalMarkdown = msg.markdown;
    let downloadedImagesCount = 0;

    if (msg.assets && msg.assets.length > 0) {
      for (const asset of msg.assets) {
        assetsFolder?.file(asset.filename, base64ToUint8Array(asset.base64));
      }
      downloadedImagesCount = msg.assets.length;
    } else if (msg.selectedImageUrls && msg.selectedImageUrls.length > 0) {
      const uniqueUrls = Array.from(new Set(msg.selectedImageUrls));
      const hashToFilename = new Map<string, string>();

      for (const remoteUrl of uniqueUrls) {
        const res = await handleFetchAndHashAsset(remoteUrl);
        if (!res.ok || res.skippedTrackingPixel) {
          continue;
        }
        const filename = hashToFilename.get(res.hash) ?? res.filename;
        const localPath = `./assets/${filename}`;
        if (!hashToFilename.has(res.hash)) {
          hashToFilename.set(res.hash, filename);
          assetsFolder?.file(filename, base64ToUint8Array(res.base64));
          downloadedImagesCount += 1;
        }
        finalMarkdown = finalMarkdown.split(remoteUrl).join(localPath);
      }
    }

    zip.file('index.md', finalMarkdown);

    const zipBase64 = await zip.generateAsync({
      type: 'base64',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    const slug = createPageSlug(msg.title, msg.pageUrl);
    const filename = `${slug}.zip`;
    const dataUrl = `data:application/zip;base64,${zipBase64}`;

    let triggeredDownload = false;
    try {
      if (chrome?.downloads?.download) {
        await chrome.downloads.download({
          url: dataUrl,
          filename,
          saveAs: false,
        });
        triggeredDownload = true;
      }
    } catch {
      // Fallback to content-script anchor download if service worker data URL download fails
      triggeredDownload = false;
    }

    return {
      ok: true,
      filename,
      triggeredDownload,
      downloadedImagesCount,
      zipBase64: triggeredDownload ? undefined : zipBase64,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.info('[MarkScrape] Extension installed and service worker initialized.');
});

chrome.runtime.onMessage.addListener(
  (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (
      response:
        | FetchAssetResponse
        | FetchAndHashAssetResponse
        | BuildAndDownloadZipResponse
        | OpenEditorTabResponse
        | GetEditorSessionResponse
    ) => void
  ) => {
    if (!message || typeof message !== 'object' || !('type' in message)) {
      return false;
    }

    const typedMessage = message as BackgroundMessage;

    if (typedMessage.type === 'OPEN_EDITOR_TAB') {
      (async () => {
        try {
          const sourceTabId = typedMessage.payload.sourceTabId ?? sender.tab?.id;
          const session: EditorSessionPayload = {
            ...typedMessage.payload,
            sourceTabId,
          };
          latestEditorSession = session;

          try {
            if (chrome?.storage?.local) {
              await chrome.storage.local.set({ [SESSION_STORAGE_KEY]: session });
            }
          } catch {
            // Ignore storage fallback error
          }

          const createdTab = await chrome.tabs.create({
            url: chrome.runtime.getURL('editor.html'),
            active: true,
          });

          sendResponse({ ok: true, editorTabId: createdTab.id });
        } catch (err: unknown) {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return true;
    }

    if (typedMessage.type === 'GET_EDITOR_SESSION') {
      (async () => {
        try {
          if (latestEditorSession) {
            sendResponse({ ok: true, session: latestEditorSession });
            return;
          }

          if (chrome?.storage?.local) {
            const stored = await chrome.storage.local.get(SESSION_STORAGE_KEY);
            const session = stored?.[SESSION_STORAGE_KEY] as EditorSessionPayload | undefined;
            if (session) {
              latestEditorSession = session;
              sendResponse({ ok: true, session });
              return;
            }
          }

          sendResponse({
            ok: false,
            error: 'No scraped content session found. Please scrape a page or pick an element first.',
          });
        } catch (err: unknown) {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return true;
    }

    if (typedMessage.type === 'FETCH_ASSET_BASE64') {
      (async () => {
        try {
          const { buffer, contentType } = await fetchRawAssetBuffer(typedMessage.url);
          sendResponse({
            ok: true,
            base64: arrayBufferToBase64(buffer),
            contentType,
            byteLength: buffer.byteLength,
          });
        } catch (err: unknown) {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return true;
    }

    if (typedMessage.type === 'FETCH_AND_HASH_ASSET') {
      void handleFetchAndHashAsset(typedMessage.url).then(sendResponse);
      return true;
    }

    if (typedMessage.type === 'BUILD_AND_DOWNLOAD_ZIP') {
      void handleBuildAndDownloadZip(typedMessage).then(sendResponse);
      return true;
    }

    return false;
  }
);
