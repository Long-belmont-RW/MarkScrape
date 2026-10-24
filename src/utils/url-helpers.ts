/**
 * Resolves a potentially relative URL against a base URL.
 * Preserves data: URIs and returns null if the URL is invalid or non-fetchable (e.g., javascript:, mailto:).
 */
export function resolveUrl(rawUrl: string | null | undefined, baseUrl: string): string | null {
  if (!rawUrl) return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith('#') || /^javascript:/i.test(trimmed)) {
    return null;
  }
  if (/^data:image\//i.test(trimmed)) {
    return trimmed;
  }
  try {
    const resolved = new URL(trimmed, baseUrl);
    if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
      return resolved.href;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Splits comma-separated `srcset` entries (handling URLs that may contain commas in query params
 * by matching descriptor tokens), parses width (`w`) or pixel density (`x`) descriptors,
 * and returns the highest-resolution URL.
 */
export function parseHighestResSrcset(srcset: string): string | null {
  if (!srcset || !srcset.trim()) {
    return null;
  }

  // Standard srcset entries are separated by commas, though URLs themselves might contain commas
  // if not followed by space. Splitting by /,\s+/ or parsing tokens handles common patterns cleanly.
  const rawEntries = srcset
    .trim()
    .split(/,\s+/)
    .flatMap((part) => {
      // Also handle tight comma separation like "img1.jpg 1x,img2.jpg 2x" where descriptor precedes comma
      return part.split(/(?<=\s\d+(?:\.\d+)?[wx]),/i);
    })
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (rawEntries.length === 0) {
    return null;
  }

  let bestUrl: string | null = null;
  let maxScore = -1;

  for (const entry of rawEntries) {
    const parts = entry.split(/\s+/);
    const urlCandidate = parts[0];
    if (!urlCandidate) continue;

    let score = 1; // Default 1x / baseline score if no descriptor is present
    if (parts.length > 1) {
      const descriptor = parts[parts.length - 1].toLowerCase();
      if (descriptor.endsWith('w')) {
        const width = parseFloat(descriptor.slice(0, -1));
        if (!Number.isNaN(width) && width > 0) {
          score = width;
        }
      } else if (descriptor.endsWith('x')) {
        const density = parseFloat(descriptor.slice(0, -1));
        if (!Number.isNaN(density) && density > 0) {
          // Weight pixel density on a comparable scale if mixed, or compare directly
          score = density * 1000;
        }
      }
    }

    if (score >= maxScore) {
      maxScore = score;
      bestUrl = urlCandidate;
    }
  }

  return bestUrl;
}

/**
 * Inspects parent `<picture><source>` tags, `data-srcset`, `srcset`, `data-src`,
 * `data-lazy-src`, `data-original`, and `src`, resolving relative paths against `baseUrl`.
 */
export function extractTrueImageUrl(img: Element, baseUrl: string): string | null {
  const candidates: string[] = [];

  // 1. Inspect parent <picture> and its <source> children
  const parent = img.parentElement;
  if (parent && parent.tagName.toLowerCase() === 'picture') {
    const sources = Array.from(parent.querySelectorAll('source'));
    for (const source of sources) {
      const dataSrcset = source.getAttribute('data-srcset');
      if (dataSrcset) {
        const parsed = parseHighestResSrcset(dataSrcset);
        if (parsed) candidates.push(parsed);
      }
      const srcset = source.getAttribute('srcset');
      if (srcset) {
        const parsed = parseHighestResSrcset(srcset);
        if (parsed) candidates.push(parsed);
      }
      const src = source.getAttribute('data-src') || source.getAttribute('src');
      if (src) {
        candidates.push(src);
      }
    }
  }

  // 2. Check data-srcset and srcset on the <img> element itself
  const imgDataSrcset = img.getAttribute('data-srcset') || img.getAttribute('data-lazy-srcset');
  if (imgDataSrcset) {
    const parsed = parseHighestResSrcset(imgDataSrcset);
    if (parsed) candidates.push(parsed);
  }

  const imgSrcset = img.getAttribute('srcset');
  if (imgSrcset) {
    const parsed = parseHighestResSrcset(imgSrcset);
    if (parsed) candidates.push(parsed);
  }

  // 3. Check lazy-loading single-URL attributes before falling back to src
  const lazyAttrs = [
    'data-src',
    'data-lazy-src',
    'data-original',
    'data-actualsrc',
    'data-hi-res-src',
  ];
  for (const attr of lazyAttrs) {
    const val = img.getAttribute(attr);
    if (val && val.trim()) {
      candidates.push(val.trim());
    }
  }

  // 4. Fallback to standard src attribute
  const stdSrc = img.getAttribute('src');
  if (stdSrc && stdSrc.trim()) {
    candidates.push(stdSrc.trim());
  }

  // Pick the first candidate that resolves to a valid non-placeholder URL
  // Prefer http/https over tiny placeholder data:image/gif or data:image/svg if better candidates exist
  let fallbackDataUri: string | null = null;

  for (const candidate of candidates) {
    const resolved = resolveUrl(candidate, baseUrl);
    if (!resolved) continue;

    if (resolved.startsWith('data:image/')) {
      if (!fallbackDataUri) {
        fallbackDataUri = resolved;
      }
      continue;
    }

    return resolved;
  }

  return fallbackDataUri;
}
