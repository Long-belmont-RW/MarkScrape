import {
  ensureVaultPermission,
  exportToObsidianVault,
  exportViaObsidianUriOnly,
  getSavedVaultHandle,
  loadObsidianSettings,
  pickVaultDirectory,
  saveObsidianSettings,
} from './obsidian-exporter.js';

export interface PreviewImageItem {
  id: string;
  url: string;
  remoteUrl: string;
  alt: string;
  included: boolean;
}

export interface PreviewModalDownloadRequest {
  markdownText: string;
  selectedImages: PreviewImageItem[];
  pageTitle: string;
  pageUrl: string;
  onProgress: (completed: number, total: number, statusText?: string) => void;
}

export interface PreviewModalDownloadResult {
  filename: string;
  downloadedImagesCount: number;
}

export interface PreviewModalOptions {
  pageTitle: string;
  pageUrl: string;
  initialBodyMarkdown: string;
  frontmatterYaml: string;
  images: PreviewImageItem[];
  includeFrontmatterByDefault?: boolean;
  onRepickElement: () => void;
  onCopyMarkdown?: (markdownText: string) => Promise<void>;
  onDownloadZip: (
    request: PreviewModalDownloadRequest
  ) => Promise<PreviewModalDownloadResult>;
  onClose?: () => void;
}

interface RemovedImageAnchor {
  snippet: string;
  anchorBefore: string;
  anchorAfter: string;
}

const MODAL_HOST_ID = 'markscrape-preview-modal-host';

/**
 * Escapes special regular expression characters in a literal string.
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Counts words in a Markdown string (excluding YAML frontmatter delimiters).
 */
function countWords(text: string): number {
  const withoutFrontmatter = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, '').trim();
  if (!withoutFrontmatter) return 0;
  return withoutFrontmatter.split(/\s+/).filter(Boolean).length;
}

/**
 * In-Page Shadow DOM Preview & Curation Modal for MarkScrape.
 * Renders a split-pane dark slate editor and interactive image toggle grid inside an isolated ShadowRoot.
 */
export class PreviewModal {
  public static readonly HOST_ID = MODAL_HOST_ID;

  private readonly options: PreviewModalOptions;
  private readonly images: PreviewImageItem[];
  private readonly removedImageAnchors = new Map<string, RemovedImageAnchor>();

  private hostEl: HTMLDivElement | null = null;
  private shadowRoot: ShadowRoot | null = null;
  private textareaEl: HTMLTextAreaElement | null = null;
  private frontmatterCheckboxEl: HTMLInputElement | null = null;
  private headerStatsPillEl: HTMLSpanElement | null = null;
  private editorStatsBadgeEl: HTMLSpanElement | null = null;
  private galleryCountEl: HTMLSpanElement | null = null;
  private toggleAllBtnEl: HTMLButtonElement | null = null;
  private galleryGridEl: HTMLDivElement | null = null;
  private copyBtnEl: HTMLButtonElement | null = null;
  private downloadBtnEl: HTMLButtonElement | null = null;
  private obsidianBtnEl: HTMLButtonElement | null = null;
  private obsidianGearBtnEl: HTMLButtonElement | null = null;
  private obsidianSettingsBarEl: HTMLDivElement | null = null;
  private vaultStatusTextEl: HTMLSpanElement | null = null;
  private changeVaultBtnEl: HTMLButtonElement | null = null;
  private obsidianSubfolderInputEl: HTMLInputElement | null = null;
  private obsidianWikilinksCheckboxEl: HTMLInputElement | null = null;
  private obsidianAutoOpenCheckboxEl: HTMLInputElement | null = null;
  private obsidianUriOnlyBtnEl: HTMLButtonElement | null = null;
  private repickBtnEl: HTMLButtonElement | null = null;
  private progressContainerEl: HTMLDivElement | null = null;
  private progressBarFillEl: HTMLDivElement | null = null;
  private progressLabelEl: HTMLSpanElement | null = null;

  private cachedFrontmatterBlock: string;
  private includeFrontmatter: boolean;
  private isDownloading = false;
  private isClosed = false;
  private copyResetTimer: number | null = null;
  private savedVaultHandle: FileSystemDirectoryHandle | null = null;
  private isObsidianSettingsOpen = true;

  private readonly cardMap = new Map<
    string,
    { cardEl: HTMLDivElement; checkboxEl: HTMLInputElement; dimBadgeEl: HTMLSpanElement }
  >();

  private readonly boundWindowKeyDown: (e: KeyboardEvent) => void;

  constructor(options: PreviewModalOptions) {
    this.options = options;
    this.images = options.images.map((img) => ({
      ...img,
      url: img.url || img.remoteUrl,
      remoteUrl: img.remoteUrl || img.url,
      included: img.included ?? true,
    }));
    this.cachedFrontmatterBlock = options.frontmatterYaml.trim();
    this.includeFrontmatter = options.includeFrontmatterByDefault ?? true;
    this.boundWindowKeyDown = this.handleWindowKeyDown.bind(this);
  }

  /**
   * Mounts the isolated Shadow DOM modal onto the current document.
   */
  public open(): void {
    const existing = document.getElementById(MODAL_HOST_ID);
    if (existing) {
      existing.remove();
    }

    this.isClosed = false;

    const host = document.createElement('div');
    host.id = MODAL_HOST_ID;
    host.style.cssText = [
      'position: fixed !important',
      'top: 0 !important',
      'left: 0 !important',
      'width: 100vw !important',
      'height: 100vh !important',
      'z-index: 2147483647 !important',
      'margin: 0 !important',
      'padding: 0 !important',
      'border: none !important',
      'background: transparent !important',
      'pointer-events: auto !important',
    ].join('; ');

    const shadow = host.attachShadow({ mode: 'open' });

    // Stop keystrokes inside the modal from leaking to host page hotkeys (GitHub, YouTube, etc.)
    const stopKeyboardLeak = (e: Event) => {
      e.stopPropagation();
    };
    shadow.addEventListener('keydown', stopKeyboardLeak);
    shadow.addEventListener('keyup', stopKeyboardLeak);
    shadow.addEventListener('keypress', stopKeyboardLeak);

    const styleEl = document.createElement('style');
    styleEl.textContent = this.getStylesheet();

    const backdrop = document.createElement('div');
    backdrop.className = 'ms-backdrop';
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop && !this.isDownloading) {
        this.close();
      }
    });

    const modalWindow = document.createElement('div');
    modalWindow.className = 'ms-modal';
    modalWindow.setAttribute('role', 'dialog');
    modalWindow.setAttribute('aria-modal', 'true');
    modalWindow.setAttribute('aria-label', 'MarkScrape Preview and Curation Modal');

    // 1. Header
    const header = this.buildHeader();

    // 2. Split-Pane Body (Left 60% Markdown Editor, Right 40% Image Toggle Grid)
    const body = document.createElement('div');
    body.className = 'ms-body';

    const leftPane = this.buildLeftEditorPane();
    const rightPane = this.buildRightGalleryPane();

    body.appendChild(leftPane);
    body.appendChild(rightPane);

    // 3. Obsidian Settings Drawer Bar (above footer)
    const obsidianSettingsBar = this.buildObsidianSettingsBar();

    // 4. Footer Bar
    const footer = this.buildFooter();

    modalWindow.appendChild(header);
    modalWindow.appendChild(body);
    modalWindow.appendChild(obsidianSettingsBar);
    modalWindow.appendChild(footer);
    backdrop.appendChild(modalWindow);

    shadow.appendChild(styleEl);
    shadow.appendChild(backdrop);

    (document.documentElement || document.body).appendChild(host);

    this.hostEl = host;
    this.shadowRoot = shadow;

    window.addEventListener('keydown', this.boundWindowKeyDown, true);

    this.refreshCountsAndUI();
    void this.initObsidianState();

    // Focus the textarea for immediate editing
    window.setTimeout(() => {
      this.textareaEl?.focus();
    }, 30);
  }

  /**
   * Closes the modal, cleans up listeners, and removes the Shadow DOM host.
   */
  public close(): void {
    if (this.isClosed) return;
    this.isClosed = true;

    window.removeEventListener('keydown', this.boundWindowKeyDown, true);

    if (this.copyResetTimer !== null) {
      window.clearTimeout(this.copyResetTimer);
      this.copyResetTimer = null;
    }

    if (this.hostEl) {
      this.hostEl.remove();
      this.hostEl = null;
    }

    this.shadowRoot = null;
    this.cardMap.clear();
    this.options.onClose?.();
  }

  private buildHeader(): HTMLElement {
    const header = document.createElement('header');
    header.className = 'ms-header';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'ms-title-group';

    const brandLogo = document.createElement('div');
    brandLogo.className = 'ms-brand-logo';
    brandLogo.textContent = 'M';

    const titleTextWrap = document.createElement('div');
    titleTextWrap.className = 'ms-title-text-wrap';

    const titleEl = document.createElement('h2');
    titleEl.className = 'ms-title';
    titleEl.textContent = 'MarkScrape Preview & Curation';

    const subtitleEl = document.createElement('span');
    subtitleEl.className = 'ms-subtitle';
    subtitleEl.textContent = this.options.pageTitle || this.options.pageUrl;

    titleTextWrap.appendChild(titleEl);
    titleTextWrap.appendChild(subtitleEl);

    titleGroup.appendChild(brandLogo);
    titleGroup.appendChild(titleTextWrap);

    const rightControls = document.createElement('div');
    rightControls.className = 'ms-header-controls';

    const statsPill = document.createElement('span');
    statsPill.className = 'ms-stats-pill';
    this.headerStatsPillEl = statsPill;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ms-close-btn';
    closeBtn.title = 'Close (ESC)';
    closeBtn.innerHTML = '<span>✕</span><kbd>ESC</kbd>';
    closeBtn.addEventListener('click', () => {
      if (!this.isDownloading) {
        this.close();
      }
    });

    rightControls.appendChild(statsPill);
    rightControls.appendChild(closeBtn);

    header.appendChild(titleGroup);
    header.appendChild(rightControls);

    return header;
  }

  private buildLeftEditorPane(): HTMLElement {
    const leftPane = document.createElement('section');
    leftPane.className = 'ms-left-pane';

    const paneHeader = document.createElement('div');
    paneHeader.className = 'ms-pane-header';

    const paneTitleWrap = document.createElement('div');
    paneTitleWrap.className = 'ms-pane-title-wrap';

    const paneTitle = document.createElement('span');
    paneTitle.className = 'ms-pane-title';
    paneTitle.textContent = 'Markdown Editor';

    const editorStatsBadge = document.createElement('span');
    editorStatsBadge.className = 'ms-editor-stats-badge';
    this.editorStatsBadgeEl = editorStatsBadge;

    paneTitleWrap.appendChild(paneTitle);
    paneTitleWrap.appendChild(editorStatsBadge);

    const fmLabel = document.createElement('label');
    fmLabel.className = 'ms-fm-toggle-label';

    const fmCheckbox = document.createElement('input');
    fmCheckbox.type = 'checkbox';
    fmCheckbox.checked = this.includeFrontmatter;
    fmCheckbox.addEventListener('change', () => {
      this.handleFrontmatterToggle(fmCheckbox.checked);
    });
    this.frontmatterCheckboxEl = fmCheckbox;

    const fmText = document.createElement('span');
    fmText.textContent = 'Include YAML Frontmatter';

    fmLabel.appendChild(fmCheckbox);
    fmLabel.appendChild(fmText);

    paneHeader.appendChild(paneTitleWrap);
    paneHeader.appendChild(fmLabel);

    const textarea = document.createElement('textarea');
    textarea.className = 'ms-textarea';
    textarea.spellcheck = false;
    textarea.value = this.composeInitialMarkdown();
    textarea.addEventListener('input', () => {
      this.refreshCountsAndUI();
    });
    this.textareaEl = textarea;

    leftPane.appendChild(paneHeader);
    leftPane.appendChild(textarea);

    return leftPane;
  }

  private buildRightGalleryPane(): HTMLElement {
    const rightPane = document.createElement('section');
    rightPane.className = 'ms-right-pane';

    const paneHeader = document.createElement('div');
    paneHeader.className = 'ms-pane-header';

    const galleryCount = document.createElement('span');
    galleryCount.className = 'ms-pane-title';
    this.galleryCountEl = galleryCount;

    const toggleAllBtn = document.createElement('button');
    toggleAllBtn.type = 'button';
    toggleAllBtn.className = 'ms-toggle-all-btn';
    toggleAllBtn.textContent = 'Toggle All';
    toggleAllBtn.addEventListener('click', () => {
      this.handleToggleAllImages();
    });
    this.toggleAllBtnEl = toggleAllBtn;

    paneHeader.appendChild(galleryCount);
    paneHeader.appendChild(toggleAllBtn);

    const grid = document.createElement('div');
    grid.className = 'ms-gallery-grid';
    this.galleryGridEl = grid;

    if (this.images.length === 0) {
      toggleAllBtn.disabled = true;
      const emptyState = document.createElement('div');
      emptyState.className = 'ms-empty-gallery';
      emptyState.textContent = 'No images discovered in this selection.';
      grid.appendChild(emptyState);
    } else {
      for (const item of this.images) {
        const card = this.createImageCard(item);
        grid.appendChild(card);
      }
    }

    rightPane.appendChild(paneHeader);
    rightPane.appendChild(grid);

    return rightPane;
  }

  private createImageCard(item: PreviewImageItem): HTMLDivElement {
    const card = document.createElement('div');
    card.className = `ms-img-card ${item.included ? '' : 'dimmed'}`.trim();

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'ms-thumb-wrap';

    const imgEl = document.createElement('img');
    imgEl.className = 'ms-thumb-img';
    imgEl.src = item.url;
    imgEl.alt = item.alt || 'Scraped image';
    imgEl.loading = 'lazy';

    const dimBadge = document.createElement('span');
    dimBadge.className = 'ms-dim-badge';
    dimBadge.textContent = 'Image';

    imgEl.addEventListener('load', () => {
      if (imgEl.naturalWidth > 0 && imgEl.naturalHeight > 0) {
        dimBadge.textContent = `${imgEl.naturalWidth}×${imgEl.naturalHeight}`;
      }
    });

    const checkboxWrap = document.createElement('div');
    checkboxWrap.className = 'ms-card-check-wrap';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'ms-card-checkbox';
    checkbox.checked = item.included;
    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
    });
    checkbox.addEventListener('change', () => {
      this.setImageIncluded(item.id, checkbox.checked);
    });

    checkboxWrap.appendChild(checkbox);
    thumbWrap.appendChild(imgEl);
    thumbWrap.appendChild(dimBadge);
    thumbWrap.appendChild(checkboxWrap);

    const metaWrap = document.createElement('div');
    metaWrap.className = 'ms-card-meta';

    const altLabel = document.createElement('div');
    altLabel.className = 'ms-card-alt';
    const displayAlt = item.alt?.trim() || this.extractFilenameFromUrl(item.url);
    altLabel.textContent = displayAlt;
    altLabel.title = item.alt ? `${item.alt} (${item.url})` : item.url;

    metaWrap.appendChild(altLabel);

    card.appendChild(thumbWrap);
    card.appendChild(metaWrap);

    card.addEventListener('click', () => {
      if (this.isDownloading) return;
      const nextState = !item.included;
      checkbox.checked = nextState;
      this.setImageIncluded(item.id, nextState);
    });

    this.cardMap.set(item.id, {
      cardEl: card,
      checkboxEl: checkbox,
      dimBadgeEl: dimBadge,
    });

    return card;
  }

  private buildObsidianSettingsBar(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = `ms-obsidian-bar ${this.isObsidianSettingsOpen ? 'open' : ''}`.trim();
    this.obsidianSettingsBarEl = bar;

    // 1. Linked Vault Folder status & Change Vault button
    const vaultGroup = document.createElement('div');
    vaultGroup.className = 'ms-obsidian-group';

    const vaultStatus = document.createElement('span');
    vaultStatus.className = 'ms-vault-status';
    vaultStatus.textContent = '📁 No Vault Linked';
    this.vaultStatusTextEl = vaultStatus;

    const changeVaultBtn = document.createElement('button');
    changeVaultBtn.type = 'button';
    changeVaultBtn.className = 'ms-vault-change-btn';
    changeVaultBtn.textContent = 'Change Vault Folder...';
    changeVaultBtn.addEventListener('click', () => {
      void this.handleChangeVaultFolder();
    });
    this.changeVaultBtnEl = changeVaultBtn;

    vaultGroup.appendChild(vaultStatus);
    vaultGroup.appendChild(changeVaultBtn);

    // 2. Subfolder Input
    const subfolderGroup = document.createElement('label');
    subfolderGroup.className = 'ms-obsidian-field-label';

    const subfolderLabelText = document.createElement('span');
    subfolderLabelText.textContent = 'Subfolder:';

    const subfolderInput = document.createElement('input');
    subfolderInput.type = 'text';
    subfolderInput.className = 'ms-obsidian-subfolder-input';
    subfolderInput.value = 'Clippings';
    subfolderInput.placeholder = 'Clippings';
    subfolderInput.addEventListener('change', () => {
      void saveObsidianSettings({ subfolder: subfolderInput.value.trim() });
    });
    this.obsidianSubfolderInputEl = subfolderInput;

    subfolderGroup.appendChild(subfolderLabelText);
    subfolderGroup.appendChild(subfolderInput);

    // 3. Wikilinks Toggle
    const wikilinksLabel = document.createElement('label');
    wikilinksLabel.className = 'ms-obsidian-check-label';

    const wikilinksCheck = document.createElement('input');
    wikilinksCheck.type = 'checkbox';
    wikilinksCheck.checked = false;
    wikilinksCheck.addEventListener('change', () => {
      void saveObsidianSettings({ useWikilinks: wikilinksCheck.checked });
    });
    this.obsidianWikilinksCheckboxEl = wikilinksCheck;

    const wikilinksText = document.createElement('span');
    wikilinksText.textContent = 'Use ![[Wikilinks]] for images';

    wikilinksLabel.appendChild(wikilinksCheck);
    wikilinksLabel.appendChild(wikilinksText);

    // 4. Auto-Open Toggle
    const autoOpenLabel = document.createElement('label');
    autoOpenLabel.className = 'ms-obsidian-check-label';

    const autoOpenCheck = document.createElement('input');
    autoOpenCheck.type = 'checkbox';
    autoOpenCheck.checked = true;
    autoOpenCheck.addEventListener('change', () => {
      void saveObsidianSettings({ openInObsidian: autoOpenCheck.checked });
    });
    this.obsidianAutoOpenCheckboxEl = autoOpenCheck;

    const autoOpenText = document.createElement('span');
    autoOpenText.textContent = 'Open note in Obsidian after saving';

    autoOpenLabel.appendChild(autoOpenCheck);
    autoOpenLabel.appendChild(autoOpenText);

    // 5. Fallback URI-only quick button
    const uriOnlyBtn = document.createElement('button');
    uriOnlyBtn.type = 'button';
    uriOnlyBtn.className = 'ms-vault-uri-btn';
    uriOnlyBtn.title = 'Send Markdown text with remote image URLs via obsidian://new without writing local files';
    uriOnlyBtn.textContent = '↗ Send via URI Only';
    uriOnlyBtn.addEventListener('click', () => {
      void this.handleObsidianUriOnly();
    });
    this.obsidianUriOnlyBtnEl = uriOnlyBtn;

    bar.appendChild(vaultGroup);
    bar.appendChild(subfolderGroup);
    bar.appendChild(wikilinksLabel);
    bar.appendChild(autoOpenLabel);
    bar.appendChild(uriOnlyBtn);

    return bar;
  }

  private buildFooter(): HTMLElement {
    const footer = document.createElement('footer');
    footer.className = 'ms-footer';

    const leftActions = document.createElement('div');
    leftActions.className = 'ms-footer-left';

    const repickBtn = document.createElement('button');
    repickBtn.type = 'button';
    repickBtn.className = 'ms-btn ms-btn-ghost';
    repickBtn.textContent = '🎯 Re-pick Element';
    repickBtn.addEventListener('click', () => {
      if (this.isDownloading) return;
      this.close();
      this.options.onRepickElement();
    });
    this.repickBtnEl = repickBtn;

    const progressContainer = document.createElement('div');
    progressContainer.className = 'ms-progress-container';

    const progressTrack = document.createElement('div');
    progressTrack.className = 'ms-progress-track';

    const progressFill = document.createElement('div');
    progressFill.className = 'ms-progress-fill';
    progressTrack.appendChild(progressFill);

    const progressLabel = document.createElement('span');
    progressLabel.className = 'ms-progress-label';

    progressContainer.appendChild(progressTrack);
    progressContainer.appendChild(progressLabel);

    this.progressContainerEl = progressContainer;
    this.progressBarFillEl = progressFill;
    this.progressLabelEl = progressLabel;

    leftActions.appendChild(repickBtn);
    leftActions.appendChild(progressContainer);

    const rightActions = document.createElement('div');
    rightActions.className = 'ms-footer-right';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'ms-btn ms-btn-secondary';
    copyBtn.textContent = '📋 Copy Markdown';
    copyBtn.addEventListener('click', () => {
      void this.handleCopyMarkdown();
    });
    this.copyBtnEl = copyBtn;

    // Obsidian button group (Gear settings toggle + Primary Save to Obsidian button)
    const obsidianCluster = document.createElement('div');
    obsidianCluster.className = 'ms-obsidian-btn-cluster';

    const obsidianGearBtn = document.createElement('button');
    obsidianGearBtn.type = 'button';
    obsidianGearBtn.className = 'ms-btn ms-btn-obsidian-gear';
    obsidianGearBtn.title = 'Toggle Obsidian Vault Settings';
    obsidianGearBtn.setAttribute('aria-label', 'Toggle Obsidian Vault Settings');
    obsidianGearBtn.textContent = '⚙️';
    obsidianGearBtn.addEventListener('click', () => {
      this.toggleObsidianSettingsBar();
    });
    this.obsidianGearBtnEl = obsidianGearBtn;

    const obsidianBtn = document.createElement('button');
    obsidianBtn.type = 'button';
    obsidianBtn.className = 'ms-btn ms-btn-obsidian';
    obsidianBtn.textContent = '🟣 Save to Obsidian';
    obsidianBtn.addEventListener('click', () => {
      void this.handleSaveToObsidian();
    });
    this.obsidianBtnEl = obsidianBtn;

    obsidianCluster.appendChild(obsidianGearBtn);
    obsidianCluster.appendChild(obsidianBtn);

    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'ms-btn ms-btn-primary';
    downloadBtn.addEventListener('click', () => {
      void this.handleDownloadZip();
    });
    this.downloadBtnEl = downloadBtn;

    rightActions.appendChild(copyBtn);
    rightActions.appendChild(obsidianCluster);
    rightActions.appendChild(downloadBtn);

    footer.appendChild(leftActions);
    footer.appendChild(rightActions);

    return footer;
  }

  private composeInitialMarkdown(): string {
    const body = this.options.initialBodyMarkdown.trim();
    if (this.includeFrontmatter && this.cachedFrontmatterBlock) {
      return `${this.cachedFrontmatterBlock}\n\n${body}\n`;
    }
    return `${body}\n`;
  }

  private handleFrontmatterToggle(include: boolean): void {
    this.includeFrontmatter = include;
    if (!this.textareaEl) return;

    const currentText = this.textareaEl.value;
    const frontmatterRegex = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)+/;
    const match = currentText.match(frontmatterRegex);

    if (!include) {
      if (match) {
        this.cachedFrontmatterBlock = match[0].trim();
        this.textareaEl.value = currentText.replace(frontmatterRegex, '');
      }
    } else {
      if (!match && this.cachedFrontmatterBlock) {
        const cleanCurrent = currentText.replace(/^\r?\n+/, '');
        this.textareaEl.value = `${this.cachedFrontmatterBlock}\n\n${cleanCurrent}`;
      }
    }

    this.refreshCountsAndUI();
  }

  /**
   * Toggles an individual image card on or off, updating its visual state and inserting/removing
   * its `![alt](url)` Markdown line in the live `<textarea>`.
   */
  private setImageIncluded(id: string, included: boolean): void {
    const item = this.images.find((img) => img.id === id);
    if (!item || item.included === included) return;

    item.included = included;

    const cardEntry = this.cardMap.get(id);
    if (cardEntry) {
      cardEntry.checkboxEl.checked = included;
      if (included) {
        cardEntry.cardEl.classList.remove('dimmed');
      } else {
        cardEntry.cardEl.classList.add('dimmed');
      }
    }

    if (this.textareaEl) {
      if (!included) {
        this.removeImageFromTextarea(item);
      } else {
        this.restoreImageToTextarea(item);
      }
    }

    this.refreshCountsAndUI();
  }

  private handleToggleAllImages(): void {
    if (this.images.length === 0 || this.isDownloading) return;
    const anyUnchecked = this.images.some((img) => !img.included);
    const targetState = anyUnchecked;

    for (const item of this.images) {
      if (item.included !== targetState) {
        this.setImageIncluded(item.id, targetState);
      }
    }
  }

  /**
   * Removes all `![alt](url)` occurrences for `item.url` from the live `<textarea>`,
   * caching surrounding anchor context so re-checking restores it to its original position.
   */
  private removeImageFromTextarea(item: PreviewImageItem): void {
    if (!this.textareaEl) return;
    const current = this.textareaEl.value;
    const escapedUrl = escapeRegExp(item.url);

    // Match either a linked image [![alt](url)](href) or standard ![alt](url "title")
    const singlePattern = new RegExp(
      `(?:\\[!\\[[^\\]]*\\]\\(${escapedUrl}(?:\\s+"[^"]*")?\\)\\]\\([^\\)]+\\)|!\\[[^\\]]*\\]\\(${escapedUrl}(?:\\s+"[^"]*")?\\))`
    );

    const match = singlePattern.exec(current);
    if (match && match.index !== undefined) {
      const matchStart = match.index;
      const matchEnd = matchStart + match[0].length;
      this.removedImageAnchors.set(item.id, {
        snippet: match[0],
        anchorBefore: current.slice(Math.max(0, matchStart - 80), matchStart),
        anchorAfter: current.slice(matchEnd, Math.min(current.length, matchEnd + 80)),
      });
    }

    // Remove the image markdown line(s) referencing this URL
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

    this.textareaEl.value = updated.replace(/\n{3,}/g, '\n\n');
  }

  /**
   * Restores a previously unchecked image's `![alt](url)` line back into the `<textarea>`.
   */
  private restoreImageToTextarea(item: PreviewImageItem): void {
    if (!this.textareaEl) return;
    const current = this.textareaEl.value;

    // Avoid duplicating if the URL is already present in the textarea
    if (current.includes(`(${item.url})`) || current.includes(`(${item.url} `)) {
      return;
    }

    const cleanAlt = (item.alt || '')
      .replace(/\r?\n+/g, ' ')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .trim();
    const savedAnchor = this.removedImageAnchors.get(item.id);
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

    this.textareaEl.value = updated.replace(/\n{3,}/g, '\n\n');
  }

  private refreshCountsAndUI(): void {
    const markdownText = this.textareaEl?.value || '';
    const wordCount = countWords(markdownText);
    const charCount = markdownText.length;
    const selectedCount = this.images.filter((img) => img.included).length;
    const totalCount = this.images.length;

    if (this.headerStatsPillEl) {
      this.headerStatsPillEl.textContent = `${wordCount.toLocaleString()} words • ${selectedCount} ${
        selectedCount === 1 ? 'image' : 'images'
      } selected`;
    }

    if (this.editorStatsBadgeEl) {
      this.editorStatsBadgeEl.textContent = `${wordCount.toLocaleString()} words · ${charCount.toLocaleString()} chars`;
    }

    if (this.galleryCountEl) {
      this.galleryCountEl.textContent = `Images (${selectedCount}/${totalCount} selected)`;
    }

    if (this.toggleAllBtnEl && totalCount > 0) {
      const anyUnchecked = this.images.some((img) => !img.included);
      this.toggleAllBtnEl.textContent = anyUnchecked ? 'Toggle All (Select)' : 'Toggle All';
    }

    if (this.downloadBtnEl && !this.isDownloading) {
      this.downloadBtnEl.textContent = `📦 Download .ZIP (${selectedCount} ${
        selectedCount === 1 ? 'Image' : 'Images'
      })`;
    }

    if (this.obsidianBtnEl && !this.isDownloading) {
      this.obsidianBtnEl.textContent = '🟣 Save to Obsidian';
    }
  }

  private async initObsidianState(): Promise<void> {
    try {
      const [settings, handle] = await Promise.all([
        loadObsidianSettings(),
        getSavedVaultHandle(),
      ]);

      if (this.obsidianSubfolderInputEl) {
        this.obsidianSubfolderInputEl.value = settings.subfolder;
      }
      if (this.obsidianWikilinksCheckboxEl) {
        this.obsidianWikilinksCheckboxEl.checked = settings.useWikilinks;
      }
      if (this.obsidianAutoOpenCheckboxEl) {
        this.obsidianAutoOpenCheckboxEl.checked = settings.openInObsidian;
      }

      this.savedVaultHandle = handle;
      this.updateVaultStatusUI();
    } catch {
      this.updateVaultStatusUI();
    }
  }

  private toggleObsidianSettingsBar(forceOpen?: boolean): void {
    this.isObsidianSettingsOpen =
      forceOpen !== undefined ? forceOpen : !this.isObsidianSettingsOpen;
    if (this.obsidianSettingsBarEl) {
      this.obsidianSettingsBarEl.classList.toggle('open', this.isObsidianSettingsOpen);
    }
    if (this.obsidianGearBtnEl) {
      this.obsidianGearBtnEl.classList.toggle('active', this.isObsidianSettingsOpen);
    }
  }

  private updateVaultStatusUI(): void {
    if (!this.vaultStatusTextEl) return;
    if (this.savedVaultHandle) {
      this.vaultStatusTextEl.textContent = `📁 Vault: ${this.savedVaultHandle.name}`;
      this.vaultStatusTextEl.classList.add('linked');
    } else {
      this.vaultStatusTextEl.textContent = '📁 No Vault Linked';
      this.vaultStatusTextEl.classList.remove('linked');
    }
  }

  private async handleChangeVaultFolder(): Promise<void> {
    if (this.isDownloading) return;
    try {
      const handle = await pickVaultDirectory();
      this.savedVaultHandle = handle;
      this.updateVaultStatusUI();
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      console.warn('[MarkScrape] Vault folder selection cancelled or failed:', err);
    }
  }

  private async handleObsidianUriOnly(): Promise<void> {
    if (this.isDownloading || !this.textareaEl) return;
    try {
      await exportViaObsidianUriOnly(
        this.options.pageTitle || 'Clipped Note',
        this.textareaEl.value,
        this.savedVaultHandle?.name
      );
      if (this.obsidianUriOnlyBtnEl) {
        this.obsidianUriOnlyBtnEl.textContent = '✓ Opened in Obsidian!';
        window.setTimeout(() => {
          if (this.obsidianUriOnlyBtnEl) {
            this.obsidianUriOnlyBtnEl.textContent = '↗ Send via URI Only';
          }
        }, 2200);
      }
    } catch (err: unknown) {
      console.error('[MarkScrape] Failed to launch Obsidian URI:', err);
    }
  }

  private async handleSaveToObsidian(): Promise<void> {
    if (this.isDownloading || !this.textareaEl || !this.obsidianBtnEl) return;

    this.isDownloading = true;
    const selectedImages = this.images.filter((img) => img.included);
    const totalSelected = selectedImages.length;

    this.setControlsDisabled(true);

    try {
      let vaultHandle = this.savedVaultHandle || (await getSavedVaultHandle());
      if (vaultHandle) {
        const hasPerm = await ensureVaultPermission(vaultHandle);
        if (!hasPerm) {
          vaultHandle = null;
        }
      }

      if (!vaultHandle) {
        if (this.obsidianBtnEl) {
          this.obsidianBtnEl.textContent = '📁 Select Obsidian Vault...';
        }
        vaultHandle = await pickVaultDirectory();
      }

      this.savedVaultHandle = vaultHandle;
      this.updateVaultStatusUI();

      const subfolder = this.obsidianSubfolderInputEl?.value.trim() ?? 'Clippings';
      const useWikilinks = this.obsidianWikilinksCheckboxEl?.checked ?? false;
      const openInObsidian = this.obsidianAutoOpenCheckboxEl?.checked ?? true;

      await saveObsidianSettings({ subfolder, useWikilinks, openInObsidian });

      const initialStatus =
        totalSelected > 0
          ? `Writing ${totalSelected} ${totalSelected === 1 ? 'image' : 'images'} to Vault...`
          : 'Writing note to Vault...';

      this.showFooterProgress(0, totalSelected, initialStatus, 'obsidian');

      const result = await exportToObsidianVault({
        vaultHandle,
        subfolder,
        noteTitle: this.options.pageTitle || 'Untitled Note',
        markdownText: this.textareaEl.value,
        selectedImages,
        useWikilinks,
        openInObsidian,
        sourceUrl: this.options.pageUrl,
        onProgress: (completed, total, statusText) => {
          this.showFooterProgress(completed, total, statusText, 'obsidian');
        },
      });

      if (this.progressBarFillEl) {
        this.progressBarFillEl.style.width = '100%';
        this.progressBarFillEl.classList.add('complete');
      }
      if (this.progressLabelEl) {
        this.progressLabelEl.textContent = `✓ Saved to ${result.vaultName}/${result.relativeFilePath} (${result.writtenImagesCount} assets)`;
        this.progressLabelEl.classList.add('complete');
      }
      this.obsidianBtnEl.textContent = '✓ Saved to Obsidian Vault!';
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        if (this.obsidianBtnEl) {
          this.obsidianBtnEl.textContent = '🟣 Save to Obsidian';
        }
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        if (this.progressContainerEl) {
          this.progressContainerEl.classList.add('visible');
        }
        if (this.progressLabelEl) {
          this.progressLabelEl.textContent = `Obsidian Error: ${msg}`;
          this.progressLabelEl.classList.add('error');
        }
        if (this.obsidianBtnEl) {
          this.obsidianBtnEl.textContent = '⚠ Retry Save to Obsidian';
        }
      }
    } finally {
      this.isDownloading = false;
      this.setControlsDisabled(false);
      window.setTimeout(() => {
        if (!this.isClosed && !this.isDownloading) {
          this.refreshCountsAndUI();
        }
      }, 2800);
    }
  }

  private async handleCopyMarkdown(): Promise<void> {
    if (!this.textareaEl || !this.copyBtnEl) return;
    const text = this.textareaEl.value;

    try {
      if (this.options.onCopyMarkdown) {
        await this.options.onCopyMarkdown(text);
      } else {
        await navigator.clipboard.writeText(text);
      }

      this.copyBtnEl.textContent = '✓ Copied!';
      this.copyBtnEl.classList.add('copied');

      if (this.copyResetTimer !== null) {
        window.clearTimeout(this.copyResetTimer);
      }
      this.copyResetTimer = window.setTimeout(() => {
        if (this.copyBtnEl) {
          this.copyBtnEl.textContent = '📋 Copy Markdown';
          this.copyBtnEl.classList.remove('copied');
        }
      }, 2000);
    } catch (err) {
      this.copyBtnEl.textContent = `⚠ Copy Failed`;
      window.setTimeout(() => {
        if (this.copyBtnEl) {
          this.copyBtnEl.textContent = '📋 Copy Markdown';
        }
      }, 2000);
      console.error('[MarkScrape] Failed to copy Markdown:', err);
    }
  }

  private async handleDownloadZip(): Promise<void> {
    if (this.isDownloading || !this.textareaEl || !this.downloadBtnEl) return;

    this.isDownloading = true;
    const selectedImages = this.images.filter((img) => img.included);
    const totalSelected = selectedImages.length;

    this.setControlsDisabled(true);
    this.showFooterProgress(
      0,
      totalSelected,
      totalSelected > 0 ? `Fetching 0/${totalSelected} images...` : 'Building .ZIP archive...'
    );

    try {
      const result = await this.options.onDownloadZip({
        markdownText: this.textareaEl.value,
        selectedImages,
        pageTitle: this.options.pageTitle,
        pageUrl: this.options.pageUrl,
        onProgress: (completed, total, customStatus) => {
          const status =
            customStatus ||
            (total > 0 ? `Fetching ${completed}/${total} images...` : 'Building .ZIP archive...');
          this.showFooterProgress(completed, total, status);
        },
      });

      if (this.progressBarFillEl) {
        this.progressBarFillEl.style.width = '100%';
        this.progressBarFillEl.classList.add('complete');
      }
      if (this.progressLabelEl) {
        this.progressLabelEl.textContent = `✓ Downloaded ${result.filename} (${result.downloadedImagesCount} assets)`;
        this.progressLabelEl.classList.add('complete');
      }
      this.downloadBtnEl.textContent = `✓ Downloaded ${result.filename}`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.progressLabelEl) {
        this.progressLabelEl.textContent = `Error: ${msg}`;
        this.progressLabelEl.classList.add('error');
      }
      if (this.downloadBtnEl) {
        this.downloadBtnEl.textContent = '⚠ Retry Download .ZIP';
      }
    } finally {
      this.isDownloading = false;
      this.setControlsDisabled(false);
      window.setTimeout(() => {
        if (!this.isClosed && !this.isDownloading) {
          this.refreshCountsAndUI();
        }
      }, 2800);
    }
  }

  private showFooterProgress(
    completed: number,
    total: number,
    statusText: string,
    target: 'zip' | 'obsidian' = 'zip'
  ): void {
    if (this.progressContainerEl) {
      this.progressContainerEl.classList.add('visible');
    }
    if (this.progressLabelEl) {
      this.progressLabelEl.className = 'ms-progress-label';
      this.progressLabelEl.textContent = statusText;
    }
    if (this.progressBarFillEl) {
      this.progressBarFillEl.className = 'ms-progress-fill';
      const pct = total > 0 ? Math.min(95, Math.round((completed / total) * 90) + 10) : 65;
      this.progressBarFillEl.style.width = `${pct}%`;
    }
    if (target === 'obsidian') {
      if (this.obsidianBtnEl) {
        this.obsidianBtnEl.textContent = `⏳ ${statusText}`;
      }
    } else if (this.downloadBtnEl) {
      this.downloadBtnEl.textContent = `⏳ ${statusText}`;
    }
  }

  private setControlsDisabled(disabled: boolean): void {
    if (this.downloadBtnEl) this.downloadBtnEl.disabled = disabled;
    if (this.obsidianBtnEl) this.obsidianBtnEl.disabled = disabled;
    if (this.obsidianGearBtnEl) this.obsidianGearBtnEl.disabled = disabled;
    if (this.changeVaultBtnEl) this.changeVaultBtnEl.disabled = disabled;
    if (this.obsidianSubfolderInputEl) this.obsidianSubfolderInputEl.disabled = disabled;
    if (this.obsidianWikilinksCheckboxEl) this.obsidianWikilinksCheckboxEl.disabled = disabled;
    if (this.obsidianAutoOpenCheckboxEl) this.obsidianAutoOpenCheckboxEl.disabled = disabled;
    if (this.obsidianUriOnlyBtnEl) this.obsidianUriOnlyBtnEl.disabled = disabled;
    if (this.repickBtnEl) this.repickBtnEl.disabled = disabled;
    if (this.toggleAllBtnEl) this.toggleAllBtnEl.disabled = disabled || this.images.length === 0;
    if (this.frontmatterCheckboxEl) this.frontmatterCheckboxEl.disabled = disabled;
    if (this.textareaEl) this.textareaEl.readOnly = disabled;
    for (const entry of this.cardMap.values()) {
      entry.checkboxEl.disabled = disabled;
    }
  }

  private handleWindowKeyDown(e: KeyboardEvent): void {
    if (this.isClosed) return;
    if (e.key === 'Escape' && !this.isDownloading) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      this.close();
    }
  }

  private extractFilenameFromUrl(url: string): string {
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

  private getStylesheet(): string {
    return `
      :host {
        all: initial;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif;
        color: #f8fafc;
      }

      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }

      .ms-backdrop {
        position: fixed;
        inset: 0;
        width: 100vw;
        height: 100vh;
        background: rgba(15, 23, 42, 0.75);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        animation: ms-fade-in 0.16s ease-out;
      }

      @keyframes ms-fade-in {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }

      .ms-modal {
        width: 90vw;
        max-width: 1100px;
        height: 85vh;
        background: #0f172a;
        border: 1px solid rgba(148, 163, 184, 0.22);
        border-radius: 14px;
        box-shadow: 0 25px 60px -15px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(59, 130, 246, 0.15);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        color: #f8fafc;
      }

      /* Header */
      .ms-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 20px;
        background: #1e293b;
        border-bottom: 1px solid rgba(148, 163, 184, 0.18);
        flex-shrink: 0;
        gap: 16px;
      }

      .ms-title-group {
        display: flex;
        align-items: center;
        gap: 12px;
        min-width: 0;
      }

      .ms-brand-logo {
        width: 32px;
        height: 32px;
        border-radius: 8px;
        background: linear-gradient(135deg, #0284c7 0%, #3b82f6 100%);
        color: #ffffff;
        font-weight: 800;
        font-size: 15px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        box-shadow: 0 2px 10px rgba(59, 130, 246, 0.35);
      }

      .ms-title-text-wrap {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }

      .ms-title {
        font-size: 15px;
        font-weight: 700;
        color: #f8fafc;
        letter-spacing: -0.01em;
        line-height: 1.25;
      }

      .ms-subtitle {
        font-size: 12px;
        color: #94a3b8;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 460px;
      }

      .ms-header-controls {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-shrink: 0;
      }

      .ms-stats-pill {
        font-size: 12px;
        font-weight: 600;
        padding: 5px 12px;
        border-radius: 999px;
        background: rgba(59, 130, 246, 0.14);
        color: #60a5fa;
        border: 1px solid rgba(59, 130, 246, 0.32);
        white-space: nowrap;
      }

      .ms-close-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 11px;
        border-radius: 8px;
        background: rgba(15, 23, 42, 0.65);
        color: #cbd5e1;
        border: 1px solid rgba(148, 163, 184, 0.2);
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.15s ease;
      }

      .ms-close-btn:hover {
        background: rgba(239, 68, 68, 0.18);
        color: #fca5a5;
        border-color: rgba(239, 68, 68, 0.4);
      }

      .ms-close-btn kbd {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 10px;
        padding: 1px 5px;
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.08);
        color: #94a3b8;
      }

      /* Split Pane Body */
      .ms-body {
        display: flex;
        flex: 1;
        min-height: 0;
        overflow: hidden;
      }

      .ms-left-pane {
        width: 60%;
        display: flex;
        flex-direction: column;
        border-right: 1px solid rgba(148, 163, 184, 0.18);
        background: #0f172a;
        min-width: 0;
      }

      .ms-right-pane {
        width: 40%;
        display: flex;
        flex-direction: column;
        background: #0f172a;
        min-width: 0;
      }

      .ms-pane-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 16px;
        background: rgba(30, 41, 59, 0.7);
        border-bottom: 1px solid rgba(148, 163, 184, 0.14);
        flex-shrink: 0;
        gap: 10px;
      }

      .ms-pane-title-wrap {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .ms-pane-title {
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: #cbd5e1;
      }

      .ms-editor-stats-badge {
        font-size: 11px;
        font-weight: 500;
        color: #94a3b8;
        background: rgba(15, 23, 42, 0.7);
        padding: 2px 8px;
        border-radius: 6px;
        border: 1px solid rgba(148, 163, 184, 0.15);
      }

      .ms-fm-toggle-label {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        font-size: 12px;
        font-weight: 500;
        color: #e2e8f0;
        cursor: pointer;
        user-select: none;
      }

      .ms-fm-toggle-label input[type='checkbox'] {
        accent-color: #3b82f6;
        width: 14px;
        height: 14px;
        cursor: pointer;
      }

      .ms-textarea {
        flex: 1;
        width: 100%;
        min-height: 0;
        border: none;
        outline: none;
        resize: none;
        padding: 16px;
        background: #0b1120;
        color: #e2e8f0;
        font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
        font-size: 13px;
        line-height: 1.6;
        overflow-y: auto;
        tab-size: 2;
      }

      .ms-textarea:focus {
        box-shadow: inset 0 0 0 1px rgba(59, 130, 246, 0.35);
      }

      /* Right Pane: Image Toggle Grid */
      .ms-toggle-all-btn {
        padding: 4px 10px;
        border-radius: 6px;
        font-size: 11.5px;
        font-weight: 600;
        background: #1e293b;
        color: #60a5fa;
        border: 1px solid rgba(59, 130, 246, 0.35);
        cursor: pointer;
        transition: all 0.15s ease;
      }

      .ms-toggle-all-btn:hover:not(:disabled) {
        background: rgba(59, 130, 246, 0.2);
        color: #93c5fd;
      }

      .ms-toggle-all-btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }

      .ms-gallery-grid {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 14px;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(155px, 1fr));
        gap: 12px;
        align-content: start;
      }

      .ms-empty-gallery {
        grid-column: 1 / -1;
        padding: 40px 20px;
        text-align: center;
        color: #64748b;
        font-size: 13px;
        border: 1px dashed rgba(148, 163, 184, 0.2);
        border-radius: 10px;
      }

      .ms-img-card {
        background: #1e293b;
        border: 1px solid rgba(59, 130, 246, 0.4);
        border-radius: 10px;
        overflow: hidden;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        transition: opacity 0.18s ease, transform 0.15s ease, border-color 0.15s ease, filter 0.18s ease;
        user-select: none;
      }

      .ms-img-card:hover {
        transform: translateY(-1px);
        border-color: #3b82f6;
      }

      .ms-img-card.dimmed {
        opacity: 0.42;
        filter: grayscale(70%);
        border-color: rgba(148, 163, 184, 0.18);
      }

      .ms-thumb-wrap {
        position: relative;
        width: 100%;
        height: 110px;
        background: #0b1120;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
      }

      .ms-thumb-img {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
        display: block;
      }

      .ms-dim-badge {
        position: absolute;
        bottom: 6px;
        left: 6px;
        font-size: 10px;
        font-weight: 600;
        padding: 2px 6px;
        border-radius: 4px;
        background: rgba(15, 23, 42, 0.85);
        color: #cbd5e1;
        border: 1px solid rgba(148, 163, 184, 0.2);
      }

      .ms-card-check-wrap {
        position: absolute;
        top: 7px;
        right: 7px;
        background: rgba(15, 23, 42, 0.82);
        border-radius: 6px;
        padding: 3px;
        display: flex;
        align-items: center;
        justify-content: center;
        border: 1px solid rgba(148, 163, 184, 0.25);
      }

      .ms-card-checkbox {
        accent-color: #3b82f6;
        width: 15px;
        height: 15px;
        cursor: pointer;
      }

      .ms-card-meta {
        padding: 8px 10px;
        border-top: 1px solid rgba(148, 163, 184, 0.12);
      }

      .ms-card-alt {
        font-size: 11.5px;
        font-weight: 500;
        color: #e2e8f0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /* Footer Bar */
      .ms-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 13px 20px;
        background: #1e293b;
        border-top: 1px solid rgba(148, 163, 184, 0.18);
        flex-shrink: 0;
        gap: 16px;
      }

      .ms-footer-left {
        display: flex;
        align-items: center;
        gap: 14px;
        min-width: 0;
        flex: 1;
      }

      .ms-footer-right {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-shrink: 0;
      }

      .ms-progress-container {
        display: none;
        align-items: center;
        gap: 10px;
        flex: 1;
        max-width: 340px;
      }

      .ms-progress-container.visible {
        display: flex;
      }

      .ms-progress-track {
        width: 110px;
        height: 6px;
        background: rgba(15, 23, 42, 0.8);
        border-radius: 999px;
        overflow: hidden;
        flex-shrink: 0;
        border: 1px solid rgba(148, 163, 184, 0.18);
      }

      .ms-progress-fill {
        height: 100%;
        width: 0%;
        background: linear-gradient(90deg, #0284c7 0%, #3b82f6 100%);
        transition: width 0.2s ease;
      }

      .ms-progress-fill.complete {
        background: #10b981;
      }

      .ms-progress-label {
        font-size: 12px;
        font-weight: 500;
        color: #93c5fd;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .ms-progress-label.complete {
        color: #34d399;
      }

      .ms-progress-label.error {
        color: #f87171;
      }

      .ms-btn {
        border: none;
        border-radius: 8px;
        padding: 9px 15px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
        transition: all 0.15s ease;
        white-space: nowrap;
      }

      .ms-btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }

      .ms-btn-ghost {
        background: rgba(15, 23, 42, 0.65);
        color: #cbd5e1;
        border: 1px solid rgba(148, 163, 184, 0.24);
      }

      .ms-btn-ghost:hover:not(:disabled) {
        background: rgba(51, 65, 85, 0.8);
        color: #ffffff;
        border-color: rgba(148, 163, 184, 0.4);
      }

      .ms-btn-secondary {
        background: #0f172a;
        color: #f1f5f9;
        border: 1px solid rgba(59, 130, 246, 0.35);
      }

      .ms-btn-secondary:hover:not(:disabled) {
        background: rgba(59, 130, 246, 0.15);
        border-color: #3b82f6;
      }

      .ms-btn-secondary.copied {
        background: rgba(16, 185, 129, 0.18);
        color: #34d399;
        border-color: rgba(16, 185, 129, 0.5);
      }

      .ms-btn-primary {
        background: linear-gradient(135deg, #2563eb 0%, #3b82f6 100%);
        color: #ffffff;
        box-shadow: 0 4px 14px rgba(59, 130, 246, 0.35);
      }

      .ms-btn-primary:hover:not(:disabled) {
        background: linear-gradient(135deg, #1d4ed8 0%, #2563eb 100%);
        transform: translateY(-1px);
      }

      /* Obsidian Settings Drawer Bar & Footer Buttons */
      .ms-obsidian-bar {
        display: none;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 14px;
        padding: 10px 20px;
        background: rgba(124, 58, 237, 0.1);
        border-top: 1px solid rgba(124, 58, 237, 0.3);
        flex-shrink: 0;
      }

      .ms-obsidian-bar.open {
        display: flex;
      }

      .ms-obsidian-group {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .ms-vault-status {
        font-size: 12px;
        font-weight: 600;
        color: #cbd5e1;
        padding: 4px 10px;
        border-radius: 6px;
        background: rgba(15, 23, 42, 0.75);
        border: 1px solid rgba(148, 163, 184, 0.22);
      }

      .ms-vault-status.linked {
        color: #ddd6fe;
        border-color: rgba(124, 58, 237, 0.45);
        background: rgba(124, 58, 237, 0.16);
      }

      .ms-vault-change-btn,
      .ms-vault-uri-btn {
        padding: 4px 10px;
        border-radius: 6px;
        font-size: 11.5px;
        font-weight: 600;
        background: #1e293b;
        color: #c4b5fd;
        border: 1px solid rgba(124, 58, 237, 0.4);
        cursor: pointer;
        transition: all 0.15s ease;
      }

      .ms-vault-change-btn:hover:not(:disabled),
      .ms-vault-uri-btn:hover:not(:disabled) {
        background: rgba(124, 58, 237, 0.25);
        color: #ede9fe;
        border-color: #8b5cf6;
      }

      .ms-obsidian-field-label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        font-weight: 500;
        color: #e2e8f0;
      }

      .ms-obsidian-subfolder-input {
        width: 125px;
        padding: 4px 8px;
        border-radius: 6px;
        border: 1px solid rgba(124, 58, 237, 0.4);
        background: #0b1120;
        color: #f8fafc;
        font-size: 12px;
        outline: none;
      }

      .ms-obsidian-subfolder-input:focus {
        border-color: #8b5cf6;
        box-shadow: 0 0 0 2px rgba(124, 58, 237, 0.25);
      }

      .ms-obsidian-check-label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        font-weight: 500;
        color: #e2e8f0;
        cursor: pointer;
        user-select: none;
      }

      .ms-obsidian-check-label input[type='checkbox'] {
        accent-color: #7c3aed;
        width: 14px;
        height: 14px;
        cursor: pointer;
      }

      .ms-obsidian-btn-cluster {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }

      .ms-btn-obsidian-gear {
        padding: 9px 10px;
        background: rgba(124, 58, 237, 0.16);
        color: #ddd6fe;
        border: 1px solid rgba(124, 58, 237, 0.4);
      }

      .ms-btn-obsidian-gear:hover:not(:disabled),
      .ms-btn-obsidian-gear.active {
        background: rgba(124, 58, 237, 0.32);
        border-color: #8b5cf6;
      }

      .ms-btn-obsidian {
        background: #7c3aed;
        color: #ffffff;
        box-shadow: 0 4px 14px rgba(124, 58, 237, 0.38);
      }

      .ms-btn-obsidian:hover:not(:disabled) {
        background: #6d28d9;
        transform: translateY(-1px);
      }
    `;
  }
}
