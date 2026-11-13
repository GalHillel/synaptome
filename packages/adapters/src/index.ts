import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type CapabilityRecord, type FetchedFile, type HostAdapter, type HostDetection, type TargetOps, LEGACY, PRODUCT, hashFiles, parseFrontmatter, readTree, safeRel, slug } from '@synaptome/core';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
/** JSON with object keys sorted, so equal values compare equal whatever their key order. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canon((v as any)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** Marker written into every directory Synaptome creates in a host. Removal refuses to touch a directory without it. */
export const MARKER = PRODUCT.markerFile;
/** A directory installed under the previous product name is still recognised as ours, so it can be verified and removed. */
export function markerPath(target: string): string | null {
  for (const name of [PRODUCT.markerFile, LEGACY.markerFile]) if (fs.existsSync(path.join(target, name))) return path.join(target, name);
  return null;
}

export class AdapterRegistry {
  private map = new Map<string, HostAdapter>();
  register(a: HostAdapter): this {
    this.map.set(a.id, a);
    return this;
  }
  get(id: string): HostAdapter {
    const a = this.map.get(id);
    if (!a) throw new Error(`Unknown host "${id}". Known: ${[...this.map.keys()].join(', ')}`);
    return a;
  }
  list(): HostAdapter[] {
    return [...this.map.values()];
  }
}

function detectBinary(bin: string, home: string): HostDetection {
  const where = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
  const present = where.status === 0;
  return { present: present || fs.existsSync(home), detail: present ? `${bin} found at ${where.stdout.split(/\r?\n/)[0].trim()}` : fs.existsSync(home) ? `${home} exists but ${bin} is not on PATH` : `${bin} not installed`, root: home };
}

/** Skill directory name rules shared by hosts that follow the Agent Skills layout. */
export function skillDirName(cap: { name: string; id: string }): string {
  return slug(cap.name).slice(0, 64) || slug(cap.id).slice(0, 64);
}

/* =====================================================================
 * Directory targets (skills): <root>/skills/<name>/ with a marker file inside.
 * ===================================================================== */

/** Fingerprint of a directory: every file's relative path and bytes (marker included). Null when it does not exist. */
export function treeDigest(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  if (fs.statSync(dir).isFile()) return sha(`\0file\0${sha(fs.readFileSync(dir))}`);
  const parts: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = path.join(d, e.name);
      const rel = path.relative(dir, full).replace(/\\/g, '/');
      if (e.isSymbolicLink()) parts.push(`${rel}\0link:${fs.readlinkSync(full)}`);
      else if (e.isDirectory()) walk(full);
      else parts.push(`${rel}\0${sha(fs.readFileSync(full))}`);
    }
  };
  walk(dir);
  return sha(parts.join('\n'));
}

const readJsonFile = (file: string): any => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

export const dirOps: TargetOps = {
  exists: (t) => fs.existsSync(t),
  owner(t) {
    const mp = markerPath(t);
    return (mp && readJsonFile(mp)?.capabilityId) || null;
  },
  fingerprint: (t) => treeDigest(t),
  payloadHash(t) {
    if (!fs.existsSync(t)) return null;
    const mp = path.basename(markerPath(t) ?? '');
    return hashFiles(readTree(t).filter((f) => f.path !== mp));
  },
  backup(t, dir) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.cpSync(t, dir, { recursive: true });
  },
  restore(dir, t) {
    fs.rmSync(t, { recursive: true, force: true });
    fs.cpSync(dir, t, { recursive: true });
  },
  discard: (t) => fs.rmSync(t, { recursive: true, force: true }),
};

function writeSkillDir(cap: CapabilityRecord, files: FetchedFile[], target: string, host: string) {
  if (fs.existsSync(target)) throw new Error(`Refusing to write into existing directory: ${target}`);
  fs.mkdirSync(target, { recursive: true });
  for (const f of files) {
    const dest = path.join(target, safeRel(f.path));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.content, 'utf8');
  }
  fs.writeFileSync(path.join(target, MARKER), JSON.stringify({ managedBy: PRODUCT.managedBy, host, capabilityId: cap.id, contentHash: hashFiles(files), source: cap.provenance.url, commit: cap.commit, licence: cap.license.spdx, installedAt: new Date().toISOString() }, null, 2));
}

function verifySkillDir(cap: CapabilityRecord, target: string, expectedHash?: string): { ok: boolean; detail: string } {
  const entry = path.join(target, 'SKILL.md');
  if (!fs.existsSync(entry)) return { ok: false, detail: 'SKILL.md missing after install' };
  const fm = parseFrontmatter(fs.readFileSync(entry, 'utf8')).data;
  if (typeof fm.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(fm.name)) return { ok: false, detail: `front-matter name "${fm.name}" is not a valid skill name (lowercase letters, digits, hyphens; max 64)` };
  if (typeof fm.description !== 'string' || !fm.description.trim()) return { ok: false, detail: 'front-matter description missing' };
  if (fm.description.length > 1024) return { ok: false, detail: `description is ${fm.description.length} characters (limit 1024)` };
  const mp = markerPath(target);
  if (!mp) return { ok: false, detail: 'management marker missing' };
  const files = readTree(target).filter((f) => f.path !== path.basename(mp));
  const marker = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const actual = hashFiles(files);
  if (actual !== (expectedHash ?? marker.contentHash)) return { ok: false, detail: 'installed files do not match the canonical snapshot' };
  return { ok: true, detail: `SKILL.md valid (name "${fm.name}"), ${files.length} file(s) match snapshot ${actual.slice(0, 12)}` };
}

function removeManaged(target: string) {
  if (!fs.existsSync(target)) return;
  if (!markerPath(target)) throw new Error(`Refusing to remove ${target}: it has no Synaptome marker, so it was not installed by Synaptome`);
  fs.rmSync(target, { recursive: true, force: true });
}

/* =====================================================================
 * Single-file targets (agents, commands): <root>/agents/<name>.md plus a
 * sidecar "<name>.md.synaptome.json". Hosts read only *.md there, so the sidecar is inert.
 * ===================================================================== */

export const sidecarOf = (file: string) => `${file}.${PRODUCT.markerFile.replace(/^\./, '')}`;
const LICENCE_FILE = /^(licen[cs]e|copying|notice)(\.[a-z0-9]+)?$/i;

export const fileOps: TargetOps = {
  exists: (t) => fs.existsSync(t) || fs.existsSync(sidecarOf(t)),
  owner: (t) => readJsonFile(sidecarOf(t))?.capabilityId ?? null,
  fingerprint(t) {
    if (!fileOps.exists(t)) return null;
    const part = (p: string) => (fs.existsSync(p) ? sha(fs.readFileSync(p)) : '-');
    return sha(`file\0${part(t)}\nmarker\0${part(sidecarOf(t))}`);
  },
  payloadHash: () => null,
  backup(t, dir) {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(t)) fs.copyFileSync(t, path.join(dir, 'file'));
    if (fs.existsSync(sidecarOf(t))) fs.copyFileSync(sidecarOf(t), path.join(dir, 'marker'));
  },
  restore(dir, t) {
    fs.mkdirSync(path.dirname(t), { recursive: true });
    for (const [saved, dest] of [[path.join(dir, 'file'), t], [path.join(dir, 'marker'), sidecarOf(t)]]) {
      if (fs.existsSync(saved)) fs.copyFileSync(saved, dest);
      else fs.rmSync(dest, { force: true });
    }
  },
  discard(t) {
    fs.rmSync(t, { force: true });
    fs.rmSync(sidecarOf(t), { force: true });
  },
};

/** The one Markdown file a single-file capability installs as; licence files ride along in the sidecar record. */
function singleEntry(cap: CapabilityRecord, files: FetchedFile[], what: string): { entry: FetchedFile; licences: FetchedFile[] } {
  const md = files.filter((f) => /\.md$/i.test(f.path) && !LICENCE_FILE.test(path.basename(f.path)));
  const entry = files.find((f) => f.path === cap.entryFile) ?? (md.length === 1 ? md[0] : undefined);
  if (!entry) throw new Error(`${what} package has no single Markdown entry file`);
  const others = files.filter((f) => f !== entry);
  const extra = others.filter((f) => !LICENCE_FILE.test(path.basename(f.path)));
  if (extra.length) throw new Error(`${what} installs as one Markdown file, but the package also contains ${extra.map((f) => f.path).join(', ')}`);
  return { entry, licences: others };
}

function writeFileTarget(cap: CapabilityRecord, files: FetchedFile[], target: string, host: string, what: string) {
  if (fileOps.exists(target)) throw new Error(`Refusing to write over existing file: ${target}`);
  const { entry, licences } = singleEntry(cap, files, what);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // The record first: if writing the file fails, the leftover sidecar still says whose it was.
  fs.writeFileSync(sidecarOf(target), JSON.stringify({ managedBy: PRODUCT.managedBy, host, kind: what, capabilityId: cap.id, contentHash: hashFiles(files), entry: entry.path, entrySha256: sha(entry.content), licenceFiles: licences.map((l) => ({ path: l.path, sha256: sha(l.content) })), source: cap.provenance.url, commit: cap.commit, licence: cap.license.spdx, installedAt: new Date().toISOString() }, null, 2));
  fs.writeFileSync(target, entry.content, 'utf8');
}

function verifyFileTarget(cap: CapabilityRecord, target: string, what: 'agent' | 'command'): { ok: boolean; detail: string } {
  if (!fs.existsSync(target)) return { ok: false, detail: `${path.basename(target)} missing after install` };
  const marker = readJsonFile(sidecarOf(target));
  if (!marker) return { ok: false, detail: 'management record missing' };
  if (marker.capabilityId !== cap.id) return { ok: false, detail: `management record names ${marker.capabilityId}, not ${cap.id}` };
  const text = fs.readFileSync(target, 'utf8');
  if (sha(text) !== marker.entrySha256) return { ok: false, detail: 'installed file does not match the canonical snapshot' };
  const fm = parseFrontmatter(text).data;
  if (what === 'agent') {
    // Claude Code skips agent files whose name is missing or invalid, or that have no description.
    if (typeof fm.name !== 'string' || !fm.name.trim()) return { ok: false, detail: 'agent front matter has no name' };
    if (fm.name.length > 256 || fm.name.startsWith('-') || fm.name.includes(':')) return { ok: false, detail: `agent name "${fm.name}" breaks the host's rules (max 256, no leading "-", no ":")` };
    if (typeof fm.description !== 'string' || !fm.description.trim()) return { ok: false, detail: 'agent front matter has no description' };
    return { ok: true, detail: `agent "${fm.name}" valid; file matches snapshot entry ${marker.entrySha256.slice(0, 12)}` };
  }
  return { ok: true, detail: `command /${path.basename(target, '.md')} valid; file matches snapshot entry ${marker.entrySha256.slice(0, 12)}` };
}

function removeFileTarget(target: string) {
  if (!fileOps.exists(target)) return;
  if (!fileOps.owner(target)) throw new Error(`Refusing to remove ${target}: it has no Synaptome record, so it was not installed by Synaptome`);
  fileOps.discard(target);
}

function mdFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...mdFiles(full));
    else if (e.isFile() && /\.md$/i.test(e.name)) out.push(full);
  }
  return out;
}

/** Agents are identified by their front-matter name, not their file name: two files with one name means one is ignored. */
function agentPreflight(cap: CapabilityRecord, files: FetchedFile[], target: string): string | null {
  let entry: FetchedFile;
  try {
    entry = singleEntry(cap, files, 'an agent').entry;
  } catch (e: any) {
    return e.message;
  }
  const name = parseFrontmatter(entry.content).data.name;
  if (typeof name !== 'string' || !name.trim()) return 'the agent file has no name in its front matter, so the host would skip it';
  for (const f of mdFiles(path.dirname(target))) {
    if (path.resolve(f) === path.resolve(target)) continue;
    let other: unknown;
    try {
      other = parseFrontmatter(fs.readFileSync(f, 'utf8')).data.name;
    } catch {
      continue;
    }
    if (other === name) return `an agent named "${name}" already exists at ${f}; the host would load only one of them`;
  }
  return null;
}

/** A skill with the same name takes precedence over a command, so the command would never run. */
function commandPreflight(cap: CapabilityRecord, files: FetchedFile[], target: string): string | null {
  try {
    singleEntry(cap, files, 'a command');
  } catch (e: any) {
    return e.message;
  }
  const skill = path.join(path.dirname(path.dirname(target)), 'skills', path.basename(target, '.md'), 'SKILL.md');
  return fs.existsSync(skill) ? `a skill with the same name exists at ${skill}; it would take precedence over this command` : null;
}

/* =====================================================================
 * MCP entries: one key under "mcpServers" in a project's .mcp.json (target "<file>#<name>"),
 * recorded in the sidecar ledger "<file>.synaptome.json". Synaptome never writes user-scope config.
 * ===================================================================== */

const splitEntry = (target: string) => {
  const i = target.lastIndexOf('#');
  return { file: target.slice(0, i), name: target.slice(i + 1) };
};
type LedgerEntry = { capabilityId: string; entryHash: string; before: string | null; contentHash: string; source: string; installedAt: string };
type Ledger = { managedBy: string; entries: Record<string, LedgerEntry> };
const ledgerOf = (file: string): Ledger => readJsonFile(sidecarOf(file)) ?? { managedBy: PRODUCT.managedBy, entries: {} };
function writeLedger(file: string, l: Ledger) {
  if (!Object.keys(l.entries).length) fs.rmSync(sidecarOf(file), { force: true });
  else fs.writeFileSync(sidecarOf(file), JSON.stringify(l, null, 2));
}
function readConfig(file: string): any {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${file} is not valid JSON; fix it before installing into it`);
  }
}
/** Configuration without an empty "mcpServers", for comparing "is it what it was before". */
const bare = (cfg: any) => {
  if (!cfg) return {};
  const c = { ...cfg };
  if (c.mcpServers && !Object.keys(c.mcpServers).length) delete c.mcpServers;
  return c;
};
const envName = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');

/**
 * The .mcp.json entry for an MCP registry record. A remote https endpoint is preferred (nothing runs locally);
 * otherwise a pinned npm or PyPI package. Required secrets become ${VARIABLE} references, never values.
 */
export function mcpEntryFor(files: FetchedFile[]): { entry: Record<string, unknown>; needs: string[] } {
  const f = files.find((x) => x.path === 'server.json');
  if (!f) throw new Error('MCP package has no server.json record');
  const s = JSON.parse(f.content);
  const needs: string[] = [];
  const remote = (s.remotes ?? []).find((r: any) => ['streamable-http', 'http', 'sse'].includes(r.type) && /^https:\/\//.test(r.url ?? ''));
  if (remote) {
    const headers: Record<string, string> = {};
    for (const h of remote.headers ?? []) {
      if (!h.isRequired) continue;
      const v = `SYNAPTOME_MCP_${envName(s.name ?? '')}_${envName(h.name)}`;
      headers[h.name] = h.name.toLowerCase() === 'authorization' ? `Bearer \${${v}}` : `\${${v}}`;
      needs.push(v);
    }
    return { entry: { type: remote.type === 'sse' ? 'sse' : 'http', url: remote.url, ...(needs.length ? { headers } : {}) }, needs };
  }
  const pkg = (s.packages ?? []).find((p: any) => p.registryType === 'npm' || p.registryType === 'pypi');
  if (!pkg) throw new Error('the registry record has neither an https endpoint nor an npm or PyPI package Synaptome can configure');
  if (!pkg.version || pkg.version === 'latest' || /[\^~*<>| ]|^x$/i.test(pkg.version)) throw new Error(`package ${pkg.identifier} has no pinned version`);
  if ((pkg.packageArguments ?? []).some((a: any) => a.isRequired)) throw new Error(`package ${pkg.identifier} needs arguments Synaptome cannot fill in safely`);
  const env: Record<string, string> = {};
  for (const v of pkg.environmentVariables ?? []) {
    if (!v.isRequired) continue;
    env[v.name] = `\${${v.name}}`;
    needs.push(v.name);
  }
  const launch = pkg.registryType === 'npm' ? { command: 'npx', args: ['-y', `${pkg.identifier}@${pkg.version}`] } : { command: 'uvx', args: [`${pkg.identifier}==${pkg.version}`] };
  return { entry: { type: 'stdio', ...launch, ...(needs.length ? { env } : {}) }, needs };
}

/** Removes one entry. When nothing else in the file changed since it was added, the file's exact earlier bytes come back. */
function removeMcpEntry(target: string, checkOwner: boolean) {
  const { file, name } = splitEntry(target);
  const ledger = ledgerOf(file);
  const rec = ledger.entries[name];
  if (checkOwner && !rec) throw new Error(`Refusing to remove "${name}" from ${file}: Synaptome did not add it`);
  const cfg = readConfig(file);
  if (cfg) {
    const without = { ...cfg, mcpServers: { ...(cfg.mcpServers ?? {}) } };
    delete without.mcpServers[name];
    const before = rec?.before != null ? Buffer.from(rec.before, 'base64') : null;
    const beforeCfg = before ? JSON.parse(before.toString('utf8')) : null;
    if (rec && canon(bare(without)) === canon(bare(beforeCfg))) {
      if (before) fs.writeFileSync(file, before);
      else fs.rmSync(file, { force: true });
    } else fs.writeFileSync(file, `${JSON.stringify(without, null, 2)}\n`);
  }
  if (rec) {
    delete ledger.entries[name];
    writeLedger(file, ledger);
  }
}

export const mcpOps: TargetOps = {
  exists(t) {
    const { file, name } = splitEntry(t);
    let cfg: any = null;
    try {
      cfg = readConfig(file);
    } catch {
      return true; // an unreadable file is not free to write into
    }
    return cfg?.mcpServers?.[name] !== undefined || !!ledgerOf(file).entries[name];
  },
  owner(t) {
    const { file, name } = splitEntry(t);
    return ledgerOf(file).entries[name]?.capabilityId ?? null;
  },
  fingerprint(t) {
    if (!mcpOps.exists(t)) return null;
    const { file, name } = splitEntry(t);
    let entry: unknown = null;
    try {
      entry = readConfig(file)?.mcpServers?.[name] ?? null;
    } catch {
      entry = 'unreadable';
    }
    return sha(canon({ entry, record: ledgerOf(file).entries[name] ?? null }));
  },
  payloadHash: () => null,
  backup(t, dir) {
    const { file, name } = splitEntry(t);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'entry.json'), JSON.stringify({ entry: readConfig(file)?.mcpServers?.[name] ?? null, record: ledgerOf(file).entries[name] ?? null }, null, 2));
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(dir, 'config'));
    if (fs.existsSync(sidecarOf(file))) fs.copyFileSync(sidecarOf(file), path.join(dir, 'ledger'));
  },
  restore(dir, t) {
    const { file, name } = splitEntry(t);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'entry.json'), 'utf8'));
    const cfg = readConfig(file) ?? {};
    const next = { ...cfg, mcpServers: { ...(cfg.mcpServers ?? {}) } };
    if (saved.entry === null) delete next.mcpServers[name];
    else next.mcpServers[name] = saved.entry;
    const savedCfgPath = path.join(dir, 'config');
    const savedCfg = fs.existsSync(savedCfgPath) ? JSON.parse(fs.readFileSync(savedCfgPath, 'utf8')) : null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (canon(bare(next)) === canon(bare(savedCfg))) {
      if (savedCfg) fs.copyFileSync(savedCfgPath, file);
      else fs.rmSync(file, { force: true });
    } else fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    const ledger = ledgerOf(file);
    if (saved.record) ledger.entries[name] = saved.record;
    else delete ledger.entries[name];
    const savedLedgerPath = path.join(dir, 'ledger');
    if (fs.existsSync(savedLedgerPath) && canon(ledger) === canon(JSON.parse(fs.readFileSync(savedLedgerPath, 'utf8')))) fs.copyFileSync(savedLedgerPath, sidecarOf(file));
    else writeLedger(file, ledger);
  },
  discard: (t) => removeMcpEntry(t, false),
};

function writeMcpEntry(cap: CapabilityRecord, files: FetchedFile[], target: string) {
  const { file, name } = splitEntry(target);
  const { entry } = mcpEntryFor(files);
  const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
  const cfg = readConfig(file) ?? {};
  if (cfg.mcpServers?.[name] !== undefined) throw new Error(`Refusing to replace the existing "${name}" entry in ${file}`);
  const ledger = ledgerOf(file);
  if (ledger.entries[name]) throw new Error(`A record for "${name}" already exists in ${sidecarOf(file)}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // The record first, with the file's earlier bytes, so a failure halfway can be undone exactly.
  ledger.entries[name] = { capabilityId: cap.id, entryHash: sha(canon(entry)), before: before ? before.toString('base64') : null, contentHash: hashFiles(files), source: cap.provenance.url, installedAt: new Date().toISOString() };
  writeLedger(file, ledger);
  fs.writeFileSync(file, `${JSON.stringify({ ...cfg, mcpServers: { ...(cfg.mcpServers ?? {}), [name]: entry } }, null, 2)}\n`);
}

function verifyMcpEntry(cap: CapabilityRecord, target: string): { ok: boolean; detail: string } {
  const { file, name } = splitEntry(target);
  let cfg: any;
  try {
    cfg = readConfig(file);
  } catch (e: any) {
    return { ok: false, detail: e.message };
  }
  const entry = cfg?.mcpServers?.[name];
  if (!entry) return { ok: false, detail: `no "${name}" entry under mcpServers in ${file}` };
  const rec = ledgerOf(file).entries[name];
  if (!rec || rec.capabilityId !== cap.id) return { ok: false, detail: 'management record missing or names another capability' };
  if (sha(canon(entry)) !== rec.entryHash) return { ok: false, detail: 'entry differs from what Synaptome wrote' };
  if (entry.type === 'http' || entry.type === 'sse') {
    if (!/^https:\/\//.test(entry.url ?? '')) return { ok: false, detail: 'remote entry without an https url' };
  } else if (!entry.command) return { ok: false, detail: 'stdio entry without a command' };
  const what = entry.url ? `${entry.type} ${entry.url}` : `${entry.command} ${(entry.args ?? []).join(' ')}`;
  return { ok: true, detail: `"${name}" in ${path.basename(file)}: ${what}; the host asks the user before it first starts a project server` };
}

function mcpPreflight(_cap: CapabilityRecord, files: FetchedFile[], target: string): string | null {
  try {
    mcpEntryFor(files);
    readConfig(splitEntry(target).file);
    return null;
  } catch (e: any) {
    return e.message;
  }
}

/* =====================================================================
 * Dispatch by target shape.
 * ===================================================================== */

type Shape = 'dir' | 'file' | 'mcp';
const shapeOf = (t: string): Shape => (path.basename(t).includes('#') ? 'mcp' : /\.md$/i.test(t) ? 'file' : 'dir');
const OPS: Record<Shape, TargetOps> = { dir: dirOps, file: fileOps, mcp: mcpOps };
/** Target operations chosen by the shape of the target path. */
export const targetOps: TargetOps = {
  exists: (t) => OPS[shapeOf(t)].exists(t),
  owner: (t) => OPS[shapeOf(t)].owner(t),
  fingerprint: (t) => OPS[shapeOf(t)].fingerprint(t),
  payloadHash: (t) => OPS[shapeOf(t)].payloadHash(t),
  backup: (t, d) => OPS[shapeOf(t)].backup(t, d),
  restore: (d, t) => OPS[shapeOf(t)].restore(d, t),
  discard: (t) => OPS[shapeOf(t)].discard(t),
};
const fileKind = (k: string): 'agent' | 'command' => (k === 'prompt' ? 'command' : 'agent');

/**
 * Claude Code. Documented locations (checked 2026-11-12 against code.claude.com/docs):
 * skills ~/.claude/skills/<name>/SKILL.md; subagents ~/.claude/agents/*.md (identity = front-matter name);
 * commands ~/.claude/commands/<name>.md (older format; a skill of the same name wins);
 * MCP servers: project scope <project>/.mcp.json "mcpServers" (user scope lives in ~/.claude.json, which Synaptome never edits).
 */
export function claudeCodeAdapter(opts: { claudeRoot?: string; projectRoot?: string } = {}): HostAdapter {
  const root = opts.claudeRoot ?? path.join(os.homedir(), '.claude');
  return {
    id: 'claude-code',
    title: 'Claude Code',
    status: 'PARTIALLY_VERIFIED',
    statusEvidence: 'skills: install, verification, removal and rollback exercised once against the real ~/.claude/skills, then the full install matrix in sandbox hosts; agents, commands and project MCP entries: install matrix in sandbox hosts only, layouts checked against the documentation, not yet loaded by a running host',
    supportedKinds: ['skill', 'agent', 'subagent', 'prompt', 'mcp-server'],
    detect: () => detectBinary('claude', root),
    targetFor(cap, scope, sandboxRoot) {
      const base = scope === 'real' ? root : path.join(sandboxRoot, 'claude-code');
      const n = skillDirName(cap);
      if (cap.kind === 'skill') return path.join(base, 'skills', n);
      if (cap.kind === 'agent' || cap.kind === 'subagent') return path.join(base, 'agents', `${n}.md`);
      if (cap.kind === 'prompt') return path.join(base, 'commands', `${n}.md`);
      if (cap.kind === 'mcp-server') {
        if (scope === 'real' && !opts.projectRoot) throw new Error('MCP servers are installed only into a project (.mcp.json); name the project with hosts.claudeProject or --project');
        return `${path.join(scope === 'real' ? opts.projectRoot! : path.join(base, 'project'), '.mcp.json')}#${n}`;
      }
      throw new Error(`Claude Code adapter cannot place kind "${cap.kind}"`);
    },
    materialize(cap, files, target) {
      const shape = shapeOf(target);
      if (shape === 'dir') writeSkillDir(cap, files, target, 'claude-code');
      else if (shape === 'file') writeFileTarget(cap, files, target, 'claude-code', fileKind(cap.kind));
      else writeMcpEntry(cap, files, target);
    },
    verify(cap, target) {
      const shape = shapeOf(target);
      return shape === 'dir' ? verifySkillDir(cap, target) : shape === 'file' ? verifyFileTarget(cap, target, fileKind(cap.kind)) : verifyMcpEntry(cap, target);
    },
    remove(target) {
      const shape = shapeOf(target);
      if (shape === 'dir') removeManaged(target);
      else if (shape === 'file') removeFileTarget(target);
      else removeMcpEntry(target, true);
    },
    ops: targetOps,
    preflight(cap, files, target) {
      const shape = shapeOf(target);
      if (shape === 'mcp') return mcpPreflight(cap, files, target);
      if (shape === 'file') return fileKind(cap.kind) === 'agent' ? agentPreflight(cap, files, target) : commandPreflight(cap, files, target);
      return null;
    },
  };
}

/**
 * OpenCode. Skill location checked against opencode.ai/docs/skills on 2026-11-12: global ~/.config/opencode/skills/<id>/SKILL.md
 * (it also reads ~/.claude/skills and ~/.agents/skills). Because OpenCode already reads ~/.claude/skills, a skill installed for
 * Claude Code is visible to OpenCode too; installing it again here would show it twice. Real installs stay disabled until
 * discovery by a running OpenCode has been exercised.
 */
export function openCodeAdapter(): HostAdapter {
  const root = path.join(os.homedir(), '.config', 'opencode');
  return {
    id: 'opencode',
    title: 'OpenCode',
    status: 'EXPERIMENTAL',
    statusEvidence: 'skill location matches the OpenCode documentation (checked 2026-11-12); staged layout only; discovery by a running OpenCode not tested',
    supportedKinds: ['skill'],
    detect: () => detectBinary('opencode', root),
    targetFor(cap, scope, sandboxRoot) {
      if (scope === 'real') throw new Error(`OpenCode adapter is EXPERIMENTAL: real installs into ${path.join(root, 'skills')} stay disabled until discovery by a running OpenCode is tested (it already reads ~/.claude/skills)`);
      return path.join(sandboxRoot, 'opencode', 'skills', skillDirName(cap));
    },
    materialize: (cap, files, target) => writeSkillDir(cap, files, target, 'opencode'),
    verify: (cap, target) => verifySkillDir(cap, target),
    remove: removeManaged,
    ops: dirOps,
  };
}

/** Hosts that are known but have no adapter yet. Listed so the UI can say so honestly. */
export const UNSUPPORTED_HOSTS = [
  { id: 'codex', title: 'OpenAI Codex CLI', status: 'UNSUPPORTED' as const, reason: 'not installed on this machine; no adapter written' },
  { id: 'gemini-cli', title: 'Gemini CLI', status: 'UNSUPPORTED' as const, reason: 'not installed on this machine; no adapter written' },
  { id: 'cursor', title: 'Cursor', status: 'UNSUPPORTED' as const, reason: 'no adapter written' },
  { id: 'vscode', title: 'VS Code agents', status: 'UNSUPPORTED' as const, reason: 'no adapter written' },
  { id: 'cline', title: 'Cline', status: 'UNSUPPORTED' as const, reason: 'no adapter written' },
  { id: 'roo', title: 'Roo Code', status: 'UNSUPPORTED' as const, reason: 'no adapter written' },
  { id: 'windsurf', title: 'Windsurf', status: 'UNSUPPORTED' as const, reason: 'no adapter written' },
];

export function buildAdapterRegistry(opts: { claudeRoot?: string; projectRoot?: string } = {}): AdapterRegistry {
  return new AdapterRegistry().register(claudeCodeAdapter(opts)).register(openCodeAdapter());
}
