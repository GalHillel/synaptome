/**
 * Public tree for a fresh public history (option C of `docs/RELEASE_AUDIT.md`, decision D-030).
 *
 * Builds, from a committed revision only (never the working tree), the exact tree the public repository starts from:
 *   - drops the private record: `docs/internal/`, `docs/evidence/` (raw evidence describing the development machine,
 *     milestone notes, the upstream tracker) and the overlay source `packaging/public/` itself;
 *   - adds the overlay: every file under `packaging/public/<path>` is placed at `<path>` (a public provenance note and
 *     a note on where the evidence is);
 *   - rewrites Markdown links that pointed into the dropped paths to their plain text;
 *   - checks the result and refuses on any problem: a relative Markdown link that does not resolve, a secret-like
 *     string, an identifier of this machine or of the Git author (computed here at run time, never written into the
 *     tree), or a binary file outside the allowed asset folders.
 *
 * Nothing in this repository's history, index or working tree is changed. The work happens in a temporary index.
 *
 *   npx tsx scripts/public-tree.ts                                   check, print the report and the tree id
 *   npx tsx scripts/public-tree.ts --out .tmp/public-tree            also write the files there (to run CI on them)
 *   npx tsx scripts/public-tree.ts --commit --author "Name <email>"  also create one parentless commit on
 *                                                                    branch public/main (--branch to change it)
 *   npx tsx scripts/public-tree.ts --commit --append --message "…" --author "Name <email>"
 *                                                                    the next public commit, on top of public/main
 *   --rev <rev> (default HEAD) · --forbid <text> (repeatable; more strings that must not appear)
 *   --replace (a new first commit instead; only before anything was pushed)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PRIVATE_PATHS = ['docs/internal/', 'docs/evidence/', 'packaging/public/'];
export const OVERLAY = 'packaging/public/';
export const BINARY_DIRS = ['site/assets/', 'branding/'];
export const SECRET = /(ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-ant-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[abp]-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{36})/;

export interface Entry { mode: string; sha: string; content: Buffer }
export interface PublicTreeResult {
  rev: string;
  files: Map<string, Entry>;
  removed: string[];
  overlaid: string[];
  relinked: { file: string; links: string[] }[];
  problems: string[];
}

function git(root: string, args: string[], opts: { input?: string | Buffer; env?: NodeJS.ProcessEnv } = {}) {
  const r = spawnSync('git', args, { cwd: root, input: opts.input, env: { ...process.env, ...opts.env }, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr?.toString().trim()}`);
  return r.stdout as Buffer;
}

/** Every blob of `rev` with its content, read in one `git cat-file --batch` call. */
function readTree(root: string, rev: string): Map<string, Entry> {
  const rows = git(root, ['ls-tree', '-r', '-z', rev]).toString('utf8').split('\0').filter(Boolean).map((l) => {
    const tab = l.indexOf('\t');
    const [mode, type, sha] = l.slice(0, tab).split(' ');
    return { mode, type, sha, path: l.slice(tab + 1) };
  }).filter((r) => r.type === 'blob');
  const out = git(root, ['cat-file', '--batch'], { input: rows.map((r) => r.sha).join('\n') + '\n' });
  const files = new Map<string, Entry>();
  let at = 0;
  for (const r of rows) {
    const nl = out.indexOf(0x0a, at);
    const size = Number(out.subarray(at, nl).toString().split(' ')[2]);
    files.set(r.path, { mode: r.mode, sha: r.sha, content: out.subarray(nl + 1, nl + 1 + size) });
    at = nl + 1 + size + 1;
  }
  return files;
}

const isPrivate = (p: string) => PRIVATE_PATHS.some((d) => p.startsWith(d));
const isBinary = (b: Buffer) => b.subarray(0, 8000).includes(0);
const LINK = /(!?)\[([^\]\n]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g;

/** Relative Markdown links outside fenced code blocks; `cb` may return a replacement for the whole link. */
function mapLinks(text: string, cb: (m: { image: boolean; label: string; target: string; whole: string }) => string | undefined) {
  let fenced = false;
  return text.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return line;
    }
    if (fenced) return line;
    return line.replace(LINK, (whole, bang, label, target) => {
      if (/^([a-z][a-z0-9+.-]*:|#|\{\{)/i.test(target)) return whole;
      return cb({ image: bang === '!', label, target, whole }) ?? whole;
    });
  }).join('\n');
}

function resolveLink(file: string, target: string) {
  const bare = decodeURI(target.split('#')[0].split('?')[0]);
  if (!bare) return null;
  const joined = bare.startsWith('/') ? bare.slice(1) : path.posix.join(path.posix.dirname(file), bare);
  return path.posix.normalize(joined).replace(/\/$/, '');
}

/** Strings that identify this machine or the Git author and so must not appear in a public file. */
export function personalIdentifiers(root: string, extra: string[] = []) {
  const out = new Set<string>(extra.filter((s) => s && s.trim().length >= 3));
  const home = os.homedir();
  const user = os.userInfo().username;
  for (const s of [home, home.replace(/\\/g, '/'), root, root.replace(/\\/g, '/')]) if (s.length > 3) out.add(s);
  if (user.length >= 3) for (const p of [`\\Users\\${user}`, `/Users/${user}`, `/home/${user}`]) out.add(p);
  for (const key of ['user.name', 'user.email']) {
    const r = spawnSync('git', ['config', '--get', key], { cwd: root });
    const v = r.status === 0 ? r.stdout.toString().trim() : '';
    if (v.length >= 3) out.add(v);
  }
  return [...out];
}

export function buildPublicTree(root: string, opts: { rev?: string; forbid?: string[] } = {}): PublicTreeResult {
  const rev = git(root, ['rev-parse', '--verify', `${opts.rev ?? 'HEAD'}^{commit}`]).toString().trim();
  const source = readTree(root, rev);
  const files = new Map<string, Entry>();
  const removed: string[] = [];
  const overlaid: string[] = [];
  for (const [p, e] of source) {
    if (isPrivate(p)) removed.push(p);
    else files.set(p, e);
  }
  for (const [p, e] of source) {
    if (!p.startsWith(OVERLAY)) continue;
    const dest = p.slice(OVERLAY.length);
    files.set(dest, e);
    overlaid.push(dest);
  }
  const exists = (p: string) => files.has(p) || [...files.keys()].some((k) => k.startsWith(`${p}/`));
  const existedPrivately = (p: string) => [...source.keys()].some((k) => isPrivate(k) && (k === p || k.startsWith(`${p}/`)));
  const problems: string[] = [];
  const relinked: PublicTreeResult['relinked'] = [];

  // Links: those into the private record become plain text; every other relative link must resolve.
  for (const [p, e] of files) {
    if (!p.endsWith('.md')) continue;
    const links: string[] = [];
    const next = mapLinks(e.content.toString('utf8'), ({ image, label, target, whole }) => {
      const to = resolveLink(p, target);
      if (to == null || exists(to)) return undefined;
      if (!image && existedPrivately(to)) {
        links.push(target);
        return label;
      }
      problems.push(`broken link in ${p}: ${whole}`);
      return undefined;
    });
    if (links.length) {
      const content = Buffer.from(next, 'utf8');
      files.set(p, { mode: e.mode, sha: git(root, ['hash-object', '-w', '--stdin'], { input: content }).toString().trim(), content });
      relinked.push({ file: p, links });
    }
  }

  // Content: no private path, no secret, no identifier of this machine or author, binaries only where assets live.
  const ids = personalIdentifiers(root, opts.forbid);
  for (const [p, e] of files) {
    if (isPrivate(p) && !overlaid.includes(p)) problems.push(`private path present: ${p}`);
    if (isBinary(e.content)) {
      if (!BINARY_DIRS.some((d) => p.startsWith(d))) problems.push(`binary file outside ${BINARY_DIRS.join(', ')}: ${p}`);
      continue;
    }
    const text = e.content.toString('utf8');
    const lower = text.toLowerCase();
    if (SECRET.test(text)) problems.push(`secret-like string in ${p}`);
    for (const id of ids) if (lower.includes(id.toLowerCase())) problems.push(`identifier of this machine or author in ${p} (${id.length} characters, not shown)`);
  }
  return { rev, files, removed, overlaid, relinked, problems };
}

/** Writes the tree through a temporary index and returns the tree id; nothing else in the repository is touched. */
export function writeTree(root: string, result: PublicTreeResult, out?: string) {
  const index = path.join(os.tmpdir(), `synaptome-public-${process.pid}-${Date.now()}.idx`);
  const env = { GIT_INDEX_FILE: index };
  try {
    const info = [...result.files].map(([p, e]) => `${e.mode} ${e.sha}\t${p}`).join('\n') + '\n';
    git(root, ['update-index', '--add', '--index-info'], { input: info, env });
    const tree = git(root, ['write-tree'], { env }).toString().trim();
    if (out) {
      if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`${out} is not empty`);
      fs.mkdirSync(out, { recursive: true });
      git(root, ['checkout-index', '-a', '-f', `--prefix=${path.resolve(out)}${path.sep}`], { env });
    }
    return tree;
  } finally {
    fs.rmSync(index, { force: true });
  }
}

/**
 * A commit of `tree` on `branch`, under the identity the owner chose. Never pushes.
 * - default: the first public commit, without a parent; refuses when the branch exists.
 * - `replace`: a new parentless commit in place of the branch (only before anything was pushed).
 * - `append`: the next public commit, on top of the branch (what is pushed later is a fast-forward).
 */
export function commitTree(root: string, tree: string, author: string, opts: { branch?: string; replace?: boolean; append?: boolean; message?: string } = {}) {
  const m = /^\s*([^<>]+?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(author);
  if (!m) throw new Error('--author must look like "Name <email>"');
  if (opts.replace && opts.append) throw new Error('--replace and --append cannot be combined');
  const branch = opts.branch ?? 'public/main';
  const ref = `refs/heads/${branch}`;
  const current = spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: root });
  const exists = current.status === 0;
  if (exists && !opts.replace && !opts.append) throw new Error(`branch ${branch} exists; pass --append for the next public commit (or --replace before anything was pushed)`);
  if (opts.append && !exists) throw new Error(`branch ${branch} does not exist; the first public commit is made without --append`);
  const parent = opts.append ? current.stdout.toString().trim() : null;
  if (parent && git(root, ['rev-parse', `${parent}^{tree}`]).toString().trim() === tree) throw new Error(`nothing to commit: ${branch} already has this tree`);
  if (opts.append && !opts.message) throw new Error('--append needs --message (what changed, for the public history)');
  const env = { GIT_AUTHOR_NAME: m[1], GIT_AUTHOR_EMAIL: m[2], GIT_COMMITTER_NAME: m[1], GIT_COMMITTER_EMAIL: m[2] };
  const message = opts.message ?? 'Synaptome 0.2.0\n\nFirst public commit. Development before 0.2.0 is kept in a private repository; see\ndocs/internal/PROVENANCE.md.\n';
  const commit = git(root, ['commit-tree', tree, ...(parent ? ['-p', parent] : [])], { input: message.endsWith('\n') ? message : `${message}\n`, env }).toString().trim();
  git(root, ['update-ref', ref, commit]);
  return { branch, commit, parent };
}

function main(argv: string[]) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const val = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const forbid = argv.flatMap((a, i) => (a === '--forbid' ? [argv[i + 1]] : []));
  const r = buildPublicTree(root, { rev: val('--rev'), forbid });
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: root }).stdout.toString().trim();
  const say = (s: string) => process.stdout.write(`${s}\n`);
  say(`source commit   ${r.rev}${dirty ? '   (uncommitted changes in the working tree are not included)' : ''}`);
  say(`public files    ${r.files.size}`);
  say(`left out        ${r.removed.length} (${PRIVATE_PATHS.join(', ')})`);
  say(`overlay         ${r.overlaid.join(', ') || 'none'}`);
  say(`links rewritten ${r.relinked.map((x) => `${x.file} (${x.links.length})`).join(', ') || 'none'}`);
  if (r.problems.length) {
    say(`\n${r.problems.length} problem(s); nothing written:`);
    for (const p of r.problems) say(`  - ${p}`);
    process.exitCode = 1;
    return;
  }
  const out = val('--out');
  const tree = writeTree(root, r, out);
  say('checks          pass (links, secrets, identifiers of this machine and author, binary files)');
  say(`tree            ${tree}`);
  if (out) say(`written to      ${path.resolve(out)}`);
  if (argv.includes('--commit')) {
    const author = val('--author');
    if (!author) throw new Error('--commit needs --author "Name <email>" (the public identity; nothing is assumed)');
    const c = commitTree(root, tree, author, { branch: val('--branch'), replace: argv.includes('--replace'), append: argv.includes('--append'), message: val('--message') });
    say(`commit          ${c.commit} on ${c.branch} (${c.parent ? `parent ${c.parent.slice(0, 7)}` : 'no parent'}; nothing pushed)`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2));
