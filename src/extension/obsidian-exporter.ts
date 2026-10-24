import type {
  DirectoryPickerOptions,
  FileSystemHandlePermissionDescriptor,
} from '../types.js';
import type { FetchAssetMessage, FetchAssetResponse } from './background.js';

const DB_NAME = 'markscrape_store';
const DB_VERSION = 1;
const STORE_NAME = 'handles';
const VAULT_HANDLE_KEY = 'obsidian_vault_handle';
const SETTINGS_STORAGE_KEY = 'markscrape_obsidian_settings';
const MIN_IMAGE_BYTES = 300;
const MAX_IMAGE_CONCURRENCY = 5;
const MAX_OBSIDIAN_URI_CONTENT_CHARS = 15000;

export interface ObsidianExportImageItem {
  id?: string;
  url?: string;
  remoteUrl: string;
  alt?: string;
  included?: boolean;
}

export interface ObsidianExportSettings {
  subfolder: string;
  useWikilinks: boolean;
  openInObsidian: boolean;
}

export interface ExportToObsidianVaultParams {
  vaultHandle: FileSystemDirectoryHandle;
  subfolder?: string;
  noteTitle: string;
  markdownText: string;
  selectedImages: Array<ObsidianExportImageItem | string>;
  useWikilinks?: boolean;
  openInObsidian?: boolean;
  sourceUrl?: string;
  onProgress?: (completed: number, total: number, statusText: string) => void;
}

export interface ExportToObsidianVaultResult {
  vaultName: string;
  noteFilename: string;
  relativeFilePath: string;
  writtenImagesCount: number;
  obsidianUri: string;
}

const DEFAULT_OBSIDIAN_SETTINGS: ObsidianExportSettings = {
  subfolder: 'Clippings',
  useWikilinks: false,
  openInObsidian: true,
};

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeYamlScalar(value: string): string {
  const clean = (value || '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  return `"${clean}"`;
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function decodeDataImageUri(
  dataUri: string
): { arrayBuffer: ArrayBuffer; contentType: string } | null {
  const match = dataUri.match(
    /^data:(image\/[a-zA-Z0-9.+-]+)(?:;charset=[^;,]+)?(;base64)?,(.*)$/s
  );
  if (!match) return null;

  const contentType = match[1].toLowerCase();
  const isBase64 = Boolean(match[2]);
  const rawPayload = match[3] || '';

  try {
    if (isBase64) {
      return {
        arrayBuffer: base64ToArrayBuffer(rawPayload.replace(/\s+/g, '')),
        contentType,
      };
    }
    const decodedText = decodeURIComponent(rawPayload);
    const bytes = new TextEncoder().encode(decodedText);
    return { arrayBuffer: bytes.buffer, contentType };
  } catch {
    return null;
  }
}

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
      const match = parsedUrl.pathname
        .toLowerCase()
        .match(/\.(jpg|jpeg|png|webp|svg|gif|avif|bmp|ico)$/);
      if (match && match[1]) {
        const ext = `.${match[1]}`;
        return ext === '.jpeg' ? '.jpg' : ext;
      }
    }
  } catch {
    // Ignore URL parse errors
  }

  return '.jpg';
}

async function sha256Hex12(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(digest));
  const fullHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  return fullHex.slice(0, 12);
}

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
 * Opens the native IndexedDB database (`markscrape_store`) used to persist `FileSystemDirectoryHandle`.
 */
function openHandlesDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this browser context.'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error || new Error('Failed to open IndexedDB for Vault handle storage.'));
    };
  });
}

/**
 * Retrieves the previously saved Obsidian Vault `FileSystemDirectoryHandle` from IndexedDB (`markscrape_store` -> `handles`).
 */
export async function getSavedVaultHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openHandlesDatabase();
    return await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(VAULT_HANDLE_KEY);

      req.onsuccess = () => {
        const result = req.result as FileSystemDirectoryHandle | undefined;
        resolve(result ?? null);
      };

      req.onerror = () => {
        reject(req.error || new Error('Failed to read Vault directory handle from IndexedDB.'));
      };

      tx.oncomplete = () => {
        db.close();
      };
    });
  } catch {
    return null;
  }
}

/**
 * Persists the user's selected Obsidian Vault `FileSystemDirectoryHandle` in IndexedDB (`markscrape_store` -> `handles`).
 */
export async function saveVaultHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openHandlesDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(handle, VAULT_HANDLE_KEY);

    req.onsuccess = () => {
      resolve();
    };

    req.onerror = () => {
      reject(req.error || new Error('Failed to save Vault directory handle to IndexedDB.'));
    };

    tx.oncomplete = () => {
      db.close();
    };
  });
}

/**
 * Verifies or requests `readwrite` permission on a `FileSystemDirectoryHandle`.
 */
export async function ensureVaultPermission(
  handle: FileSystemDirectoryHandle
): Promise<boolean> {
  const descriptor: FileSystemHandlePermissionDescriptor = { mode: 'readwrite' };
  try {
    if (typeof handle.queryPermission === 'function') {
      const currentPerm = await handle.queryPermission(descriptor);
      if (currentPerm === 'granted') {
        return true;
      }
    }

    if (typeof handle.requestPermission === 'function') {
      const requestedPerm = await handle.requestPermission(descriptor);
      return requestedPerm === 'granted';
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Prompts the user to select their local Obsidian Vault folder via `window.showDirectoryPicker({ mode: 'readwrite' })`
 * and persists the resulting `FileSystemDirectoryHandle` in IndexedDB.
 */
export async function pickVaultDirectory(
  options?: DirectoryPickerOptions
): Promise<FileSystemDirectoryHandle> {
  if (typeof window.showDirectoryPicker !== 'function') {
    throw new Error(
      'File System Access API (window.showDirectoryPicker) is not supported in this browser.'
    );
  }

  const handle = await window.showDirectoryPicker({
    mode: 'readwrite',
    ...options,
  });

  await saveVaultHandle(handle);
  return handle;
}

/**
 * Loads saved Obsidian export preferences (subfolder, wikilinks, auto-open) from `chrome.storage.local` or `localStorage`.
 */
export async function loadObsidianSettings(): Promise<ObsidianExportSettings> {
  try {
    if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
      const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
      const raw = stored?.[SETTINGS_STORAGE_KEY] as Partial<ObsidianExportSettings> | undefined;
      if (raw && typeof raw === 'object') {
        return {
          subfolder:
            typeof raw.subfolder === 'string' ? raw.subfolder : DEFAULT_OBSIDIAN_SETTINGS.subfolder,
          useWikilinks:
            typeof raw.useWikilinks === 'boolean'
              ? raw.useWikilinks
              : DEFAULT_OBSIDIAN_SETTINGS.useWikilinks,
          openInObsidian:
            typeof raw.openInObsidian === 'boolean'
              ? raw.openInObsidian
              : DEFAULT_OBSIDIAN_SETTINGS.openInObsidian,
        };
      }
    }
  } catch {
    // Fall back to localStorage
  }

  try {
    const rawJson = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (rawJson) {
      const parsed = JSON.parse(rawJson) as Partial<ObsidianExportSettings>;
      return {
        subfolder:
          typeof parsed.subfolder === 'string'
            ? parsed.subfolder
            : DEFAULT_OBSIDIAN_SETTINGS.subfolder,
        useWikilinks:
          typeof parsed.useWikilinks === 'boolean'
            ? parsed.useWikilinks
            : DEFAULT_OBSIDIAN_SETTINGS.useWikilinks,
        openInObsidian:
          typeof parsed.openInObsidian === 'boolean'
            ? parsed.openInObsidian
            : DEFAULT_OBSIDIAN_SETTINGS.openInObsidian,
      };
    }
  } catch {
    // Ignore localStorage security errors
  }

  return { ...DEFAULT_OBSIDIAN_SETTINGS };
}

/**
 * Saves Obsidian export preferences to both `localStorage` and `chrome.storage.local`.
 */
export async function saveObsidianSettings(
  partial: Partial<ObsidianExportSettings>
): Promise<ObsidianExportSettings> {
  const current = await loadObsidianSettings();
  const next: ObsidianExportSettings = {
    subfolder: partial.subfolder !== undefined ? partial.subfolder : current.subfolder,
    useWikilinks: partial.useWikilinks !== undefined ? partial.useWikilinks : current.useWikilinks,
    openInObsidian:
      partial.openInObsidian !== undefined ? partial.openInObsidian : current.openInObsidian,
  };

  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore localStorage restrictions
  }

  try {
    if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
      await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: next });
    }
  } catch {
    // Ignore chrome.storage fallback error
  }

  return next;
}

/**
 * Sanitizes a page/note title into a clean, Obsidian-safe filename (without the `.md` extension).
 */
export function sanitizeObsidianNoteTitle(noteTitle: string): string {
  const cleaned = (noteTitle || '')
    .replace(/[/\\?%*:|"<>#^\[\]]+/g, ' ')
    .replace(/[\x00-\x1f\x7f]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 120)
    .trim();

  return cleaned || 'Untitled Clipped Note';
}

/**
 * Splits a user-provided subfolder path (e.g., `"Clippings/Tech"`) into clean directory segment names.
 */
function parseSubfolderSegments(subfolder: string | undefined): string[] {
  if (!subfolder) return [];
  return subfolder
    .split(/[/\\]+/)
    .map((part) =>
      part
        .replace(/[?%*:|"<>]+/g, '')
        .replace(/[\x00-\x1f\x7f]+/g, '')
        .trim()
    )
    .filter((part) => part.length > 0 && part !== '.' && part !== '..');
}

/**
 * Fetches an image's binary ArrayBuffer via the extension's CORS-free background service worker bridge
 * (`FETCH_ASSET_BASE64`), falling back to credentialed `fetch()` or `data:image/` decoding.
 */
async function fetchImageBinaryBuffer(
  remoteUrl: string
): Promise<{ arrayBuffer: ArrayBuffer; contentType: string }> {
  if (remoteUrl.startsWith('data:image/')) {
    const decoded = decodeDataImageUri(remoteUrl);
    if (!decoded) {
      throw new Error('Invalid data:image URI');
    }
    return decoded;
  }

  if (typeof chrome !== 'undefined' && chrome?.runtime?.sendMessage) {
    try {
      const msg: FetchAssetMessage = {
        type: 'FETCH_ASSET_BASE64',
        url: remoteUrl,
      };
      const res = (await chrome.runtime.sendMessage(msg)) as FetchAssetResponse | undefined;
      if (res && res.ok) {
        return {
          arrayBuffer: base64ToArrayBuffer(res.base64),
          contentType: res.contentType || 'image/jpeg',
        };
      }
    } catch {
      // Fall back to direct browser fetch below
    }
  }

  const response = await fetch(remoteUrl, {
    credentials: 'include',
    headers: {
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const contentType = (response.headers.get('content-type') || 'image/jpeg').toLowerCase();
  return { arrayBuffer, contentType };
}

/**
 * Ensures the Markdown document's YAML frontmatter includes Obsidian-friendly properties:
 * `created`, `source`, and `tags: [clippings]`.
 */
export function ensureObsidianFrontmatter(
  markdownText: string,
  noteTitle: string,
  sourceUrl?: string
): string {
  const createdDate = new Date().toISOString().slice(0, 10);
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)*/;
  const match = markdownText.match(frontmatterRegex);

  if (match) {
    let fmBody = match[1].trim();
    const restBody = markdownText.slice(match[0].length).replace(/^\r?\n+/, '');

    // Extract source_url from existing frontmatter if sourceUrl was not explicitly provided
    let resolvedSource = sourceUrl || '';
    if (!resolvedSource) {
      const sourceUrlMatch = fmBody.match(/^source_url:\s*"?([^"\r\n]+)"?\s*$/m);
      if (sourceUrlMatch && sourceUrlMatch[1]) {
        resolvedSource = sourceUrlMatch[1].trim();
      }
    }

    if (!/^created\s*:/m.test(fmBody)) {
      fmBody += `\ncreated: ${escapeYamlScalar(createdDate)}`;
    }
    if (!/^source\s*:/m.test(fmBody) && resolvedSource) {
      fmBody += `\nsource: ${escapeYamlScalar(resolvedSource)}`;
    }
    if (!/^tags\s*:/m.test(fmBody)) {
      fmBody += `\ntags: [clippings]`;
    }

    return `---\n${fmBody}\n---\n\n${restBody}`;
  }

  const lines = [
    '---',
    `title: ${escapeYamlScalar(noteTitle || 'Untitled')}`,
    ...(sourceUrl ? [`source: ${escapeYamlScalar(sourceUrl)}`] : []),
    `created: ${escapeYamlScalar(createdDate)}`,
    'tags: [clippings]',
    '---',
  ];

  const cleanBody = markdownText.replace(/^\r?\n+/, '');
  return `${lines.join('\n')}\n\n${cleanBody}`;
}

/**
 * Rewrites remote image URLs in `markdownText` to either:
 * - Standard Markdown: `![alt](./assets/img_<hash>.<ext>)`
 * - Or Obsidian Wikilink (when `useWikilinks === true`): `![[assets/img_<hash>.<ext>]]`
 */
export function rewriteMarkdownImagesForObsidian(
  markdownText: string,
  urlToFilename: Map<string, string>,
  useWikilinks: boolean
): string {
  let updated = markdownText;

  for (const [remoteUrl, filename] of urlToFilename.entries()) {
    const escapedUrl = escapeRegExp(remoteUrl);

    if (useWikilinks) {
      const wikilinkEmbed = `![[assets/${filename}]]`;

      // Replace linked images [![alt](remoteUrl "title")](href) with ![[assets/img_<hash>.<ext>]]
      const linkedImgRegex = new RegExp(
        `\\[!\\[[^\\]]*\\]\\(${escapedUrl}(?:\\s+"[^"]*")?\\)\\]\\([^\\)]+\\)`,
        'g'
      );
      updated = updated.replace(linkedImgRegex, wikilinkEmbed);

      // Replace standard images ![alt](remoteUrl "title") with ![[assets/img_<hash>.<ext>]]
      const standardImgRegex = new RegExp(
        `!\\[[^\\]]*\\]\\(${escapedUrl}(?:\\s+"[^"]*")?\\)`,
        'g'
      );
      updated = updated.replace(standardImgRegex, wikilinkEmbed);

      // Replace any remaining bare occurrences
      updated = updated.split(remoteUrl).join(`assets/${filename}`);
    } else {
      const relativeAssetPath = `./assets/${filename}`;

      // Replace ![alt](remoteUrl "title") with ![alt](./assets/img_<hash>.<ext>)
      const standardImgRegex = new RegExp(
        `!\\[([^\\]]*)\\]\\(${escapedUrl}(?:\\s+"[^"]*")?\\)`,
        'g'
      );
      updated = updated.replace(standardImgRegex, `![$1](${relativeAssetPath})`);

      // Replace any remaining occurrences of remoteUrl
      updated = updated.split(remoteUrl).join(relativeAssetPath);
    }
  }

  return updated;
}

/**
 * Triggers an `obsidian://` custom protocol URI via a hidden `<a>` tag click (with `window.open` fallback).
 */
export function launchObsidianUri(obsidianUri: string): void {
  try {
    const anchor = document.createElement('a');
    anchor.href = obsidianUri;
    anchor.target = '_top';
    anchor.rel = 'noopener noreferrer';
    anchor.style.display = 'none';
    (document.body || document.documentElement).appendChild(anchor);
    anchor.click();
    anchor.remove();
  } catch {
    window.open(obsidianUri, '_top');
  }
}

/**
 * Fallback URI-only exporter (`obsidian://new?name=...&content=...`) for users who want to send text
 * with remote image URLs directly to Obsidian without granting local disk directory access.
 */
export async function exportViaObsidianUriOnly(
  noteTitle: string,
  markdownText: string,
  vaultName?: string
): Promise<{ obsidianUri: string; usedClipboardFallback: boolean }> {
  const sanitizedTitle = sanitizeObsidianNoteTitle(noteTitle);
  const enrichedMarkdown = ensureObsidianFrontmatter(markdownText, sanitizedTitle);
  const vaultParam = vaultName?.trim()
    ? `&vault=${encodeURIComponent(vaultName.trim())}`
    : '';

  if (enrichedMarkdown.length > MAX_OBSIDIAN_URI_CONTENT_CHARS) {
    await navigator.clipboard.writeText(enrichedMarkdown);
    const obsidianUri = `obsidian://new?name=${encodeURIComponent(sanitizedTitle)}${vaultParam}&clipboard=true`;
    launchObsidianUri(obsidianUri);
    return { obsidianUri, usedClipboardFallback: true };
  }

  const obsidianUri = `obsidian://new?name=${encodeURIComponent(sanitizedTitle)}${vaultParam}&content=${encodeURIComponent(enrichedMarkdown)}`;
  launchObsidianUri(obsidianUri);
  return { obsidianUri, usedClipboardFallback: false };
}

/**
 * Direct Vault File & Asset Writer:
 * - Resolves/creates nested `subfolder` directories inside `vaultHandle`
 * - Creates `./assets` inside the target folder
 * - Concurrently fetches selected images via the extension bridge, hashes via Web Crypto SHA-256 (`img_<12-char-hash>.<ext>`),
 *   and writes each binary ArrayBuffer directly to `<target>/assets/img_<hash>.<ext>`
 * - Rewrites Markdown image links to `./assets/img_<hash>.<ext>` or `![[assets/img_<hash>.<ext>]]`
 * - Ensures Obsidian YAML frontmatter (`created`, `source`, `tags: [clippings]`)
 * - Writes `<sanitized-noteTitle>.md` to `targetDirHandle`
 * - Optionally opens the newly created note in Obsidian via `obsidian://open`
 */
export async function exportToObsidianVault(
  params: ExportToObsidianVaultParams
): Promise<ExportToObsidianVaultResult> {
  const {
    vaultHandle,
    subfolder = 'Clippings',
    noteTitle,
    markdownText,
    selectedImages,
    useWikilinks = false,
    openInObsidian = true,
    sourceUrl,
    onProgress,
  } = params;

  const hasPermission = await ensureVaultPermission(vaultHandle);
  if (!hasPermission) {
    throw new Error('Read/write permission for the Obsidian Vault folder was denied.');
  }

  // 1. Resolve or create nested subfolder directories inside the Vault
  let targetDirHandle: FileSystemDirectoryHandle = vaultHandle;
  const subfolderParts = parseSubfolderSegments(subfolder);
  for (const part of subfolderParts) {
    targetDirHandle = await targetDirHandle.getDirectoryHandle(part, { create: true });
  }

  // 2. Create `assets` directory inside the target folder
  const assetsDirHandle = await targetDirHandle.getDirectoryHandle('assets', { create: true });

  // 3. Collect deduplicated remote URLs for included images
  const uniqueImageUrls = Array.from(
    new Set(
      selectedImages
        .filter((item) => (typeof item === 'string' ? true : item.included !== false))
        .map((item) => (typeof item === 'string' ? item : item.remoteUrl || item.url || ''))
        .filter(Boolean)
    )
  );

  const totalImages = uniqueImageUrls.length;
  const urlToFilename = new Map<string, string>();
  const writtenFilenames = new Set<string>();
  let completedImages = 0;

  if (totalImages > 0) {
    onProgress?.(0, totalImages, `Writing ${totalImages} ${totalImages === 1 ? 'image' : 'images'} to Vault...`);

    await runWithConcurrency(uniqueImageUrls, MAX_IMAGE_CONCURRENCY, async (remoteUrl) => {
      try {
        const { arrayBuffer, contentType } = await fetchImageBinaryBuffer(remoteUrl);

        if (arrayBuffer && arrayBuffer.byteLength >= MIN_IMAGE_BYTES) {
          const hash = await sha256Hex12(arrayBuffer);
          const ext = resolveImageExtension(contentType, remoteUrl);
          const filename = `img_${hash}${ext}`;

          if (!writtenFilenames.has(filename)) {
            writtenFilenames.add(filename);
            const fileHandle = await assetsDirHandle.getFileHandle(filename, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(arrayBuffer);
            await writable.close();
          }

          urlToFilename.set(remoteUrl, filename);
        }
      } catch {
        // Keep remote URL intact in Markdown if an individual image fails to fetch or write
      } finally {
        completedImages += 1;
        onProgress?.(
          completedImages,
          totalImages,
          `Writing ${completedImages}/${totalImages} images to Vault...`
        );
      }
    });
  }

  onProgress?.(totalImages, totalImages, 'Writing Markdown note to Obsidian Vault...');

  // 4. Rewrite remote image URLs to Markdown or Obsidian ![[Wikilinks]]
  const localizedMarkdown = rewriteMarkdownImagesForObsidian(
    markdownText,
    urlToFilename,
    useWikilinks
  );

  // 5. Ensure YAML frontmatter includes Obsidian-friendly properties (created, source, tags: [clippings])
  const sanitizedTitle = sanitizeObsidianNoteTitle(noteTitle);
  const finalMarkdown = ensureObsidianFrontmatter(localizedMarkdown, sanitizedTitle, sourceUrl);

  // 6. Write `<sanitized-noteTitle>.md` to `targetDirHandle`
  const noteFilename = `${sanitizedTitle}.md`;
  const noteFileHandle = await targetDirHandle.getFileHandle(noteFilename, { create: true });
  const noteWritable = await noteFileHandle.createWritable();
  await noteWritable.write(new TextEncoder().encode(finalMarkdown));
  await noteWritable.close();

  // 7. Construct relative vault path and `obsidian://open` URI
  const relativeFilePath =
    subfolderParts.length > 0
      ? `${subfolderParts.join('/')}/${noteFilename}`
      : noteFilename;

  const obsidianUri = `obsidian://open?vault=${encodeURIComponent(
    vaultHandle.name
  )}&file=${encodeURIComponent(relativeFilePath)}`;

  if (openInObsidian) {
    launchObsidianUri(obsidianUri);
  }

  return {
    vaultName: vaultHandle.name,
    noteFilename,
    relativeFilePath,
    writtenImagesCount: writtenFilenames.size,
    obsidianUri,
  };
}

export const ObsidianExporter = {
  getSavedVaultHandle,
  saveVaultHandle,
  ensureVaultPermission,
  pickVaultDirectory,
  loadObsidianSettings,
  saveObsidianSettings,
  sanitizeObsidianNoteTitle,
  ensureObsidianFrontmatter,
  rewriteMarkdownImagesForObsidian,
  exportToObsidianVault,
  exportViaObsidianUriOnly,
  launchObsidianUri,
};
