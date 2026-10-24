# Feature Spec: Interactive DOM Element Picker Mode

## 1. Architectural Constraint (The "Popup Closes" Problem)
When a user clicks "Pick Element to Scrape" in the extension Popup, they must interact with the host webpage. Clicking the webpage immediately closes `popup.html`. Therefore:
1. Clicking **"Select Element on Page"** in the popup sends `{ action: 'START_ELEMENT_PICKER', options }` to `content-script.ts` and immediately calls `window.close()` on the popup.
2. The Content Script renders an isolated **Shadow DOM UI overlay** (highlighter box + floating status banner) directly on the page.
3. Once the user clicks a target DOM element, the Content Script extracts and normalizes that specific element's HTML (skipping `@mozilla/readability` since the user manually isolated the exact container they want) and sends the payload to **`background.ts`** (Service Worker) to download the images, build the `JSZip` archive, and trigger the browser download.

## 2. User Experience & Keyboard Controls
- **Hover:** Draws a smooth bounding box (`border: 2px solid #3b82f6`, `background: rgba(59, 130, 246, 0.12)`) over the currently hovered DOM element, with a small pill badge showing the tag & class (e.g., `article.post-content | 4 images`).
- **Parent/Child Navigation:**
  - Pressing `ArrowUp` (or `W`) expands the selection to `currentElement.parentElement`.
  - Pressing `ArrowDown` (or `S`) narrows the selection to `currentElement.firstElementChild`.
- **Click:** Locks the selection, prevents the default page click (`e.preventDefault()`, `e.stopPropagation()`), shows an in-page floating progress toast (`"Downloading 4 images & building Markdown..."`), and sends the job to `background.ts` or processes it cleanly.
- **Cancel:** Pressing `Escape` cleanly removes all event listeners and destroys the Shadow DOM overlay.

## 3. Pipeline Differences for Picked Elements
- **Bypass Readability:** Do NOT run `@mozilla/readability` on a manually picked element (Readability fails on small snippets, sidebars, or single tables).
- **Clone & Sanitize:** Clone `selectedElement.cloneNode(true)`, strip `<script>`, `<style>`, `<noscript>`, `<svg>` icons smaller than 24x24, and hidden elements (`[aria-hidden="true"]`).
- **Run Standard Asset & Turndown Pipeline:** Run the exact same lazy-image attribute upgrader (`srcset`/`data-src` -> `src`), image downloader + SHA-256 hasher, and `Turndown` GFM converter on the cloned subtree.