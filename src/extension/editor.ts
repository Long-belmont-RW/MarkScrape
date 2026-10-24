import JSZip from 'jszip';
import {
  createPageSlug,
  type EditorImageItem,
  type EditorSessionPayload,
  type FetchAndHashAssetMessage,
  type FetchAndHashAssetResponse,
  type FetchAssetMessage,
  type FetchAssetResponse,
  type GetEditorSessionMessage,
  type GetEditorSessionResponse,
} from './background.js';
import type { StartPickerMessage } from './content-script.js';
import {
  ensureVaultPermission,
  exportToObsidianVault,
  exportViaObsidianUriOnly,
  getSavedVaultHandle,
  loadObsidianSettings,
  pickVaultDirectory,
  saveObsidianSettings,
} from './obsidian-exporter.js';

interface RemovedImageAnchor {
  snippet: string;
  anchorBefore: string;
  anchorAfter: string;
}

const MAX_CONCURRENCY = 5;

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countWords(text: string): number {
  const withoutFrontmatter = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, '').trim();
  if (!withoutFrontmatter) return 0;
  return withoutFrontmatter.split(/\s+/).filter(Boolean).length;
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function extractFilenameFromUrl(url: string): string {
  if (url.startsWith('data:image/')) {
    return 'Inline Data Image';
  }
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    return last ? decodeURIComponent(last) : parsed.hostname;
  } catch {
    return 'Image Asset';
  }
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

// DOM Elements
const pageTitleEl = document.getElementById('page-title') as HTMLElement;
const pageUrlEl = document.getElementById('page-url') as HTMLAnchorElement;
const headerStatsPillEl = document.getElementById('header-stats-pill') as HTMLElement;
const editorCharBadgeEl = document.getElementById('editor-char-badge') as HTMLElement;
const frontmatterCheckboxEl = document.getElementById('frontmatter-checkbox') as HTMLInputElement;
const textareaEl = document.getElementById('markdown-textarea') as HTMLTextAreaElement;
const galleryCountHeadingEl = document.getElementById('gallery-count-heading') as HTMLElement;
const toggleAllBtnEl = document.getElementById('toggle-all-btn') as HTMLButtonElement;
const imageGridEl = document.getElementById('image-grid') as HTMLElement;
const repickBtnEl = document.getElementById('repick-btn') as HTMLButtonElement;
const progressBoxEl = document.getElementById('progress-box') as HTMLElement;
const progressFillEl = document.getElementById('progress-fill') as HTMLElement;
const progressTextEl = document.getElementById('progress-text') as HTMLElement;
const copyMdBtnEl = document.getElementById('copy-md-btn') as HTMLButtonElement;
const downloadZipBtnEl = document.getElementById('download-zip-btn') as HTMLButtonElement;
const saveObsidianBtnEl = document.getElementById('save-obsidian-btn') as HTMLButtonElement;
const obsidianGearBtnEl = document.getElementById('obsidian-gear-btn') as HTMLButtonElement;
const obsidianSettingsBarEl = document.getElementById('obsidian-settings-bar') as HTMLElement;
const vaultStatusTextEl = document.getElementById('vault-status-text') as HTMLElement;
const changeVaultBtnEl = document.getElementById('change-vault-btn') as HTMLButtonElement;
const obsidianSubfolderInputEl = document.getElementById(
  'obsidian-subfolder-input'
) as HTMLInputElement;
const obsidianWikilinksCheckboxEl = document.getElementById(
  'obsidian-wikilinks-checkbox'
) as HTMLInputElement;
const obsidianAutoOpenCheckboxEl = document.getElementById(
  'obsidian-auto-open-checkbox'
) as HTMLInputElement;
const obsidianUriOnlyBtnEl = document.getElementById(
  'obsidian-uri-only-btn'
) as HTMLButtonElement;

let currentSession: EditorSessionPayload | null = null;
let images: EditorImageItem[] = [];
let cachedFrontmatterBlock = '';
let isDownloading = false;
let copyResetTimer: number | null = null;
let savedVaultHandle: FileSystemDirectoryHandle | null = null;
let isObsidianSettingsOpen = true;

const removedImageAnchors = new Map<string, RemovedImageAnchor>();
const cardElementsMap = new Map<
  string,
  { cardEl: HTMLDivElement; checkboxEl: HTMLInputElement; dimBadgeEl: HTMLSpanElement }
>();

function refreshCountsAndUI(): void {
  const markdownText = textareaEl.value;
  const wordCount = countWords(markdownText);
  const charCount = markdownText.length;
  const selectedCount = images.filter((img) => img.included).length;
  const totalCount = images.length;

  headerStatsPillEl.textContent = `${wordCount.toLocaleString()} words • ${selectedCount} ${
    selectedCount === 1 ? 'image' : 'images'
  } selected`;

  editorCharBadgeEl.textContent = `${wordCount.toLocaleString()} words · ${charCount.toLocaleString()} chars`;
  galleryCountHeadingEl.textContent = `Images (${selectedCount}/${totalCount} selected)`;

  if (totalCount > 0) {
    const anyUnchecked = images.some((img) => !img.included);
    toggleAllBtnEl.textContent = anyUnchecked ? 'Toggle All (Select)' : 'Toggle All';
  }

  if (!isDownloading) {
    downloadZipBtnEl.textContent = `📦 Download .ZIP (${selectedCount} ${
      selectedCount === 1 ? 'Image' : 'Images'
    })`;
    saveObsidianBtnEl.textContent = '🟣 Save to Obsidian';
  }
}

function handleFrontmatterToggle(include: boolean): void {
  const currentText = textareaEl.value;
  const frontmatterRegex = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)+/;
  const match = currentText.match(frontmatterRegex);

  if (!include) {
    if (match) {
      cachedFrontmatterBlock = match[0].trim();
      textareaEl.value = currentText.replace(frontmatterRegex, '');
    }
  } else {
    if (!match && cachedFrontmatterBlock) {
      const cleanCurrent = currentText.replace(/^\r?\n+/, '');
      textareaEl.value = `${cachedFrontmatterBlock}\n\n${cleanCurrent}`;
    }
  }

  refreshCountsAndUI();
}

function removeImageFromTextarea(item: EditorImageItem): void {
  const current = textareaEl.value;
  const escapedUrl = escapeRegExp(item.url);

  const singlePattern = new RegExp(
    `(?:\\[!\\[[^\\]]*\\]\\(${escapedUrl}(?:\\s+"[^"]*")?\\)\\]\\([^\\)]+\\)|!\\[[^\\]]*\\]\\(${escapedUrl}(?:\\s+"[^"]*")?\\))`
  );

  const match = singlePattern.exec(current);
  if (match && match.index !== undefined) {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;
    removedImageAnchors.set(item.id, {
      snippet: match[0],
      anchorBefore: current.slice(Math.max(0, matchStart - 80), matchStart),
      anchorAfter: current.slice(matchEnd, Math.min(current.length, matchEnd + 80)),
    });
  }

  const globalLinePattern = new RegExp(
    `^[ \\t]*(?:\\[!\\[[^\\]]*\\]\\(${escapedUrl}(?:\\s+"[^"]*")?\\)\\]\\([^\\)]+\\)|!\\[[^\\]]*\\]\\(${escapedUrl}(?:\\s+"[^"]*")?\\))[ \\t]*\\r?\\n?`,
    'gm'
  );

  let updated = current.replace(globalLinePattern, '');
  if (updated === current) {
    const inlineGlobalPattern = new RegExp(
      `(?:\\[!\\[[^\\]]*\\]\\(${escapedUrl}(?:\\s+"[^"]*")?\\)\\]\\([^\\)]+\\)|!\\[[^\\]]*\\]\\(${escapedUrl}(?:\\s+"[^"]*")?\\))`,
      'g'
    );
    updated = current.replace(inlineGlobalPattern, '');
  }

  textareaEl.value = updated.replace(/\n{3,}/g, '\n\n');
}

function restoreImageToTextarea(item: EditorImageItem): void {
  const current = textareaEl.value;

  if (current.includes(`(${item.url})`) || current.includes(`(${item.url} `)) {
    return;
  }

  const cleanAlt = (item.alt || '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .trim();
  const savedAnchor = removedImageAnchors.get(item.id);
  const snippet = savedAnchor?.snippet || `![${cleanAlt}](${item.url})`;

  let updated: string | null = null;

  if (savedAnchor) {
    if (savedAnchor.anchorBefore.length > 0) {
      const beforeIdx = current.indexOf(savedAnchor.anchorBefore);
      if (beforeIdx !== -1) {
        const insertPos = beforeIdx + savedAnchor.anchorBefore.length;
        const prefix = current.slice(0, insertPos);
        const suffix = current.slice(insertPos);
        const needsLeadingNewline = prefix.length > 0 && !prefix.endsWith('\n');
        const needsTrailingNewline = suffix.length > 0 && !suffix.startsWith('\n');
        updated = `${prefix}${needsLeadingNewline ? '\n\n' : ''}${snippet}${
          needsTrailingNewline ? '\n\n' : '\n'
        }${suffix}`;
      }
    }

    if (updated === null && savedAnchor.anchorAfter.length > 0) {
      const afterIdx = current.indexOf(savedAnchor.anchorAfter);
      if (afterIdx !== -1) {
        const prefix = current.slice(0, afterIdx);
        const suffix = current.slice(afterIdx);
        const needsLeadingNewline = prefix.length > 0 && !prefix.endsWith('\n');
        updated = `${prefix}${needsLeadingNewline ? '\n\n' : ''}${snippet}\n\n${suffix}`;
      }
    }
  }

  if (updated === null) {
    const trimmedEnd = current.replace(/\s+$/, '');
    updated = trimmedEnd.length > 0 ? `${trimmedEnd}\n\n${snippet}\n` : `${snippet}\n`;
  }

  textareaEl.value = updated.replace(/\n{3,}/g, '\n\n');
}

function setImageIncluded(id: string, included: boolean): void {
  const item = images.find((img) => img.id === id);
  if (!item || item.included === included) return;

  item.included = included;

  const cardEntry = cardElementsMap.get(id);
  if (cardEntry) {
    cardEntry.checkboxEl.checked = included;
    if (included) {
      cardEntry.cardEl.classList.remove('dimmed');
    } else {
      cardEntry.cardEl.classList.add('dimmed');
    }
  }

  if (!included) {
    removeImageFromTextarea(item);
  } else {
    restoreImageToTextarea(item);
  }

  refreshCountsAndUI();
}

function createImageCard(item: EditorImageItem): HTMLDivElement {
  const card = document.createElement('div');
  card.className = `img-card ${item.included ? '' : 'dimmed'}`.trim();

  const thumbContainer = document.createElement('div');
  thumbContainer.className = 'thumb-container';

  const imgEl = document.createElement('img');
  imgEl.className = 'thumb-img';
  imgEl.src = item.url;
  imgEl.alt = item.alt || 'Scraped image';
  imgEl.loading = 'lazy';

  const dimBadge = document.createElement('span');
  dimBadge.className = 'dim-badge';
  dimBadge.textContent = 'Image';

  imgEl.addEventListener('load', () => {
    if (imgEl.naturalWidth > 0 && imgEl.naturalHeight > 0) {
      dimBadge.textContent = `${imgEl.naturalWidth}×${imgEl.naturalHeight}`;
    }
  });

  // Fallback to background credentialed fetch if direct <img> load is blocked by hotlink/CORP rules
  let triedFallback = false;
  imgEl.addEventListener('error', () => {
    if (triedFallback || item.url.startsWith('data:')) return;
    triedFallback = true;
    const msg: FetchAssetMessage = { type: 'FETCH_ASSET_BASE64', url: item.url };
    void chrome.runtime.sendMessage(msg).then((res: FetchAssetResponse | undefined) => {
      if (res && res.ok) {
        imgEl.src = `data:${res.contentType};base64,${res.base64}`;
      }
    });
  });

  const checkboxWrap = document.createElement('div');
  checkboxWrap.className = 'card-checkbox-wrap';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'card-checkbox';
  checkbox.checked = item.included;
  checkbox.addEventListener('click', (e) => {
    e.stopPropagation();
  });
  checkbox.addEventListener('change', () => {
    setImageIncluded(item.id, checkbox.checked);
  });

  checkboxWrap.appendChild(checkbox);
  thumbContainer.appendChild(imgEl);
  thumbContainer.appendChild(dimBadge);
  thumbContainer.appendChild(checkboxWrap);

  const metaWrap = document.createElement('div');
  metaWrap.className = 'card-meta';

  const altLabel = document.createElement('div');
  altLabel.className = 'card-alt';
  altLabel.textContent = item.alt?.trim() || extractFilenameFromUrl(item.url);
  altLabel.title = item.alt ? `${item.alt} (${item.url})` : item.url;

  metaWrap.appendChild(altLabel);

  card.appendChild(thumbContainer);
  card.appendChild(metaWrap);

  card.addEventListener('click', () => {
    if (isDownloading) return;
    const nextState = !item.included;
    checkbox.checked = nextState;
    setImageIncluded(item.id, nextState);
  });

  cardElementsMap.set(item.id, {
    cardEl: card,
    checkboxEl: checkbox,
    dimBadgeEl: dimBadge,
  });

  return card;
}

function renderGallery(): void {
  imageGridEl.innerHTML = '';
  cardElementsMap.clear();

  if (images.length === 0) {
    toggleAllBtnEl.disabled = true;
    const emptyEl = document.createElement('div');
    emptyEl.className = 'empty-gallery';
    emptyEl.textContent = 'No images discovered in this selection.';
    imageGridEl.appendChild(emptyEl);
    return;
  }

  toggleAllBtnEl.disabled = false;
  for (const item of images) {
    imageGridEl.appendChild(createImageCard(item));
  }
}

function setControlsDisabled(disabled: boolean): void {
  downloadZipBtnEl.disabled = disabled;
  saveObsidianBtnEl.disabled = disabled;
  obsidianGearBtnEl.disabled = disabled;
  changeVaultBtnEl.disabled = disabled;
  obsidianSubfolderInputEl.disabled = disabled;
  obsidianWikilinksCheckboxEl.disabled = disabled;
  obsidianAutoOpenCheckboxEl.disabled = disabled;
  obsidianUriOnlyBtnEl.disabled = disabled;
  repickBtnEl.disabled = disabled;
  toggleAllBtnEl.disabled = disabled || images.length === 0;
  frontmatterCheckboxEl.disabled = disabled;
  textareaEl.readOnly = disabled;
  for (const entry of cardElementsMap.values()) {
    entry.checkboxEl.disabled = disabled;
  }
}

function showFooterProgress(
  completed: number,
  total: number,
  statusText: string,
  target: 'zip' | 'obsidian' = 'zip'
): void {
  progressBoxEl.classList.add('visible');
  progressTextEl.className = 'progress-text';
  progressTextEl.textContent = statusText;
  progressFillEl.className = 'progress-fill';

  const pct = total > 0 ? Math.min(95, Math.round((completed / total) * 90) + 10) : 65;
  progressFillEl.style.width = `${pct}%`;
  if (target === 'obsidian') {
    saveObsidianBtnEl.textContent = `⏳ ${statusText}`;
  } else {
    downloadZipBtnEl.textContent = `⏳ ${statusText}`;
  }
}

function updateVaultStatusUI(): void {
  if (savedVaultHandle) {
    vaultStatusTextEl.textContent = `📁 Vault: ${savedVaultHandle.name}`;
    vaultStatusTextEl.classList.add('linked');
  } else {
    vaultStatusTextEl.textContent = '📁 No Vault Linked';
    vaultStatusTextEl.classList.remove('linked');
  }
}

async function initObsidianState(): Promise<void> {
  try {
    const [settings, handle] = await Promise.all([
      loadObsidianSettings(),
      getSavedVaultHandle(),
    ]);
    obsidianSubfolderInputEl.value = settings.subfolder;
    obsidianWikilinksCheckboxEl.checked = settings.useWikilinks;
    obsidianAutoOpenCheckboxEl.checked = settings.openInObsidian;
    savedVaultHandle = handle;
    updateVaultStatusUI();
  } catch {
    updateVaultStatusUI();
  }
}

async function handleChangeVaultFolder(): Promise<void> {
  if (isDownloading) return;
  try {
    const handle = await pickVaultDirectory();
    savedVaultHandle = handle;
    updateVaultStatusUI();
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    console.warn('[MarkScrape] Vault folder selection cancelled or failed:', err);
  }
}

async function handleSaveToObsidian(): Promise<void> {
  if (isDownloading || !currentSession) return;

  isDownloading = true;
  const selectedImages = images.filter((img) => img.included);
  const totalSelected = selectedImages.length;

  setControlsDisabled(true);

  try {
    let vaultHandle = savedVaultHandle || (await getSavedVaultHandle());
    if (vaultHandle) {
      const hasPerm = await ensureVaultPermission(vaultHandle);
      if (!hasPerm) {
        vaultHandle = null;
      }
    }

    if (!vaultHandle) {
      saveObsidianBtnEl.textContent = '📁 Select Obsidian Vault...';
      vaultHandle = await pickVaultDirectory();
    }

    savedVaultHandle = vaultHandle;
    updateVaultStatusUI();

    const subfolder = obsidianSubfolderInputEl.value.trim() || 'Clippings';
    const useWikilinks = obsidianWikilinksCheckboxEl.checked;
    const openInObsidian = obsidianAutoOpenCheckboxEl.checked;

    await saveObsidianSettings({ subfolder, useWikilinks, openInObsidian });

    const initialStatus =
      totalSelected > 0
        ? `Writing ${totalSelected} ${totalSelected === 1 ? 'image' : 'images'} to Vault...`
        : 'Writing note to Vault...';

    showFooterProgress(0, totalSelected, initialStatus, 'obsidian');

    const result = await exportToObsidianVault({
      vaultHandle,
      subfolder,
      noteTitle: currentSession.pageTitle || 'Untitled Note',
      markdownText: textareaEl.value,
      selectedImages,
      useWikilinks,
      openInObsidian,
      sourceUrl: currentSession.pageUrl,
      onProgress: (completed, total, statusText) => {
        showFooterProgress(completed, total, statusText, 'obsidian');
      },
    });

    progressFillEl.style.width = '100%';
    progressFillEl.classList.add('complete');
    progressTextEl.textContent = `✓ Saved to ${result.vaultName}/${result.relativeFilePath} (${result.writtenImagesCount} assets)`;
    progressTextEl.classList.add('complete');
    saveObsidianBtnEl.textContent = '✓ Saved to Obsidian Vault!';
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      saveObsidianBtnEl.textContent = '🟣 Save to Obsidian';
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      progressBoxEl.classList.add('visible');
      progressTextEl.textContent = `Obsidian Error: ${msg}`;
      progressTextEl.classList.add('error');
      saveObsidianBtnEl.textContent = '⚠ Retry Save to Obsidian';
    }
  } finally {
    isDownloading = false;
    setControlsDisabled(false);
    window.setTimeout(() => {
      if (!isDownloading) {
        refreshCountsAndUI();
      }
    }, 3000);
  }
}

async function handleDownloadZip(): Promise<void> {
  if (isDownloading || !currentSession) return;

  isDownloading = true;
  const selectedImages = images.filter((img) => img.included);
  const uniqueSelectedUrls = Array.from(
    new Set(selectedImages.map((img) => img.remoteUrl || img.url).filter(Boolean))
  );
  const totalSelected = uniqueSelectedUrls.length;

  setControlsDisabled(true);
  showFooterProgress(
    0,
    totalSelected,
    totalSelected > 0 ? `Fetching 0/${totalSelected} images...` : 'Building .ZIP archive...'
  );

  try {
    const zip = new JSZip();
    const assetsFolder = zip.folder('assets');
    const urlToLocalPath = new Map<string, string>();
    const hashToFilename = new Map<string, string>();
    let completedImages = 0;
    let savedAssetsCount = 0;

    if (totalSelected > 0) {
      await runWithConcurrency(uniqueSelectedUrls, MAX_CONCURRENCY, async (remoteUrl) => {
        try {
          const fetchMsg: FetchAndHashAssetMessage = {
            type: 'FETCH_AND_HASH_ASSET',
            url: remoteUrl,
          };
          const res = (await chrome.runtime.sendMessage(fetchMsg)) as
            | FetchAndHashAssetResponse
            | undefined;

          if (res && res.ok && !res.skippedTrackingPixel) {
            const filename = hashToFilename.get(res.hash) ?? res.filename;
            const localPath = `./assets/${filename}`;

            if (!hashToFilename.has(res.hash)) {
              hashToFilename.set(res.hash, filename);
              assetsFolder?.file(filename, base64ToUint8Array(res.base64));
              savedAssetsCount += 1;
            }

            urlToLocalPath.set(remoteUrl, localPath);
          }
        } catch {
          // Leave remote URL intact if an image fails to download
        } finally {
          completedImages += 1;
          showFooterProgress(
            completedImages,
            totalSelected,
            `Fetching ${completedImages}/${totalSelected} images...`
          );
        }
      });
    }

    showFooterProgress(totalSelected, totalSelected, 'Localizing Markdown & generating .ZIP...');

    let finalMarkdown = textareaEl.value;
    for (const [remoteUrl, localPath] of urlToLocalPath.entries()) {
      finalMarkdown = finalMarkdown.split(remoteUrl).join(localPath);
    }

    zip.file('index.md', finalMarkdown);

    const zipBlob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    const slug = createPageSlug(currentSession.pageTitle, currentSession.pageUrl);
    const filename = `${slug}.zip`;
    const blobUrl = URL.createObjectURL(zipBlob);

    await chrome.downloads.download({
      url: blobUrl,
      filename,
      saveAs: false,
    });

    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);

    progressFillEl.style.width = '100%';
    progressFillEl.classList.add('complete');
    progressTextEl.textContent = `✓ Downloaded ${filename} (${savedAssetsCount} assets)`;
    progressTextEl.classList.add('complete');
    downloadZipBtnEl.textContent = `✓ Downloaded ${filename}`;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    progressTextEl.textContent = `Error: ${msg}`;
    progressTextEl.classList.add('error');
    downloadZipBtnEl.textContent = '⚠ Retry Download .ZIP';
  } finally {
    isDownloading = false;
    setControlsDisabled(false);
    window.setTimeout(() => {
      if (!isDownloading) {
        refreshCountsAndUI();
      }
    }, 3000);
  }
}

async function handleCopyMarkdown(): Promise<void> {
  try {
    await navigator.clipboard.writeText(textareaEl.value);
    copyMdBtnEl.textContent = '✓ Copied!';
    copyMdBtnEl.classList.add('copied');

    if (copyResetTimer !== null) {
      window.clearTimeout(copyResetTimer);
    }
    copyResetTimer = window.setTimeout(() => {
      copyMdBtnEl.textContent = '📋 Copy Markdown';
      copyMdBtnEl.classList.remove('copied');
    }, 2000);
  } catch (err) {
    console.error('[MarkScrape] Clipboard copy failed:', err);
  }
}

async function handleRepickElement(): Promise<void> {
  const sourceTabId = currentSession?.sourceTabId;
  if (!sourceTabId) {
    window.close();
    return;
  }

  try {
    await chrome.tabs.update(sourceTabId, { active: true });
    const msg: StartPickerMessage = {
      type: 'START_PICKER',
      outputMode: 'zip',
    };
    try {
      await chrome.tabs.sendMessage(sourceTabId, msg);
    } catch {
      await chrome.scripting.executeScript({
        target: { tabId: sourceTabId },
        files: ['content-script.js'],
      });
      await chrome.tabs.sendMessage(sourceTabId, msg);
    }
  } finally {
    window.close();
  }
}

async function initEditorStudio(): Promise<void> {
  try {
    const req: GetEditorSessionMessage = { type: 'GET_EDITOR_SESSION' };
    const res = (await chrome.runtime.sendMessage(req)) as GetEditorSessionResponse | undefined;

    if (!res || !res.ok) {
      pageTitleEl.textContent = 'No Active Scrape Session';
      textareaEl.value = `# No Scraped Content Found\n\n${
        res?.error || 'Open a webpage and use the MarkScrape popup to scrape or pick an element.'
      }`;
      setControlsDisabled(true);
      return;
    }

    currentSession = res.session;
    images = (res.session.images || []).map((img) => ({
      ...img,
      url: img.url || img.remoteUrl,
      remoteUrl: img.remoteUrl || img.url,
      included: img.included ?? true,
    }));
    cachedFrontmatterBlock = (res.session.frontmatterYaml || '').trim();

    document.title = `${res.session.pageTitle || 'Preview & Edit'} — MarkScrape Studio`;
    pageTitleEl.textContent = res.session.pageTitle || 'Untitled Page';
    pageUrlEl.textContent = res.session.pageUrl || '';
    pageUrlEl.href = res.session.pageUrl || '#';

    const body = (res.session.initialBodyMarkdown || '').trim();
    textareaEl.value = cachedFrontmatterBlock
      ? `${cachedFrontmatterBlock}\n\n${body}\n`
      : `${body}\n`;

    renderGallery();
    refreshCountsAndUI();
    textareaEl.focus();
  } catch (err: unknown) {
    pageTitleEl.textContent = 'Error Loading Session';
    textareaEl.value = `Error: ${err instanceof Error ? err.message : String(err)}`;
    setControlsDisabled(true);
  }
}

// Event Listeners
textareaEl.addEventListener('input', () => {
  refreshCountsAndUI();
});

frontmatterCheckboxEl.addEventListener('change', () => {
  handleFrontmatterToggle(frontmatterCheckboxEl.checked);
});

toggleAllBtnEl.addEventListener('click', () => {
  if (images.length === 0 || isDownloading) return;
  const anyUnchecked = images.some((img) => !img.included);
  const targetState = anyUnchecked;
  for (const item of images) {
    if (item.included !== targetState) {
      setImageIncluded(item.id, targetState);
    }
  }
});

copyMdBtnEl.addEventListener('click', () => {
  void handleCopyMarkdown();
});

downloadZipBtnEl.addEventListener('click', () => {
  void handleDownloadZip();
});

saveObsidianBtnEl.addEventListener('click', () => {
  void handleSaveToObsidian();
});

obsidianGearBtnEl.addEventListener('click', () => {
  isObsidianSettingsOpen = !isObsidianSettingsOpen;
  obsidianSettingsBarEl.classList.toggle('open', isObsidianSettingsOpen);
  obsidianGearBtnEl.classList.toggle('active', isObsidianSettingsOpen);
});

changeVaultBtnEl.addEventListener('click', () => {
  void handleChangeVaultFolder();
});

obsidianSubfolderInputEl.addEventListener('change', () => {
  void saveObsidianSettings({ subfolder: obsidianSubfolderInputEl.value.trim() });
});

obsidianWikilinksCheckboxEl.addEventListener('change', () => {
  void saveObsidianSettings({ useWikilinks: obsidianWikilinksCheckboxEl.checked });
});

obsidianAutoOpenCheckboxEl.addEventListener('change', () => {
  void saveObsidianSettings({ openInObsidian: obsidianAutoOpenCheckboxEl.checked });
});

obsidianUriOnlyBtnEl.addEventListener('click', () => {
  if (isDownloading || !currentSession) return;
  void exportViaObsidianUriOnly(
    currentSession.pageTitle || 'Clipped Note',
    textareaEl.value,
    savedVaultHandle?.name
  ).then(() => {
    obsidianUriOnlyBtnEl.textContent = '✓ Opened in Obsidian!';
    window.setTimeout(() => {
      obsidianUriOnlyBtnEl.textContent = '↗ Send via URI Only';
    }, 2200);
  });
});

repickBtnEl.addEventListener('click', () => {
  void handleRepickElement();
});

void initObsidianState();
void initEditorStudio();
