# MarkScrape

**MarkScrape** is a production-grade HTML & Asset-to-Markdown Engine available as both a **Node.js CLI** (powered by Playwright) and a **Chrome Extension (Manifest V3)**.

It scrapes static pages or SPAs, extracts readable content (or user-selected DOM elements), downloads and deduplicates images locally using SHA-256 hashing, and outputs clean, deterministic **GitHub Flavored Markdown (`.md`)** with YAML frontmatter.

---

## ✨ Key Features

- **5-Stage Automated Scraping Pipeline**
  1. **Fetcher:** Headless Chromium hydration with network-level image caching and automatic scrolling to trigger `IntersectionObserver` lazy-loaded images.
  2. **DOM Sanitizer:** Resolves relative links, upgrades lazy attributes (`data-src`, `srcset`, `<picture>`), and extracts core article content via `@mozilla/readability`.
  3. **Asset Manager:** Downloads images with anti-hotlink `Referer` headers and active cookies, filters out tracking pixels (`< 300 bytes`), and deduplicates assets via SHA-256 (`img_<hash>.<ext>`).
  4. **GFM Converter:** Converts HTML to GitHub Flavored Markdown via `turndown` + `turndown-plugin-gfm`, with custom rules for multi-line table cells, language-tagged code blocks, and `<figure>` captions.
  5. **Bundler:** Injects YAML frontmatter (`title`, `source_url`, `author`, `site_name`, `date_scraped`) and writes `index.md` + `./assets/`.

- **Chrome Extension (Manifest V3)**
  - **Full-Page & Active-Tab Scraping:** One-click `.zip` bundle download (`index.md` + `assets/`) or clipboard copy.
  - **Interactive DOM Element Picker:** Hover and select specific DOM containers on any live page with `ArrowUp`/`ArrowDown` (or `W`/`S`) hierarchy navigation.
  - **In-Page Preview & Curation Studio:** Isolated Shadow DOM modal and full-tab editor featuring a live Markdown editor, interactive image curation grid, and YAML frontmatter toggles.
  - **Direct Obsidian Vault Integration:** Save curated Markdown notes and localized image assets directly into a local Obsidian Vault folder via the File System Access API (supports both standard Markdown links and `![[Wikilinks]]`) or `obsidian://` URI protocol.

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** v20+
- **npm**

### Installation

```bash
git clone https://github.com/Long-belmont-RW/MarkScrape.git
cd MarkScrape
npm install
npx playwright install chromium
```

---

## 💻 CLI Usage

Run the CLI directly with `npm start` (via `tsx`) or build it first with `npm run build`:

```bash
# Scrape a URL into a timestamped ./output/<domain>-<timestamp>/ folder
npm start -- https://example.com/article

# Specify a custom output directory and concurrency
npm start -- https://example.com/article -o ./my-article -c 8

# Run Chromium in visible (non-headless) mode with a custom timeout
npm start -- https://example.com/article --no-headless --timeout 45000
```

### CLI Options

| Flag | Description | Default |
| :--- | :--- | :--- |
| `<url>` | Target URL to scrape (required) | — |
| `-o, --output <dir>` | Output directory for `index.md` and `./assets/` | `./output/<domain>-<timestamp>` |
| `-c, --concurrency <number>` | Max concurrent image downloads | `5` |
| `--no-headless` | Run Chromium in visible mode for debugging | `headless: true` |
| `--timeout <ms>` | Navigation timeout in milliseconds | `30000` |

---

## 🧩 Chrome Extension Setup

1. **Build the extension bundle:**
   ```bash
   npm run build:ext
   ```
   This compiles the Manifest V3 extension into the `dist-extension/` directory.

2. **Load into Chrome / Edge / Brave:**
   - Open `chrome://extensions/`
   - Enable **Developer mode** (top-right toggle)
   - Click **Load unpacked** and select the `dist-extension/` folder.

3. **Using the Extension:**
   - Click the **MarkScrape** icon in your browser toolbar.
   - Choose **Open in Editor Studio**, **Pick Element on Page**, **Download Full Page (.ZIP)**, or **Copy Raw Markdown**.

---

## 📂 Project Structure

```text
MarkScrape/
├── src/
│   ├── index.ts                     # Node.js CLI entrypoint
│   ├── types.ts                     # Shared TypeScript interfaces & Zod schemas
│   ├── core/                        # Environment-agnostic DOM & Turndown engine
│   │   ├── dom-preparer.ts          # Lazy-image upgrader, <picture> unwrapper, URL resolver
│   │   └── converter.ts             # Turndown GFM configuration & custom AST rules
│   ├── pipeline/                    # Node.js 5-stage scraping pipeline
│   │   ├── 1-fetcher.ts             # Playwright Chromium fetcher & network image cache
│   │   ├── 2-sanitizer.ts           # JSDOM & Readability extraction
│   │   ├── 3-asset-manager.ts       # Concurrent downloader & SHA-256 deduplicator
│   │   ├── 4-converter.ts           # Pipeline HTML-to-Markdown wrapper
│   │   └── 5-bundler.ts             # YAML frontmatter & disk bundler
│   ├── extension/                   # Chrome Extension (Manifest V3)
│   │   ├── manifest.json            # Extension manifest
│   │   ├── popup.html / popup.ts    # Extension toolbar popup UI
│   │   ├── content-script.ts        # DOM cloning, auto-scroll & page messaging
│   │   ├── element-picker.ts        # Shadow DOM interactive element selector
│   │   ├── preview-modal.ts         # In-page Shadow DOM preview & image curation studio
│   │   ├── editor.html / editor.ts  # Dedicated full-tab Markdown & asset studio
│   │   ├── obsidian-exporter.ts     # Direct File System Access API & Obsidian URI exporter
│   │   └── background.ts            # Service worker for CORS-free image fetching & JSZip
│   └── utils/
│       ├── logger.ts                # CLI spinner & structured logging
│       └── url-helpers.ts           # srcset parser & URL resolution helpers
├── ARCHITECTURE.md                  # Core CLI pipeline architecture
├── EXTENSION_ARCHITECTURE.md        # Chrome Extension architecture
├── ELEMENT_PICKER_SPEC.md           # Interactive DOM picker specification
├── PREVIEW_MODAL_SPEC.md            # Preview & curation studio specification
├── OBSIDIAN_EXPORT_SPEC.md          # Obsidian vault export specification
├── package.json
├── tsconfig.json
└── vite.extension.config.ts         # Vite build config for the Chrome Extension
```

---

## 🛠️ Scripts

- `npm start -- <url>`: Run the CLI scraper using `tsx`
- `npm run build`: Compile TypeScript for the CLI into `dist/`
- `npm run build:ext`: Bundle the Chrome Extension into `dist-extension/`
- `npm run typecheck`: Run TypeScript type checking (`tsc --noEmit`)

---

## 📄 License

MIT
