/**
 * Production build (Phase 10 S1): one JavaScript file for the CLI, TUI, MCP server and dashboard server; the Web
 * Command Center prebuilt; a launcher that checks the Node.js version before loading anything. Nothing in the output
 * needs TypeScript, tsx or esbuild at run time.
 *
 *   npx tsx scripts/build.ts [outDir]      (default: dist/)
 *
 * Output:
 *   synaptome.mjs   launcher (Node version check, warning filter, then cli.mjs)
 *   cli.mjs         every workspace package and dependency in one ES module
 *   web/            assets for the dashboard: app.js, app.css
 *   build-info.json version, commit, time, sizes, and the npm packages that were bundled (for the licence audit)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Plugin, build } from 'esbuild';
import { PRODUCT } from '@synaptome/core';
import { tokensCss } from '@synaptome/ui-tokens';
import { writeThirdPartyLicenses } from './licenses';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(root, 'dist'));
const t0 = performance.now();

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'web'), { recursive: true });

// Ink imports React DevTools support statically; it is only used when DEV=true and is not shipped.
const noDevtools: Plugin = {
  name: 'no-react-devtools',
  setup(b) {
    b.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'react-devtools-core', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default { initialize() {}, connectToDevTools() {} };' }));
  },
};

const cli = await build({
  entryPoints: [path.join(root, 'apps/cli/src/main.ts')],
  outfile: path.join(out, 'cli.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node24',
  tsconfig: path.join(root, 'tsconfig.json'),
  define: { 'process.env.NODE_ENV': '"production"' },
  // Some bundled dependencies still call require(); give the ES module one.
  banner: { js: "import { createRequire as __synaptomeRequire } from 'node:module'; const require = __synaptomeRequire(import.meta.url);" },
  // esbuild is only imported by the development path of the dashboard (when web/ is absent); it is not shipped.
  external: ['esbuild'],
  plugins: [noDevtools],
  legalComments: 'eof',
  metafile: true,
  logLevel: 'warning',
});

const web = await build({
  entryPoints: [path.join(root, 'apps/command-center/src/main.tsx')],
  outfile: path.join(out, 'web', 'app.js'),
  bundle: true, format: 'esm', target: 'es2022', jsx: 'automatic', minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'eof',
  metafile: true,
  logLevel: 'warning',
});
fs.writeFileSync(path.join(out, 'web', 'app.css'), `${tokensCss()}\n${fs.readFileSync(path.join(root, 'apps/command-center/src/styles.css'), 'utf8')}`);

fs.writeFileSync(
  path.join(out, `${PRODUCT.bin}.mjs`),
  `#!/usr/bin/env node
// ${PRODUCT.name} launcher. Checks the Node.js version first: the product needs node:sqlite (Node 24 or later).
const major = Number(process.versions.node.split('.')[0]);
if (major < 24) {
  process.stderr.write('${PRODUCT.name} needs Node.js 24 or later; this is ' + process.version + '.\\n  hint: install the current LTS from https://nodejs.org and run the command again\\n');
  process.exit(1);
}
// node:sqlite prints an experimental-feature notice that would corrupt the terminal workbench and --json output.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const type = typeof warning === 'string' ? (typeof rest[0] === 'string' ? rest[0] : rest[0]?.type) : warning?.name;
  if (type === 'ExperimentalWarning') return;
  return emitWarning.call(process, warning, ...rest);
};
const { fileURLToPath } = await import('node:url');
process.env.${PRODUCT.envPrefix}_LAUNCHER ??= fileURLToPath(import.meta.url);
const { main } = await import('./cli.mjs');
await main(process.argv);
`,
);

// The published package: one package with no dependencies (everything is in cli.mjs). Licence per D-002.
const repoPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.writeFileSync(
  path.join(out, 'package.json'),
  JSON.stringify({
    name: PRODUCT.bin, version: PRODUCT.version, description: repoPkg.description, type: 'module', license: 'Apache-2.0',
    repository: repoPkg.repository, homepage: repoPkg.homepage, bugs: repoPkg.bugs,
    engines: { node: '>=24' }, bin: { [PRODUCT.bin]: `${PRODUCT.bin}.mjs` },
    files: [`${PRODUCT.bin}.mjs`, 'cli.mjs', 'web/', 'build-info.json', 'README.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_LICENSES.md'],
  }, null, 2) + '\n',
);
fs.copyFileSync(path.join(root, 'packaging', 'README.md'), path.join(out, 'README.md'));
for (const f of ['LICENSE', 'NOTICE']) fs.copyFileSync(path.join(root, f), path.join(out, f));

// What went into cli.mjs: npm packages (by name) and their bytes, for the licence audit and the pack test.
const bundled = (meta: { inputs: Record<string, { bytes: number }> }) => {
  const m = new Map<string, number>();
  for (const [file, info] of Object.entries(meta.inputs)) {
    const p = file.replace(/\\/g, '/').match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
    if (p) m.set(p[1], (m.get(p[1]) ?? 0) + info.bytes);
  }
  return m;
};
const packages = bundled(cli.metafile!);
const webPackages = bundled(web.metafile!);
let commit: string | null = null;
try {
  commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
} catch {
  /* not a git checkout */
}
const size = (f: string) => fs.statSync(path.join(out, f)).size;
const info = {
  name: PRODUCT.name, version: PRODUCT.version, commit, builtAt: new Date().toISOString(), node: '>=24',
  files: Object.fromEntries(['cli.mjs', `${PRODUCT.bin}.mjs`, 'web/app.js', 'web/app.css'].map((f) => [f, size(f)])),
  bundledPackages: Object.fromEntries([...packages].sort((a, b) => a[0].localeCompare(b[0]))),
  webBundledPackages: Object.fromEntries([...webPackages].sort((a, b) => a[0].localeCompare(b[0]))),
};
fs.writeFileSync(path.join(out, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
// Every bundled package's licence, with its text; the build fails on a licence outside the allow list (D-002).
const licences = writeThirdPartyLicenses(out, path.join(out, 'THIRD_PARTY_LICENSES.md'));
// The repository keeps a copy for readers of the source; builds into other folders (tests) leave it alone.
if (out === path.join(root, 'dist')) fs.copyFileSync(path.join(out, 'THIRD_PARTY_LICENSES.md'), path.join(root, 'THIRD_PARTY_LICENSES.md'));
process.stdout.write(`built ${out} in ${Math.round(performance.now() - t0)} ms: cli.mjs ${(info.files['cli.mjs'] / 1e6).toFixed(2)} MB, web ${((info.files['web/app.js'] + info.files['web/app.css']) / 1e3).toFixed(0)} kB, ${packages.size} npm packages bundled; licences ${JSON.stringify(licences.counts)}\n`);
