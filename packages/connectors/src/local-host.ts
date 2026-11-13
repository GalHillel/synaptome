import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type CandidateDraft, type DiscoveryConnector, type FetchedFile, parseFrontmatter, tokenize } from '@synaptome/core';
import { BINARY_EXT } from './github-api';

const MAX_FILES = 60;
const MAX_BYTES = 256 * 1024;

export interface LocalSkill {
  dir: string;
  origin: string;
}

/** Read-only inventory of skills already present for Claude Code on this machine. Nothing is modified. */
export function findLocalClaudeSkills(claudeRoot = path.join(os.homedir(), '.claude')): LocalSkill[] {
  const out: LocalSkill[] = [];
  const skillsDir = path.join(claudeRoot, 'skills');
  const collect = (root: string, origin: string) => {
    if (!fs.existsSync(root)) return;
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory() || e.isSymbolicLink()) {
        const dir = path.join(root, e.name);
        if (fs.existsSync(path.join(dir, 'SKILL.md'))) out.push({ dir, origin });
      }
    }
  };
  collect(skillsDir, 'personal');
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(claudeRoot, 'plugins', 'installed_plugins.json'), 'utf8'));
    for (const [name, entries] of Object.entries<any>(installed.plugins ?? {})) {
      for (const ent of Array.isArray(entries) ? entries : []) if (ent?.installPath) collect(path.join(ent.installPath, 'skills'), `plugin:${name}`);
    }
  } catch {
    /* no plugins manifest */
  }
  return out;
}

export function readDirPackage(dir: string): { files: FetchedFile[]; skipped: { path: string; reason: string }[] } {
  const files: FetchedFile[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const rel = path.relative(dir, full).replace(/\\/g, '/');
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        walk(full);
      } else if (e.isFile()) {
        if (files.length >= MAX_FILES) skipped.push({ path: rel, reason: `file limit (${MAX_FILES}) reached` });
        else if (BINARY_EXT.test(rel)) skipped.push({ path: rel, reason: 'binary file not read' });
        else if (fs.statSync(full).size > MAX_BYTES) skipped.push({ path: rel, reason: `larger than ${MAX_BYTES} bytes` });
        else {
          const content = fs.readFileSync(full, 'utf8');
          if (content.includes('\u0000')) skipped.push({ path: rel, reason: 'binary content' });
          else files.push({ path: rel, content, size: Buffer.byteLength(content) });
        }
      }
    }
  };
  walk(dir);
  return { files, skipped };
}

export function createLocalClaudeConnector(opts: { claudeRoot?: string } = {}): DiscoveryConnector {
  const root = opts.claudeRoot ?? path.join(os.homedir(), '.claude');
  return {
    id: 'local-claude',
    kind: 'host-inventory',
    title: 'Local Claude Code inventory',
    description: `Read-only index of skills already installed under ${root} (personal skills and enabled plugins).`,
    official: false,
    async health() {
      const ok = fs.existsSync(root);
      return { ok, authenticated: true, detail: ok ? `${findLocalClaudeSkills(root).length} skills found under ${root}` : `${root} does not exist` };
    },
    async search(req) {
      const q = req.query ? tokenize(req.query) : [];
      const drafts: CandidateDraft[] = [];
      for (const s of findLocalClaudeSkills(root)) {
        let fm: Record<string, any> = {};
        try {
          fm = parseFrontmatter(fs.readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8')).data;
        } catch {
          continue;
        }
        const name = typeof fm.name === 'string' && fm.name ? fm.name : path.basename(s.dir);
        const description = typeof fm.description === 'string' ? fm.description : '';
        if (q.length && !q.some((t) => `${name} ${description}`.toLowerCase().includes(t))) continue;
        const st = fs.statSync(path.join(s.dir, 'SKILL.md'));
        drafts.push({
          externalId: s.dir,
          kind: 'skill',
          name,
          description,
          url: s.dir,
          path: s.dir,
          publisher: s.origin.startsWith('plugin:') ? s.origin.slice(7).split('@')[0] : 'local',
          pushedAt: st.mtime.toISOString(),
          upstreamVersion: `${st.size}-${Math.round(st.mtimeMs)}`,
          topics: [s.origin.startsWith('plugin:') ? 'plugin-skill' : 'personal-skill'],
          signals: { origin: s.origin },
          raw: { origin: s.origin },
        });
      }
      return { drafts: req.mode === 'need' ? drafts.slice(0, req.limit) : drafts, notes: [`inventory is read-only; ${drafts.length} skills indexed`] };
    },
    async fetchPackage(c) {
      const { files, skipped } = readDirPackage(c.externalId);
      return { files, skipped, provenance: { url: c.externalId, method: 'local-filesystem read (pre-existing host install, origin not verifiable)', verified: false } };
    },
  };
}
