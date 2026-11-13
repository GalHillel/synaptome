/**
 * Landing page build (Phase 12 S3): `site/src` + the product tokens + the mark + screenshots → `site/dist/`, a static
 * folder any host can serve. The repository address is filled in from SYNAPTOME_REPO_URL (none is public yet).
 *
 *   npx tsx scripts/site.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokensCss } from '@synaptome/ui-tokens';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'site', 'src');
const out = path.join(root, 'site', 'dist');
const repo = process.env.SYNAPTOME_REPO_URL ?? '#';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'assets', 'screens'), { recursive: true });
const html = fs.readFileSync(path.join(src, 'index.html'), 'utf8').replace('{{TOKENS}}', tokensCss()).replaceAll('{{REPO}}', repo);
if (/\{\{\w+\}\}/.test(html)) throw new Error('unfilled placeholder in index.html');
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.copyFileSync(path.join(src, 'site.css'), path.join(out, 'site.css'));
fs.copyFileSync(path.join(root, 'branding', 'mark.svg'), path.join(out, 'assets', 'mark.svg'));
for (const f of fs.readdirSync(path.join(root, 'site', 'assets', 'screens'))) fs.copyFileSync(path.join(root, 'site', 'assets', 'screens', f), path.join(out, 'assets', 'screens', f));
process.stdout.write(`site built in ${out}\n`);
