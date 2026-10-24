import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { build as esbuild } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, 'dist-extension');
const extSrcDir = path.resolve(__dirname, 'src/extension');

/**
 * Vite plugin that bundles content-script.ts (as a self-contained IIFE with zero module imports)
 * and background.ts (as a standalone MV3 service worker module), and copies manifest.json + popup.html
 * into ./dist-extension.
 */
function chromeExtensionBuilderPlugin(): Plugin {
  return {
    name: 'markscrape-chrome-extension-builder',
     async closeBundle() {
      await fs.mkdir(outDir, { recursive: true });

      // Bundle content-script.ts as a standalone IIFE (Chrome content scripts cannot use top-level import statements)
      await esbuild({
        entryPoints: [path.resolve(extSrcDir, 'content-script.ts')],
        outfile: path.resolve(outDir, 'content-script.js'),
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: ['chrome114'],
        minify: false,
        sourcemap: false,
        legalComments: 'none',
      });

      // Bundle background.ts as a standalone ESM service worker
      await esbuild({
        entryPoints: [path.resolve(extSrcDir, 'background.ts')],
        outfile: path.resolve(outDir, 'background.js'),
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: ['chrome114'],
        minify: false,
        sourcemap: false,
        legalComments: 'none',
      });

      // Bundle editor.ts as a standalone ESM module for the dedicated Preview & Edit tab
      await esbuild({
        entryPoints: [path.resolve(extSrcDir, 'editor.ts')],
        outfile: path.resolve(outDir, 'editor.js'),
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: ['chrome114'],
        minify: false,
        sourcemap: false,
        legalComments: 'none',
      });

      // Copy manifest.json, popup.html, and editor.html to dist-extension
      await fs.copyFile(
        path.resolve(extSrcDir, 'manifest.json'),
        path.resolve(outDir, 'manifest.json')
      );
      await fs.copyFile(
        path.resolve(extSrcDir, 'popup.html'),
        path.resolve(outDir, 'popup.html')
      );
      await fs.copyFile(
        path.resolve(extSrcDir, 'editor.html'),
        path.resolve(outDir, 'editor.html')
      );
    },
  };
}

export default defineConfig({
  publicDir: false,
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    target: 'chrome114',
    rollupOptions: {
      input: path.resolve(extSrcDir, 'popup.ts'),
      output: {
        format: 'es',
        entryFileNames: 'popup.js',
      },
    },
  },
  plugins: [chromeExtensionBuilderPlugin()],
});
