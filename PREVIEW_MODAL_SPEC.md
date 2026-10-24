# Feature Spec: In-Page Shadow DOM Preview & Curation Modal

## 1. Architectural Overview
Instead of immediately downloading or copying when an element is clicked in `ElementPicker` (or when "Preview & Edit" is triggered), the Content Script transitions its Shadow DOM overlay from the **Picker HUD** into a centered, full-featured **Preview & Editor Modal**.

## 2. Two-Stage Deferred Asset Pipeline
1. **Stage A (Instant Preview Generation):**
   - Clone the selected DOM subtree, sanitize noisy tags, upgrade lazy image attributes (`data-src`, `srcset`, `<picture>`) to resolved remote `https://` URLs.
   - Extract a unique list of discovered images: `Array<{ id: string, remoteUrl: string, alt: string, included: boolean }>`.
   - Convert the HTML immediately to Markdown (with YAML frontmatter) where image links temporarily point to their remote URLs (or clean placeholder tokens mapped to `remoteUrl`).
   - Open the Shadow DOM Modal populated with the editable Markdown and the interactive Image Gallery.
2. **Stage B (Reactive Curation & Final Export):**
   - **Toggling Images:** Unchecking an image card in the gallery removes its corresponding `![...](remoteUrl)` markdown tag from the live textarea (and re-checking restores it or appends it).
   - **Live Text Editing:** The user can freely edit the Markdown text, headings, or frontmatter in the `<textarea>`.
   - **Final Actions:**
     - **Copy Markdown:** Copies the current `<textarea>` value (with remote image URLs intact) directly to the clipboard.
     - **Download .ZIP (MD + Selected Images):** Sends `{ markdownText, selectedImages, pageTitle, pageUrl }` to the Background/Asset Bundler. Only images with `included === true` (and still present in `markdownText`) are fetched, hashed (`img_<sha256>.<ext>`), placed into `/assets`, and rewritten in `index.md` inside the `.zip`.

## 3. UI/UX Layout (Inside Isolated Shadow DOM)
- **Backdrop:** Fixed full-screen blurred overlay (`rgba(15, 23, 42, 0.75)`, `backdrop-filter: blur(4px)`, `z-index: 2147483647`).
- **Modal Window:** `90vw` (max `1100px`), `85vh`, dark-mode sleek slate theme (`#0f172a` background, `#1e293b` panels, `#3b82f6` accents), split into two panes:
  - **Left Pane (60% width) - Live Markdown Editor:** Monospace `<textarea>` with character/word count badge and a "Include YAML Frontmatter" toggle.
  - **Right Pane (40% width) - Image Curation Grid:** Scrollable grid of thumbnail cards showing each scraped image, its dimensions/alt text, a checkbox toggle, and "Select All / Deselect All" header actions.
- **Footer Bar:** Progress bar during ZIP build, "Re-pick Element" button, "Copy Markdown" button, and primary "Download .ZIP (X images)" button.