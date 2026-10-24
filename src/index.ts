#!/usr/bin/env node
import path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { ScraperOptionsSchema, type ScraperOptions, type ScraperResult } from './types.js';
import { fetchPage } from './pipeline/1-fetcher.js';
import { sanitizeAndExtract } from './pipeline/2-sanitizer.js';
import { localizeAssets } from './pipeline/3-asset-manager.js';
import { convertHtmlToMarkdown } from './pipeline/4-converter.js';
import { bundleAndWriteMarkdown } from './pipeline/5-bundler.js';
import { logger } from './utils/logger.js';

function createDefaultOutputDir(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const domainSlug = parsed.hostname
      .replace(/^www\./i, '')
      .replace(/[^a-zA-Z0-9.-]/g, '-')
      .toLowerCase();
    const timestamp = Math.floor(Date.now() / 1000);
    return path.resolve(process.cwd(), 'output', `${domainSlug}-${timestamp}`);
  } catch {
    return path.resolve(process.cwd(), 'output', `scrape-${Math.floor(Date.now() / 1000)}`);
  }
}

function printSummaryTable(result: ScraperResult): void {
  const seconds = (result.executionTimeMs / 1000).toFixed(2);
  const rows: Array<[string, string]> = [
    ['Article Title', result.title],
    ['Markdown File Path', result.markdownPath],
    ['Total Images Downloaded', String(result.imagesDownloaded)],
    ['Total Duplicates Skipped', String(result.duplicatesSkipped)],
    ['Execution Time', `${seconds}s (${result.executionTimeMs}ms)`],
  ];

  const keyWidth = Math.max(...rows.map(([k]) => k.length)) + 2;
  const valWidth = Math.max(...rows.map(([, v]) => Math.min(v.length, 72)), 24) + 2;
  const border = `+${'-'.repeat(keyWidth + 2)}+${'-'.repeat(valWidth + 2)}+`;

  console.log('\n' + chalk.bold.cyan('MarkScrape Summary'));
  console.log(chalk.gray(border));
  for (const [key, val] of rows) {
    const paddedKey = key.padEnd(keyWidth, ' ');
    const paddedVal = val.padEnd(valWidth, ' ');
    console.log(
      `${chalk.gray('|')} ${chalk.bold.white(paddedKey)} ${chalk.gray('|')} ${chalk.green(paddedVal)} ${chalk.gray('|')}`
    );
  }
  console.log(chalk.gray(border) + '\n');
}

export async function runMarkScrape(rawOptions: ScraperOptions): Promise<ScraperResult> {
  const options = ScraperOptionsSchema.parse(rawOptions);
  const startTime = Date.now();

  // Stage 1: Fetcher
  logger.startSpinner(`Stage 1/5: Launching Chromium & fetching ${options.url}...`);
  const fetched = await fetchPage(options);
  logger.succeedSpinner(
    `Stage 1/5: Fetched page (${fetched.imageCache.size} network images cached in memory)`
  );

  // Stage 2: Sanitizer & Readability Extraction
  logger.startSpinner('Stage 2/5: Normalizing DOM & extracting readable article content...');
  let article;
  try {
    article = sanitizeAndExtract(fetched.rawHtml, fetched.finalUrl);
    logger.succeedSpinner(`Stage 2/5: Extracted article "${article.title}"`);
  } catch (err) {
    await fetched.browser.close().catch(() => {});
    logger.failSpinner('Stage 2/5: Failed to sanitize and extract article');
    throw err;
  }

  // Stage 3: Asset Manager
  logger.startSpinner(
    `Stage 3/5: Downloading & deduplicating images (concurrency: ${options.concurrency})...`
  );
  const assetResult = await localizeAssets({
    contentHtml: article.contentHtml,
    finalUrl: fetched.finalUrl,
    outputDir: options.outputDir,
    concurrency: options.concurrency,
    imageCache: fetched.imageCache,
    page: fetched.page,
    browser: fetched.browser,
  });
  logger.succeedSpinner(
    `Stage 3/5: Localized assets (${assetResult.imagesDownloaded} downloaded, ${assetResult.duplicatesSkipped} duplicates skipped)`
  );

  // Stage 4: HTML to GFM Converter
  logger.startSpinner('Stage 4/5: Converting localized HTML to GitHub Flavored Markdown...');
  const markdownBody = convertHtmlToMarkdown(assetResult.localizedHtml);
  logger.succeedSpinner('Stage 4/5: Converted HTML to clean GFM Markdown');

  // Stage 5: Bundler
  logger.startSpinner('Stage 5/5: Injecting YAML frontmatter & writing index.md...');
  const markdownPath = await bundleAndWriteMarkdown({
    article,
    markdownBody,
    sourceUrl: fetched.finalUrl,
    outputDir: options.outputDir,
  });
  logger.succeedSpinner(`Stage 5/5: Wrote Markdown bundle to ${markdownPath}`);

  const executionTimeMs = Date.now() - startTime;
  return {
    markdownPath,
    outputDir: options.outputDir,
    title: article.title,
    sourceUrl: fetched.finalUrl,
    imagesDownloaded: assetResult.imagesDownloaded,
    duplicatesSkipped: assetResult.duplicatesSkipped,
    failedAssets: assetResult.failedAssets,
    executionTimeMs,
  };
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name('markscrape')
    .description('Production-grade HTML & Asset to GitHub Flavored Markdown Engine')
    .version('1.0.0')
    .argument('<url>', 'Target URL to scrape')
    .option('-o, --output <dir>', 'Output directory for index.md and ./assets/')
    .option('-c, --concurrency <number>', 'Max concurrent image downloads', '5')
    .option('--no-headless', 'Run browser in visible mode for debugging')
    .option('--timeout <ms>', 'Navigation timeout in ms', '30000')
    .action(
      async (
        url: string,
        cmdOptions: {
          output?: string;
          concurrency: string;
          headless: boolean;
          timeout: string;
        }
      ) => {
        try {
          const outputDir = cmdOptions.output
            ? path.resolve(process.cwd(), cmdOptions.output)
            : createDefaultOutputDir(url);

          const concurrency = Number.parseInt(cmdOptions.concurrency, 10);
          const timeout = Number.parseInt(cmdOptions.timeout, 10);

          const parsedOptions = ScraperOptionsSchema.parse({
            url,
            outputDir,
            concurrency: Number.isNaN(concurrency) ? 5 : concurrency,
            headless: Boolean(cmdOptions.headless),
            timeout: Number.isNaN(timeout) ? 30000 : timeout,
          });

          const result = await runMarkScrape(parsedOptions);
          printSummaryTable(result);
        } catch (err) {
          logger.failSpinner();
          logger.error('MarkScrape failed to complete', err);
          process.exitCode = 1;
        }
      }
    );

  await program.parseAsync(process.argv);
}

main();
