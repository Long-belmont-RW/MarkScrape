import { z } from 'zod';
import type { Browser, Page } from 'playwright';

export const ScraperOptionsSchema = z.object({
  url: z.string().url('Invalid target URL provided'),
  outputDir: z.string().min(1, 'Output directory must not be empty'),
  concurrency: z.number().int().positive().default(5),
  headless: z.boolean().default(true),
  timeout: z.number().int().positive().default(30000),
});

export type ScraperOptions = z.infer<typeof ScraperOptionsSchema>;

export interface CachedImage {
  buffer: Buffer;
  contentType: string;
}

export type ImageCache = Map<string, CachedImage>;

export interface FetchedPageData {
  rawHtml: string;
  finalUrl: string;
  imageCache: ImageCache;
  page: Page;
  browser: Browser;
}

export interface ExtractedArticle {
  title: string;
  byline: string | null;
  siteName: string | null;
  excerpt: string | null;
  contentHtml: string;
}

export interface AssetLocalizationResult {
  localizedHtml: string;
  imagesDownloaded: number;
  duplicatesSkipped: number;
  failedAssets: number;
}

export interface ScraperResult {
  markdownPath: string;
  outputDir: string;
  title: string;
  sourceUrl: string;
  imagesDownloaded: number;
  duplicatesSkipped: number;
  failedAssets: number;
  executionTimeMs: number;
}

export type FileSystemPermissionMode = 'read' | 'readwrite';

export interface FileSystemHandlePermissionDescriptor {
  mode?: FileSystemPermissionMode;
}

export type WellKnownDirectory =
  | 'desktop'
  | 'documents'
  | 'downloads'
  | 'music'
  | 'pictures'
  | 'videos';

export interface DirectoryPickerOptions {
  id?: string;
  mode?: FileSystemPermissionMode;
  startIn?: FileSystemHandle | WellKnownDirectory;
}

declare global {
  interface FileSystemHandle {
    queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
    requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  }

  interface FileSystemDirectoryHandle {
    queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
    requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
    values(): AsyncIterableIterator<FileSystemHandle>;
    keys(): AsyncIterableIterator<string>;
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  }

  interface Window {
    showDirectoryPicker(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
  }
}

