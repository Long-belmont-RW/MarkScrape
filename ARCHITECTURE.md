# System Architecture: MarkScrape (HTML & Asset to Markdown Engine)

## 1. System Overview
MarkScrape is a production-grade CLI & programmatic tool built in TypeScript (Node.js) that scrapes any web page (static or SPA), extracts the core readable content, downloads and deduplicates all associated images locally, and outputs clean, deterministic GitHub Flavored Markdown (`.md`) with YAML frontmatter.

## 2. Tech Stack & Dependencies
- **Runtime:** Node.js (v20+) with TypeScript (`tsx` for execution, `tsup` or `tsc` for build)
- **Headless Browser:** `playwright` (Chromium)
- **DOM Manipulation & Extraction:** `jsdom`, `@mozilla/readability`
- **Markdown Conversion:** `turndown`, `@truto/turndown-plugin-gfm` (or `turndown-plugin-gfm`)
- **CLI Framework:** `commander`, `ora` (spinners), `chalk` (styling)
- **Utilities:** `zod` (validation), `p-limit` (concurrency control)

## 3. Directory Structure
```text
markscrape/
├── package.json
├── tsconfig.json
├── ARCHITECTURE.md
└── src/
    ├── index.ts                # CLI Entrypoint (Commander setup)
    ├── types.ts                # Interfaces & Zod schemas
    ├── pipeline/
    │   ├── 1-fetcher.ts        # Playwright browser hydration, network cache & auto-scroll
    │   ├── 2-sanitizer.ts      # Pre-Readability DOM prep & Readability content extraction
    │   ├── 3-asset-manager.ts  # Image URL resolution, anti-hotlink download, SHA-256 dedup
    │   ├── 4-converter.ts      # Turndown AST setup & custom GFM/Table/Code rules
    │   └── 5-bundler.ts        # YAML frontmatter injection & disk writer
    └── utils/
        ├── url-helpers.ts      # srcset parser, relative-to-absolute URL resolver
        └── logger.ts           # Structured CLI logging
4. Pipeline Stage Specifications


Stage 1: Fetcher (src/pipeline/1-fetcher.ts)
Launch Playwright Chromium headlessly.

Attach a page.on('response') listener BEFORE navigation to cache incoming image buffers (resourceType() === 'image') in memory (Map<string, { buffer: Buffer, contentType: string }>).

Navigate to target URL with waitUntil: 'networkidle' (fallback to 'domcontentloaded' if timeout occurs after 15s).

Run an autoScroll(page) evaluation script that scrolls down in 400px increments every 100ms until the bottom of the page is reached to trigger IntersectionObserver lazy-loaded images.

Return { rawHtml, finalUrl, imageCache, page, browser } (keep page open until Stage 3 completes so page.request can be used for missing images).

Stage 2: Sanitizer (src/pipeline/2-sanitizer.ts)
Parse rawHtml using JSDOM(rawHtml, { url: finalUrl }).

CRITICAL PRE-PROCESSING: @mozilla/readability strips data-* attributes and sometimes alters <picture> tags. Before running Readability:

Resolve all <a> relative href attributes to absolute URLs.

Traverse all <img> tags: extract the highest-res URL from parent <picture><source srcset>, data-srcset, srcset, data-src, data-lazy-src, or data-original, and write that resolved absolute URL directly into img.setAttribute('src', resolvedUrl).

Unwrap <picture> tags so <img> sits directly in the parent container.

Execute new Readability(document).parse().

Return extracted { title, byline, siteName, excerpt, contentHtml }.

Stage 3: Asset Manager (src/pipeline/3-asset-manager.ts)
Parse contentHtml into a clean JSDOM instance.

Locate all <img> elements. Use p-limit(5) for concurrent processing.

For each <img>:

Handle data:image/...;base64 by decoding the buffer directly.

For http/https URLs, check the Stage 1 imageCache first. If missing, fetch using page.request.get(imgUrl, { headers: { Referer: finalUrl } }) to bypass CDN hotlink protection and inherit cookies.

Discard images with byteLength < 300 (tracking pixels) and remove their <img> node from the DOM.

Determine extension via Content-Type header (image/jpeg -> .jpg, image/png -> .png, image/webp -> .webp, image/svg+xml -> .svg, image/gif -> .gif).

Hash the binary buffer using crypto.createHash('sha256') (take first 12 hex chars) -> img_<hash>.<ext>.

Write file to <outputDir>/assets/img_<hash>.<ext>.

Mutate img.setAttribute('src', './assets/img_<hash>.<ext>') and strip srcset/sizes.

Close the Playwright browser after all assets are downloaded.

Stage 4: Converter (src/pipeline/4-converter.ts)
Initialize TurndownService with headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-'.

Load the GFM plugin for tables, strikethrough, and task lists.

Add custom Turndown rules:

Table Cell Sanitization: Inside <td> and <th>, replace nested <p> and <br> tags with inline <br> or spaces so multi-line cells do not break Markdown table syntax.

Code Blocks: Preserve language identifiers from <pre><code class="language-xyz"> or data-language attributes.

Figures: Convert <figure> containing an <img> and <figcaption> into standard Markdown image followed by an italicized caption line (*Caption text*).

Stage 5: Bundler (src/pipeline/5-bundler.ts)
Generate YAML frontmatter (title, source_url, author, site_name, date_scraped).

Combine frontmatter + # <title> + Markdown body.

Normalize excessive blank lines (max 2 consecutive newlines).

Save to <outputDir>/index.md.