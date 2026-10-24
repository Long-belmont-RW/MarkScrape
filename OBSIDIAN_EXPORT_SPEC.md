# Feature Spec: Direct "Save to Obsidian Vault" Integration

## 1. Architectural Strategy (Why File System Access API + Obsidian URI)
Because the `obsidian://new` URI protocol cannot write binary image files to disk and hits URL length limits on long articles, MarkScrape implements a hybrid **Direct Vault File System Exporter**:

1. **Direct Disk Write (`window.showDirectoryPicker`):**
   - Uses Chrome's File System Access API to get a `FileSystemDirectoryHandle` pointing directly to the user's local Obsidian Vault directory (or a subfolder like `Clippings`).
   - Persists the `FileSystemDirectoryHandle` inside **IndexedDB** (`markscrape-obsidian-db`) so the user does not have to re-select their vault directory on every scrape. On subsequent scrapes, call `dirHandle.requestPermission({ mode: 'readwrite' })` to verify access in one click.
   - Writes `<sanitized-title>.md` into the target folder and writes all selected binary images directly into `<target-folder>/assets/img_<hash>.<ext>`.
2. **Auto-Open in Obsidian App (`obsidian://open`):**
   - Once the `.md` file and `/assets` images are written to disk, optionally triggers `window.open('obsidian://open?vault=<vaultName>&file=<encodedFilePath>', '_top')` to immediately focus and open the newly created note inside the Obsidian desktop app.
3. **Quick URI Fallback (`obsidian://new`):**
   - Provides a secondary option for text-only export (keeping remote `https://` image links) using `obsidian://new?name=<title>&content=<encodedMarkdown>` (using `clipboard=true` fallback if `content` exceeds 15,000 characters).

## 2. Obsidian-Specific Markdown Enhancements
- **YAML Frontmatter Tags:** Automatically include `tags: [clippings, markscrape]` and `created: YYYY-MM-DD` in the YAML frontmatter so Obsidian Properties/Dataview parses it cleanly.
- **Image Link Syntax Toggle:** Allow the user to choose between Standard Markdown Links (`![alt](assets/img_123.webp)`) and Obsidian Wikilinks (`![[assets/img_123.webp]]`).

## 3. UI Additions in `PreviewModal`
- Add a collapsible **"🟣 Obsidian Settings"** bar inside the modal footer/sidebar:
  - Vault Folder Status: Shows currently linked folder name (e.g., `📁 Vault: MyKnowledgeBase`) with a `"Change Folder"` button.
  - Subfolder input (default: `Clippings`).
  - Link Style toggle: `Markdown ![](...)` vs `Wikilink ![[...]]`.
  - Checkbox: `[x] Open in Obsidian after saving`.
- Add a primary purple **"🟣 Save to Obsidian Vault"** button (`#7c3aed` -> `#6d28d9` hover) next to the `"📦 Download .ZIP"` button in the modal footer.