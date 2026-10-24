export type PickerOutputMode = 'zip' | 'clipboard';

export type PickerToastVariant = 'loading' | 'success' | 'error';

export type ElementSelectedCallback = (
  selectedElement: HTMLElement,
  picker: ElementPicker
) => void | Promise<void>;

export interface ElementPickerOptions {
  outputMode: PickerOutputMode;
  onSelect: ElementSelectedCallback;
  onCancel?: () => void;
}

const HOST_ID = 'markscrape-picker-host';

/**
 * Interactive Shadow DOM Visual Element Picker for MarkScrape.
 * Renders a zero-bleed highlight overlay, element metadata badge, and floating HUD/progress toast.
 */
export class ElementPicker {
  private readonly options: ElementPickerOptions;
  private hostEl: HTMLDivElement | null = null;
  private shadowRoot: ShadowRoot | null = null;
  private highlightBoxEl: HTMLDivElement | null = null;
  private badgeEl: HTMLDivElement | null = null;
  private hudBarEl: HTMLDivElement | null = null;
  private hudTextEl: HTMLSpanElement | null = null;
  private hudModeBadgeEl: HTMLSpanElement | null = null;
  private hudSpinnerEl: HTMLSpanElement | null = null;

  private currentTarget: HTMLElement | null = null;
  private isPicking = false;
  private isCleanedUp = false;

  // Bound event listeners (all registered in capture phase)
  private readonly boundMouseMove: (e: MouseEvent) => void;
  private readonly boundKeyDown: (e: KeyboardEvent) => void;
  private readonly boundClick: (e: MouseEvent) => void;
  private readonly boundPointerSuppress: (e: Event) => void;
  private readonly boundViewportChange: () => void;

  constructor(options: ElementPickerOptions) {
    this.options = options;
    this.boundMouseMove = this.handleMouseMove.bind(this);
    this.boundKeyDown = this.handleKeyDown.bind(this);
    this.boundClick = this.handleClick.bind(this);
    this.boundPointerSuppress = this.handlePointerSuppress.bind(this);
    this.boundViewportChange = this.handleViewportChange.bind(this);
  }

  /**
   * Mounts the isolated Shadow DOM container and activates capture-phase event listeners.
   */
  public start(): void {
    // Remove any stale picker host from a previous session
    const existingHost = document.getElementById(HOST_ID);
    if (existingHost) {
      existingHost.remove();
    }

    this.isCleanedUp = false;
    this.isPicking = true;

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = [
      'position: fixed !important',
      'top: 0 !important',
      'left: 0 !important',
      'width: 100vw !important',
      'height: 100vh !important',
      'z-index: 2147483647 !important',
      'pointer-events: none !important',
      'margin: 0 !important',
      'padding: 0 !important',
      'border: none !important',
      'background: transparent !important',
    ].join('; ');

    const shadow = host.attachShadow({ mode: 'open' });

    const styleEl = document.createElement('style');
    styleEl.textContent = `
      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif;
      }

      .hud-bar {
        position: fixed;
        top: 16px;
        left: 50%;
        transform: translateX(-50%);
        display: inline-flex;
        align-items: center;
        gap: 10px;
        padding: 10px 16px;
        border-radius: 999px;
        background: rgba(11, 15, 25, 0.94);
        color: #f8fafc;
        border: 1px solid rgba(56, 189, 248, 0.35);
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(15, 23, 42, 0.6);
        backdrop-filter: blur(10px);
        font-size: 13px;
        font-weight: 500;
        line-height: 1.3;
        white-space: nowrap;
        pointer-events: none;
        transition: border-color 0.2s ease, background 0.2s ease, transform 0.2s ease;
        max-width: 92vw;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .hud-bar.toast-loading {
        border-color: rgba(59, 130, 246, 0.65);
        background: rgba(15, 23, 42, 0.96);
      }

      .hud-bar.toast-success {
        border-color: rgba(16, 185, 129, 0.7);
        background: rgba(6, 78, 59, 0.95);
        color: #ecfdf5;
      }

      .hud-bar.toast-error {
        border-color: rgba(239, 68, 68, 0.75);
        background: rgba(127, 29, 29, 0.95);
        color: #fef2f2;
      }

      .hud-mode-pill {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding: 3px 8px;
        border-radius: 999px;
        background: linear-gradient(135deg, #0284c7 0%, #2563eb 100%);
        color: #ffffff;
        flex-shrink: 0;
      }

      .hud-spinner {
        width: 14px;
        height: 14px;
        border: 2px solid rgba(56, 189, 248, 0.3);
        border-top-color: #38bdf8;
        border-radius: 50%;
        animation: markscrape-spin 0.75s linear infinite;
        display: none;
        flex-shrink: 0;
      }

      .hud-spinner.visible {
        display: inline-block;
      }

      @keyframes markscrape-spin {
        to {
          transform: rotate(360deg);
        }
      }

      .highlight-box {
        position: fixed;
        top: 0;
        left: 0;
        width: 0;
        height: 0;
        border: 2px solid #3b82f6;
        background: rgba(59, 130, 246, 0.12);
        border-radius: 4px;
        pointer-events: none;
        display: none;
        transition: top 0.04s linear, left 0.04s linear, width 0.04s linear, height 0.04s linear;
        box-shadow: 0 0 0 1px rgba(37, 99, 235, 0.2), inset 0 0 12px rgba(59, 130, 246, 0.08);
      }

      .info-badge {
        position: absolute;
        top: -26px;
        left: -2px;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 3px 9px;
        border-radius: 5px;
        background: #1d4ed8;
        color: #ffffff;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 11.5px;
        font-weight: 600;
        line-height: 1.3;
        white-space: nowrap;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        pointer-events: none;
      }

      .info-badge.inside-top {
        top: 4px;
        left: 4px;
      }
    `;

    const hudBar = document.createElement('div');
    hudBar.className = 'hud-bar';

    const hudSpinner = document.createElement('span');
    hudSpinner.className = 'hud-spinner';

    const hudModeBadge = document.createElement('span');
    hudModeBadge.className = 'hud-mode-pill';
    hudModeBadge.textContent = this.options.outputMode === 'zip' ? 'ZIP Mode' : 'Clipboard';

    const hudText = document.createElement('span');
    hudText.textContent =
      'Click to scrape element • ↑/↓ arrows to expand/shrink selection • ESC to cancel';

    hudBar.appendChild(hudSpinner);
    hudBar.appendChild(hudModeBadge);
    hudBar.appendChild(hudText);

    const highlightBox = document.createElement('div');
    highlightBox.className = 'highlight-box';

    const badge = document.createElement('div');
    badge.className = 'info-badge';
    highlightBox.appendChild(badge);

    shadow.appendChild(styleEl);
    shadow.appendChild(highlightBox);
    shadow.appendChild(hudBar);

    (document.documentElement || document.body).appendChild(host);

    this.hostEl = host;
    this.shadowRoot = shadow;
    this.highlightBoxEl = highlightBox;
    this.badgeEl = badge;
    this.hudBarEl = hudBar;
    this.hudTextEl = hudText;
    this.hudModeBadgeEl = hudModeBadge;
    this.hudSpinnerEl = hudSpinner;

    this.attachPickingListeners();
  }

  /**
   * Switches the top-center HUD bar into a progress/status toast and hides the picker bounding box.
   */
  public showProgress(message: string, variant: PickerToastVariant = 'loading'): void {
    if (this.isCleanedUp || !this.hudBarEl || !this.hudTextEl) return;

    if (this.highlightBoxEl) {
      this.highlightBoxEl.style.display = 'none';
    }
    if (this.hudModeBadgeEl) {
      this.hudModeBadgeEl.style.display = 'none';
    }

    this.hudBarEl.className = `hud-bar toast-${variant}`;
    this.hudTextEl.textContent = message;

    if (this.hudSpinnerEl) {
      if (variant === 'loading') {
        this.hudSpinnerEl.classList.add('visible');
      } else {
        this.hudSpinnerEl.classList.remove('visible');
      }
    }
  }

  /**
   * Detaches all event listeners and removes the Shadow DOM host from the page.
   */
  public cleanup(): void {
    if (this.isCleanedUp) return;
    this.isCleanedUp = true;
    this.isPicking = false;

    this.detachPickingListeners();

    if (this.hostEl) {
      this.hostEl.remove();
      this.hostEl = null;
    }

    this.shadowRoot = null;
    this.highlightBoxEl = null;
    this.badgeEl = null;
    this.hudBarEl = null;
    this.hudTextEl = null;
    this.hudModeBadgeEl = null;
    this.hudSpinnerEl = null;
    this.currentTarget = null;
  }

  private attachPickingListeners(): void {
    window.addEventListener('mousemove', this.boundMouseMove, true);
    window.addEventListener('keydown', this.boundKeyDown, true);
    window.addEventListener('click', this.boundClick, true);
    window.addEventListener('mousedown', this.boundPointerSuppress, true);
    window.addEventListener('mouseup', this.boundPointerSuppress, true);
    window.addEventListener('scroll', this.boundViewportChange, true);
    window.addEventListener('resize', this.boundViewportChange, true);
  }

  private detachPickingListeners(): void {
    window.removeEventListener('mousemove', this.boundMouseMove, true);
    window.removeEventListener('keydown', this.boundKeyDown, true);
    window.removeEventListener('click', this.boundClick, true);
    window.removeEventListener('mousedown', this.boundPointerSuppress, true);
    window.removeEventListener('mouseup', this.boundPointerSuppress, true);
    window.removeEventListener('scroll', this.boundViewportChange, true);
    window.removeEventListener('resize', this.boundViewportChange, true);
  }

  private isPickerInternalNode(node: Element | null): boolean {
    if (!node) return true;
    if (node.id === HOST_ID || node.id === 'markscrape-preview-modal-host') return true;
    if (this.hostEl && this.hostEl.contains(node)) return true;
    return false;
  }

  private handleMouseMove(e: MouseEvent): void {
    if (!this.isPicking) return;

    const hit = document.elementFromPoint(e.clientX, e.clientY);
    if (!hit || !(hit instanceof HTMLElement) || this.isPickerInternalNode(hit)) {
      return;
    }

    if (hit !== this.currentTarget) {
      this.currentTarget = hit;
      this.updateHighlight();
    }
  }

  private handleViewportChange(): void {
    if (!this.isPicking || !this.currentTarget) return;
    this.updateHighlight();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (!this.isPicking) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      this.cleanup();
      this.options.onCancel?.();
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      if (!this.currentTarget) return;
      const parent = this.currentTarget.parentElement;
      if (
        parent &&
        parent !== document.body &&
        parent !== document.documentElement &&
        !this.isPickerInternalNode(parent)
      ) {
        this.currentTarget = parent;
        this.updateHighlight();
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      if (!this.currentTarget) return;
      const firstChild = this.currentTarget.firstElementChild;
      if (
        firstChild &&
        firstChild instanceof HTMLElement &&
        !this.isPickerInternalNode(firstChild)
      ) {
        this.currentTarget = firstChild;
        this.updateHighlight();
      }
      return;
    }
  }

  private handlePointerSuppress(e: Event): void {
    if (!this.isPicking) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  private handleClick(e: MouseEvent): void {
    if (!this.isPicking) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    let selected = this.currentTarget;
    if (!selected) {
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      if (hit instanceof HTMLElement && !this.isPickerInternalNode(hit)) {
        selected = hit;
      }
    }

    if (!selected) return;

    // Lock selection and stop intercepting further page clicks/keys
    this.isPicking = false;
    this.detachPickingListeners();

    void this.options.onSelect(selected, this);
  }

  private formatElementBadgeLabel(el: HTMLElement): string {
    const tag = el.tagName.toLowerCase();
    const cleanClasses = Array.from(el.classList)
      .map((c) => c.trim())
      .filter((c) => c.length > 0 && !c.includes(':'))
      .slice(0, 2);

    const classSuffix = cleanClasses.length > 0 ? `.${cleanClasses.join('.')}` : '';
    const selectorText = `${tag}${classSuffix}`;
    const imgCount = tag === 'img' ? 1 : el.querySelectorAll('img').length;

    return `${selectorText} • ${imgCount} imgs`;
  }

  private updateHighlight(): void {
    if (!this.currentTarget || !this.highlightBoxEl || !this.badgeEl) return;

    const rect = this.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) {
      this.highlightBoxEl.style.display = 'none';
      return;
    }

    this.highlightBoxEl.style.display = 'block';
    this.highlightBoxEl.style.top = `${Math.round(rect.top)}px`;
    this.highlightBoxEl.style.left = `${Math.round(rect.left)}px`;
    this.highlightBoxEl.style.width = `${Math.round(rect.width)}px`;
    this.highlightBoxEl.style.height = `${Math.round(rect.height)}px`;

    this.badgeEl.textContent = this.formatElementBadgeLabel(this.currentTarget);

    if (rect.top < 30) {
      this.badgeEl.classList.add('inside-top');
    } else {
      this.badgeEl.classList.remove('inside-top');
    }
  }
}
