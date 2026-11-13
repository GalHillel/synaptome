import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildPublicTree, commitTree, writeTree } from '../../../scripts/public-tree';

// The public tree for a fresh public history (D-030): built from a commit through a temporary index, leaving out the
// private record, never touching this repository's history, index or working tree, and refusing on anything that
// should not become public.
const ROOT = path.resolve(__dirname, '..', '..', '..');
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

function fixture(files: Record<string, string | Buffer>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synaptome-pubtree-'));
  dirs.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'Fixture Author');
  git(dir, 'config', 'user.email', 'fixture-author@example.invalid');
  git(dir, 'config', 'core.autocrlf', 'false');
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'private history');
  return dir;
}

const CLEAN = {
  'README.md': '# Product\n\nSee [the guide](docs/GUIDE.md), [notes](docs/internal/NOTES.md), [provenance](docs/internal/PROVENANCE.md#code) and [site](https://example.com).\n\n```\n[not a link](docs/internal/x.md)\n```\n',
  'docs/GUIDE.md': 'Evidence: [run](../docs/evidence/run.txt) and the [evidence note](evidence/README.md).\n',
  'docs/internal/NOTES.md': 'private notes naming people\n',
  'docs/internal/PROVENANCE.md': 'private provenance\n',
  'docs/evidence/run.txt': 'transcript from the development machine\n',
  'docs/evidence/shot.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
  'packaging/public/docs/internal/PROVENANCE.md': '# Provenance\n\npublic version\n',
  'packaging/public/docs/evidence/README.md': '# Evidence\n\nkept privately\n',
  'site/assets/screen.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9]),
  'src/index.ts': 'export const x = 1;\n',
};

describe('public tree', () => {
  it('leaves out the private record, places the overlay and turns links into the private record into plain text', () => {
    const dir = fixture(CLEAN);
    const r = buildPublicTree(dir);
    expect(r.problems).toEqual([]);
    expect([...r.files.keys()].sort()).toEqual(['README.md', 'docs/GUIDE.md', 'docs/evidence/README.md', 'docs/internal/PROVENANCE.md', 'site/assets/screen.png', 'src/index.ts']);
    expect(r.files.get('docs/internal/PROVENANCE.md')!.content.toString()).toContain('public version');
    const readme = r.files.get('README.md')!.content.toString();
    expect(readme).toContain('See [the guide](docs/GUIDE.md), notes, [provenance](docs/internal/PROVENANCE.md#code) and [site](https://example.com).');
    expect(readme).toContain('[not a link](docs/internal/x.md)'); // code blocks are left alone
    expect(r.files.get('docs/GUIDE.md')!.content.toString()).toBe('Evidence: run and the [evidence note](evidence/README.md).\n');
    expect(r.relinked.map((x) => x.file).sort()).toEqual(['README.md', 'docs/GUIDE.md']);
  });

  it('changes nothing in the source repository and gives the same tree id every time', () => {
    const dir = fixture(CLEAN);
    const before = { head: git(dir, 'rev-parse', 'HEAD'), status: git(dir, 'status', '--porcelain'), index: fs.readFileSync(path.join(dir, '.git', 'index')), branches: git(dir, 'branch', '--list') };
    const out = path.join(dir, '..', `${path.basename(dir)}-out`);
    dirs.push(out);
    const t1 = writeTree(dir, buildPublicTree(dir), out);
    const t2 = writeTree(dir, buildPublicTree(dir));
    expect(t1).toBe(t2);
    expect({ head: git(dir, 'rev-parse', 'HEAD'), status: git(dir, 'status', '--porcelain'), index: fs.readFileSync(path.join(dir, '.git', 'index')), branches: git(dir, 'branch', '--list') }).toEqual(before);
    expect(fs.existsSync(path.join(out, 'docs', 'evidence', 'run.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(out, 'docs', 'evidence', 'README.md'), 'utf8')).toContain('kept privately');
    expect(() => writeTree(dir, buildPublicTree(dir), out)).toThrow(/not empty/);
  });

  it('refuses a broken link, a secret, the author identity, a forbidden string and a binary outside the asset folders', () => {
    const dir = fixture({
      ...CLEAN,
      'docs/BROKEN.md': 'See [missing](NOPE.md) and ![shot](evidence/shot.png).\n',
      'src/config.ts': `export const token = 'ghp_${'a'.repeat(36)}';\n`,
      'src/owner.ts': '// maintained by fixture-author@example.invalid\n',
      'src/place.ts': '// built on the Secret Workstation\n',
      'tools/blob.bin': Buffer.from([0, 1, 2]),
    });
    const r = buildPublicTree(dir, { forbid: ['secret workstation'] });
    expect(r.problems).toEqual(expect.arrayContaining([
      'broken link in docs/BROKEN.md: [missing](NOPE.md)',
      'broken link in docs/BROKEN.md: ![shot](evidence/shot.png)',
      'secret-like string in src/config.ts',
      expect.stringMatching(/^identifier of this machine or author in src\/owner\.ts/),
      expect.stringMatching(/^identifier of this machine or author in src\/place\.ts/),
      'binary file outside site/assets/, branding/: tools/blob.bin',
    ]));
    expect(r.problems.join('\n')).not.toContain('fixture-author@'); // the identifier itself is never printed
  });

  it('creates one parentless commit under the chosen identity on its own branch, and only on request to replace it', () => {
    const dir = fixture(CLEAN);
    const head = git(dir, 'rev-parse', 'HEAD');
    const tree = writeTree(dir, buildPublicTree(dir));
    expect(() => commitTree(dir, tree, 'no email here')).toThrow(/Name <email>/);
    const c = commitTree(dir, tree, 'Public Name <public@users.noreply.example>');
    expect(c.branch).toBe('public/main');
    expect(git(dir, 'rev-list', '--count', 'public/main')).toBe('1');
    expect(git(dir, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', 'public/main')).toBe('Public Name <public@users.noreply.example>|Public Name <public@users.noreply.example>');
    expect(git(dir, 'ls-tree', '-r', '--name-only', 'public/main').split('\n')).not.toContain('docs/evidence/run.txt');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(() => commitTree(dir, tree, 'Public Name <public@users.noreply.example>')).toThrow(/exists/);
    expect(commitTree(dir, tree, 'Public Name <public@users.noreply.example>', { replace: true }).commit).toBe(git(dir, 'rev-parse', 'public/main'));
  });

  it('adds the next public commit on top of the first, only with a message and only when the tree changed', () => {
    const dir = fixture(CLEAN);
    const who = 'Public Name <public@users.noreply.example>';
    const first = commitTree(dir, writeTree(dir, buildPublicTree(dir)), who);
    expect(() => commitTree(dir, writeTree(dir, buildPublicTree(dir)), who, { append: true, message: 'same' })).toThrow(/nothing to commit/);
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const x = 2;\n');
    git(dir, 'commit', '-q', '-am', 'private work');
    const tree = writeTree(dir, buildPublicTree(dir));
    expect(() => commitTree(dir, tree, who, { append: true })).toThrow(/--message/);
    expect(() => commitTree(dir, tree, who, { append: true, replace: true, message: 'x' })).toThrow(/cannot be combined/);
    const next = commitTree(dir, tree, who, { append: true, message: 'Fix x' });
    expect(next.parent).toBe(first.commit);
    expect(git(dir, 'rev-list', '--count', 'public/main')).toBe('2');
    expect(git(dir, 'log', '-1', '--format=%s', 'public/main')).toBe('Fix x');
    expect(() => commitTree(dir, tree, who, { append: true, branch: 'public/other', message: 'x' })).toThrow(/does not exist/);
  });

  // In the development repository only: the committed tree passes every check. (A public clone has no overlay
  // source, so there is nothing to build there.)
  it.skipIf(!fs.existsSync(path.join(ROOT, '.git')) || spawnSync('git', ['cat-file', '-e', 'HEAD:packaging/public'], { cwd: ROOT }).status !== 0)('this repository: the public tree built from HEAD has no problems', () => {
    const r = buildPublicTree(ROOT);
    expect(r.problems).toEqual([]);
    expect([...r.files.keys()].filter((p) => p.startsWith('docs/internal/') || p.startsWith('docs/evidence/')).sort()).toEqual(['docs/evidence/README.md', 'docs/internal/PROVENANCE.md']);
    expect([...r.files.keys()].some((p) => p.startsWith('packaging/public/'))).toBe(false);
  });
});
