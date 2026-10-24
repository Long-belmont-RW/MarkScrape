# Chrome Extension Architecture (Manifest V3) - MarkScrape

## 1. Architectural Goal
Refactor MarkScrape so the core sanitization and Markdown conversion rules are shared, while adding a Manifest V3 Chrome Extension target built with **Vite** (or `tsup`/`esbuild`). The extension scrapes the currently active tab, fetches and deduplicates all images into an `/assets` folder inside an in-memory ZIP archive (`jszip`), and downloads a single `<page-slug>.zip` file (or copies the Markdown to the clipboard).

## 2. Updated Directory Structure
```text
markscrape/
├── ARCHITECTURE.md
├── EXTENSION_ARCHITECTURE.md
├── package.json
├── vite.extension.config.ts     # Bundles Popup, Background, and Content Script for Chrome
└── src/
    ├── core/                    # Shared browser-compatible logic (No Node 'fs' or 'crypto' imports!)
    │   ├── dom-preparer.ts      # Upgrades lazy images, unwraps <picture>, resolves URLs on a DOM Document
    │   └── converter.ts         # Turndown + GFM + custom Table/Code/Figure rules
    ├── pipeline/                # Existing Node CLI pipeline
    └── extension/               # Chrome Extension (Manifest V3)
        ├── manifest.json
        ├── popup.html           # Clean UI with "Download ZIP (.md + images)" & "Copy Markdown" buttons
        ├── popup.ts             # Triggers scrape on active tab & displays progress
        ├── content-script.ts    # Auto-scrolls tab, clones DOM, runs Readability + Turndown
        └── background.ts        # Service worker: fetches images (bypasses CORS), hashes via Web Crypto, zips via JSZip
3. Chrome Extension Data Flow (4 Steps)
Step 1: Popup UI (src/extension/popup.html & popup.ts)
User clicks the extension icon. Popup shows:

Toggle: [x] Auto-scroll page to load lazy images

Button 1: Download Bundle (.zip with Images)

Button 2: Copy Raw Markdown Only

Status indicator & progress bar.

Clicking a button injects/messages content-script.ts on the active tab.

Step 2: Content Script (src/extension/content-script.ts)
If autoScroll is enabled, smoothly scrolls the window to the bottom (capped at 20 iterations) and scrolls back to top.

Clones the live DOM: const docClone = document.cloneNode(true) as Document; (Never mutate the user's live page!).

Runs prepareDomForReadability(docClone, window.location.href) to resolve relative links, extract highest-res srcset / data-src URLs into img.src, and unwrap <picture> tags.

Runs new Readability(docClone).parse().

Extracts all <img> URLs from the Readability HTML.

Sends payload { title, byline, siteName, pageUrl, readableHtml, imageUrls } to background.ts (or processes in popup/content script) for asset downloading and ZIP creation.

Step 3: Image Fetching & Web Crypto Hashing (src/extension/background.ts or popup.ts)
Because the extension has "host_permissions": ["<all_urls>"] in manifest.json, fetch(imgUrl, { credentials: 'include' }) inside the extension context automatically bypasses CORS and includes the user's active browser cookies!

For each unique image URL (concurrency limit of 5):

Fetch ArrayBuffer. Skip if byteLength < 300.

Compute SHA-256 using Web Crypto API (await crypto.subtle.digest('SHA-256', arrayBuffer)), convert to 12-char hex string -> img_<hash>.<ext>.

Add binary to JSZip folder: zip.folder("assets").file(filename, arrayBuffer).

Record mapping remoteUrl -> ./assets/img_<hash>.<ext>.

Step 4: Markdown Conversion & ZIP Download
Replace all remote img.src attributes in readableHtml with their new ./assets/img_<hash>.<ext> local paths.

Run convertHtmlToMarkdown(mutatedHtml) using TurndownService + GFM rules.

Prepend YAML frontmatter (title, source_url, date_scraped).

Add index.md to the root of the JSZip instance.

Generate the ZIP blob (zip.generateAsync({ type: 'blob' })) and trigger browser download as <sanitized-page-title>.zip.