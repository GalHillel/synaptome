import { tokensCss } from '@synaptome/ui-tokens';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="synaptome-token" content="__SYNAPTOME_TOKEN__">
<meta name="color-scheme" content="light dark">
<title>Synaptome Command Center</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%231f1d1a'/%3E%3Cpath d='M11 8a8 8 0 0 1 0 16' fill='none' stroke='%23e9e4d8' stroke-width='2.4' stroke-linecap='round'/%3E%3Cpath d='M21 8a8 8 0 0 0 0 16' fill='none' stroke='%23e9e4d8' stroke-width='2.4' stroke-linecap='round'/%3E%3Ccircle cx='16' cy='16' r='2' fill='%23c9925a'/%3E%3C/svg%3E">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<div id="root"><noscript>Synaptome Command Center needs JavaScript. The CLI and the terminal workbench work without it.</noscript></div>
<script type="module" src="/app.js"></script>
</body>
</html>`;

/**
 * The Command Center's assets. In a built distribution they were prebuilt by `scripts/build.ts` into `web/` beside the
 * bundle (this module is then part of `cli.mjs`, so `here` is the distribution folder). In the repository they are
 * bundled in memory by esbuild, which is imported only on that path; nothing is written to disk.
 */
export async function buildWebAssets(): Promise<{ html: string; js: string; css: string }> {
  const prebuilt = path.join(here, 'web');
  if (fs.existsSync(path.join(prebuilt, 'app.js'))) return { html: HTML, js: fs.readFileSync(path.join(prebuilt, 'app.js'), 'utf8'), css: fs.readFileSync(path.join(prebuilt, 'app.css'), 'utf8') };
  const { build } = await import('esbuild');
  const out = await build({
    entryPoints: [path.join(here, 'main.tsx')],
    bundle: true,
    write: false,
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    minify: !(process.env.SYNAPTOME_DEV ?? process.env.DRELQAVO_DEV),
    sourcemap: (process.env.SYNAPTOME_DEV ?? process.env.DRELQAVO_DEV) ? 'inline' : false,
    define: { 'process.env.NODE_ENV': JSON.stringify((process.env.SYNAPTOME_DEV ?? process.env.DRELQAVO_DEV) ? 'development' : 'production') },
    logLevel: 'silent',
  });
  return { html: HTML, js: out.outputFiles[0].text, css: `${tokensCss()}
${fs.readFileSync(path.join(here, 'styles.css'), 'utf8')}` };
}
