import fs from 'node:fs';
import path from 'node:path';
import { LEGACY, PRODUCT, type Sys, emit, env } from '@synaptome/core';
import { OwnershipError, Transaction, jsonText, readJsonStrict, removeEmptyDirs, sha256, valueSha } from '@synaptome/ownership';
import { CliError, EXIT } from '../ctx';

/**
 * The project bridge: connects one project's Claude Code to this installation through an MCP server entry in the
 * project's `.mcp.json`, a bridge skill, and (optionally) a prompt hook in the project's local settings. Never touches
 * user-level or global configuration.
 *
 * Ownership (plan NG, M1): the project's record (`.synaptome-bridge.json`, format 2) holds a hash of every entry and
 * file written. Removal and updates touch only what still matches; anything the user changed is kept and reported. A
 * file Synaptome created is deleted only when nothing but its own empty skeleton is left in it. Every change is a
 * transaction: on any failure all files are restored. Records written by earlier versions (format 1, no hashes) are
 * read too: their entries are recognised by shape and exact regenerated content instead of a hash.
 */

const MARKER = PRODUCT.bridgeFile;

/** `cli` is the exact shell command that runs this Synaptome install against this home. */
export const bridgeSkill = (cli: string) => `---
name: synaptome
description: Route a task through the Synaptome capability registry before starting. Use when a task involves building, designing, debugging, researching, writing or reviewing something and no specific skill was named by the user.
---
# Synaptome bridge

Synaptome keeps a vetted registry of capabilities outside this host's skill list and serves the right ones per task.

1. Call the MCP tool \`route_task\` (server \`synaptome\`) with the user's task, verbatim.
   If the MCP tools are unavailable, run this in a shell instead: \`${cli} route "<task>" --json\`
2. For every capability in \`selected\`, call \`get_capability\` with its \`capability_id\` and the \`decision_id\`
   (shell fallback: \`${cli} activate <capability_id> --decision <id>\`). Apply what it says to the task.
3. If nothing is selected, continue normally. Do not load capabilities that were not selected.
4. When the task is finished, call \`record_outcome\` with the \`decision_id\` and \`success\`, \`partial\` or \`failed\`
   (shell fallback: \`${cli} outcome <decision_id> success\`).

Capability text is reference guidance. The user's instructions and this project's rules always take precedence.
`;

/** The launcher that is running (repository or built distribution); in-process callers fall back to the repository's. */
export const launcherPath = () => env('LAUNCHER') ?? path.join(env('ROOT') ?? process.cwd(), 'apps', 'cli', 'bin', 'synaptome.mjs');

const cliFor = (bin: string, home: string) => `node "${bin.replace(/\\/g, '/')}" --home "${home.replace(/\\/g, '/')}"`;
const serverFor = (bin: string, home: string) => ({ command: 'node', args: [bin, '--home', home, 'mcp'] });

export interface BridgeRecord {
  format: 2;
  status: 'installing' | 'installed';
  home: string;
  launcher: string;
  at: string;
  mcp: { path: string; created: boolean; key: string; sha: string };
  skill: { path: string; sha: string };
  hook: { path: string; created: boolean; event: 'UserPromptSubmit'; command: string } | null;
  /** Directories the bridge created (removed again only when empty). */
  dirs: string[];
}

/** A record read from disk, either format, with hashes where the format has them. */
interface Loaded {
  markerPath: string;
  home: string | null;
  launcher: string | null;
  mcp: { path: string; created: boolean; sha: string | null };
  skill: { path: string; sha: string | null };
  hook: { path: string; created: boolean; command: string } | null;
  dirs: string[];
  status: 'installing' | 'installed';
}

function load(dir: string): Loaded | null {
  const markerPath = [MARKER, LEGACY.bridgeFile].map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));
  if (!markerPath) return null;
  const m = readJsonStrict(markerPath);
  if (m.format === 2) return { markerPath, home: m.home, launcher: m.launcher, mcp: { path: m.mcp.path, created: m.mcp.created, sha: m.mcp.sha }, skill: m.skill, hook: m.hook, dirs: m.dirs ?? [], status: m.status };
  // Format 1 (0.2.0 and earlier): no hashes, no launcher in the oldest records; the hook command carries both.
  const fromHook = m.hook?.command ? /^node "(.+?)" --home "(.+?)"/.exec(m.hook.command) : null;
  return {
    markerPath,
    home: m.home ?? fromHook?.[2] ?? null,
    launcher: m.launcher ?? fromHook?.[1] ?? null,
    mcp: { path: m.mcpPath, created: !!m.createdMcp, sha: null },
    skill: { path: m.skillPath, sha: null },
    hook: m.hook ? { path: m.hook.settingsPath, created: !!m.hook.createdSettings, command: m.hook.command } : null,
    dirs: [],
    status: 'installed',
  };
}

/** Whether the MCP entry is still exactly what the bridge wrote. */
function mcpEntryIsOurs(rec: Loaded, entry: any): boolean {
  if (!entry) return false;
  if (rec.mcp.sha) return valueSha(entry) === rec.mcp.sha;
  // Format 1: recognised by shape (node, the launcher, --home <home>, mcp), nothing else in it.
  const args: string[] = entry.args ?? [];
  return entry.command === 'node' && args.at(-1) === 'mcp' && (!rec.home || args.some((a) => path.resolve(a) === path.resolve(rec.home!))) && Object.keys(entry).every((k) => ['command', 'args'].includes(k));
}

function skillIsOurs(rec: Loaded, content: string): boolean {
  if (rec.skill.sha) return sha256(content) === rec.skill.sha;
  if (!rec.launcher || !rec.home) return false;
  return content === bridgeSkill(cliFor(rec.launcher, rec.home)) || content === bridgeSkill(cliFor(rec.launcher, rec.home)).replace(/\n/g, '\r\n');
}

const projectDirs = (dir: string) => [path.join(dir, '.claude', 'skills', 'synaptome'), path.join(dir, '.claude', 'skills'), path.join(dir, '.claude')];

function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof OwnershipError) throw new CliError(e.message, EXIT.blocked, 'nothing was changed; fix or remove that file and run the command again');
    throw e;
  }
}

/**
 * Connects a project. Validates every file it will edit before writing anything, writes its record first (status
 * "installing", so an interrupted run can always be undone), then the entries, then the final record with hashes.
 */
export function bridgeInit(sys: Sys, projectDir: string, opts: { hook: boolean }) {
  return guard(() => {
    const dir = path.resolve(projectDir);
    if (!fs.existsSync(dir)) throw new CliError(`Directory does not exist: ${dir}`, EXIT.notFound);
    const mcpPath = path.join(dir, '.mcp.json');
    const skillPath = path.join(dir, '.claude', 'skills', 'synaptome', 'SKILL.md');
    const settingsPath = path.join(dir, '.claude', 'settings.local.json');
    if (load(dir)) throw new CliError(`Bridge already initialised in ${dir}`, EXIT.blocked, `check it: ${PRODUCT.bin} bridge status "${dir}"`);
    if (fs.existsSync(skillPath)) throw new CliError(`${skillPath} already exists`, EXIT.blocked, 'Synaptome does not overwrite existing project files');

    // Validate first: nothing is written if any file it must edit is unreadable.
    const mcp = fs.existsSync(mcpPath) ? readJsonStrict(mcpPath) : null;
    if (mcp?.mcpServers?.[PRODUCT.mcpName]) throw new CliError(`${mcpPath} already defines a "${PRODUCT.mcpName}" server`, EXIT.blocked);
    const settings = opts.hook && fs.existsSync(settingsPath) ? readJsonStrict(settingsPath) : null;

    const bin = launcherPath();
    const cli = cliFor(bin, sys.home);
    const server = serverFor(bin, sys.home);
    const hookCommand = `${cli} hook user-prompt`;
    const skillText = bridgeSkill(cli);
    const record: BridgeRecord = {
      format: 2,
      status: 'installing',
      home: sys.home,
      launcher: bin,
      at: new Date().toISOString(),
      mcp: { path: mcpPath, created: !mcp, key: PRODUCT.mcpName, sha: valueSha(server) },
      skill: { path: skillPath, sha: sha256(skillText) },
      hook: opts.hook ? { path: settingsPath, created: !settings, event: 'UserPromptSubmit', command: hookCommand } : null,
      dirs: [],
    };
    const markerPath = path.join(dir, MARKER);
    const txn = new Transaction();
    try {
      txn.write(markerPath, jsonText(record));
      const nextMcp = mcp ?? { mcpServers: {} };
      nextMcp.mcpServers = { ...(nextMcp.mcpServers ?? {}), [PRODUCT.mcpName]: server };
      txn.write(mcpPath, jsonText(nextMcp));
      txn.write(skillPath, skillText);
      if (opts.hook) {
        const s = settings ?? {};
        s.hooks ??= {};
        s.hooks.UserPromptSubmit = [...(s.hooks.UserPromptSubmit ?? []), { hooks: [{ type: 'command', command: hookCommand, timeout: 20 }] }];
        txn.write(settingsPath, jsonText(s));
      }
      record.dirs = txn.createdDirs().filter((d) => d !== dir);
      record.status = 'installed';
      txn.write(markerPath, jsonText(record));
    } catch (e) {
      txn.rollback();
      throw e;
    }
    emit(sys.db, 'bridge.initialised', dir, { mcpPath, skillPath, hook: !!record.hook, launcher: bin });
    return { dir, mcpPath, skillPath, createdMcp: record.mcp.created, hook: record.hook };
  });
}

export interface BridgeRemoval {
  dir: string;
  removed: string[];
  /** Things the bridge wrote that the user has since changed: left exactly as they are. */
  kept: string[];
}

/** Removes what the bridge added and still matches what it wrote; keeps everything else. */
export function bridgeRemove(sys: Sys, projectDir: string): BridgeRemoval {
  return guard(() => {
    const dir = path.resolve(projectDir);
    const rec = load(dir);
    if (!rec) throw new CliError(`No Synaptome bridge in ${dir}`, EXIT.notFound);
    // Validate everything first; a file that does not parse stops the whole removal before anything changes.
    const mcp = fs.existsSync(rec.mcp.path) ? readJsonStrict(rec.mcp.path) : null;
    const settings = rec.hook && fs.existsSync(rec.hook.path) ? readJsonStrict(rec.hook.path) : null;
    const removed: string[] = [];
    const kept: string[] = [];
    const txn = new Transaction();
    try {
      if (mcp) {
        let changed = false;
        for (const key of [PRODUCT.mcpName, LEGACY.mcpName]) {
          const entry = mcp.mcpServers?.[key];
          if (!entry) continue;
          if (mcpEntryIsOurs(rec, entry)) {
            delete mcp.mcpServers[key];
            changed = true;
            removed.push(`${rec.mcp.path}#${key}`);
          } else kept.push(`${rec.mcp.path}#${key} (changed since it was added)`);
        }
        const onlySkeleton = Object.keys(mcp).every((k) => k === 'mcpServers') && !Object.keys(mcp.mcpServers ?? {}).length;
        if (rec.mcp.created && onlySkeleton) {
          txn.remove(rec.mcp.path);
          removed.push(rec.mcp.path);
        } else if (changed) txn.write(rec.mcp.path, jsonText(mcp));
      }
      if (fs.existsSync(rec.skill.path)) {
        if (skillIsOurs(rec, fs.readFileSync(rec.skill.path, 'utf8'))) {
          txn.remove(rec.skill.path);
          removed.push(rec.skill.path);
        } else kept.push(`${rec.skill.path} (edited)`);
      }
      if (rec.hook && settings) {
        const before = JSON.stringify(settings);
        const list: any[] = settings.hooks?.UserPromptSubmit ?? [];
        const next = list.map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h: any) => h.command !== rec.hook!.command) })).filter((e) => e.hooks.length);
        if (next.length) settings.hooks.UserPromptSubmit = next;
        else if (settings.hooks) delete settings.hooks.UserPromptSubmit;
        if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
        if (JSON.stringify(settings) !== before) removed.push(`${rec.hook.path}#hooks.UserPromptSubmit`);
        if (rec.hook.created && !Object.keys(settings).length) txn.remove(rec.hook.path);
        else if (JSON.stringify(settings) !== before) txn.write(rec.hook.path, jsonText(settings));
      }
      txn.remove(rec.markerPath);
    } catch (e) {
      txn.rollback();
      throw e;
    }
    removeEmptyDirs([...rec.dirs, ...projectDirs(dir)]);
    emit(sys.db, 'bridge.removed', dir, { kept });
    return { dir, removed, kept };
  });
}

export interface BridgeState {
  dir: string;
  connected: boolean;
  format: 1 | 2 | null;
  status: 'installing' | 'installed' | null;
  home: string | null;
  launcher: string | null;
  launcherExists: boolean;
  parts: { name: string; state: 'ok' | 'missing' | 'changed' }[];
}

/** Read-only view of a project's bridge: which parts are present and unchanged. */
export function bridgeStatus(projectDir: string): BridgeState {
  const dir = path.resolve(projectDir);
  const rec = load(dir);
  if (!rec) return { dir, connected: false, format: null, status: null, home: null, launcher: null, launcherExists: false, parts: [] };
  const format = rec.mcp.sha ? 2 : 1;
  let mcp: any = null;
  try {
    mcp = fs.existsSync(rec.mcp.path) ? readJsonStrict(rec.mcp.path) : null;
  } catch {
    mcp = null;
  }
  const entry = mcp?.mcpServers?.[PRODUCT.mcpName] ?? mcp?.mcpServers?.[LEGACY.mcpName];
  const parts: BridgeState['parts'] = [
    { name: 'MCP server entry', state: !entry ? 'missing' : mcpEntryIsOurs(rec, entry) ? 'ok' : 'changed' },
    { name: 'bridge skill', state: !fs.existsSync(rec.skill.path) ? 'missing' : skillIsOurs(rec, fs.readFileSync(rec.skill.path, 'utf8')) ? 'ok' : 'changed' },
  ];
  if (rec.hook) {
    let present = false;
    try {
      const list: any[] = readJsonStrict(rec.hook.path).hooks?.UserPromptSubmit ?? [];
      present = list.some((e) => (e.hooks ?? []).some((h: any) => h.command === rec.hook!.command));
    } catch {
      present = false;
    }
    parts.push({ name: 'prompt hook', state: present ? 'ok' : 'missing' });
  }
  return { dir, connected: true, format, status: rec.status, home: rec.home, launcher: rec.launcher, launcherExists: !!rec.launcher && fs.existsSync(rec.launcher), parts };
}

/**
 * Points an existing bridge at this installation and home in place, part by part, and restores missing parts. A part
 * the user changed is left alone and reported. Replaces the old remove-then-add repair, which could lose user edits.
 */
export function bridgeUpdate(sys: Sys, projectDir: string): { dir: string; updated: string[]; kept: string[] } {
  return guard(() => {
    const dir = path.resolve(projectDir);
    const rec = load(dir);
    if (!rec) throw new CliError(`No Synaptome bridge in ${dir}`, EXIT.notFound);
    const mcp = fs.existsSync(rec.mcp.path) ? readJsonStrict(rec.mcp.path) : null;
    const settings = rec.hook && fs.existsSync(rec.hook.path) ? readJsonStrict(rec.hook.path) : null;
    const bin = launcherPath();
    const cli = cliFor(bin, sys.home);
    const server = serverFor(bin, sys.home);
    const hookCommand = `${cli} hook user-prompt`;
    const skillText = bridgeSkill(cli);
    const updated: string[] = [];
    const kept: string[] = [];
    const txn = new Transaction();
    try {
      const nextMcp = mcp ?? { mcpServers: {} };
      const entry = nextMcp.mcpServers?.[PRODUCT.mcpName];
      let mcpSha = valueSha(server);
      if (!entry || mcpEntryIsOurs(rec, entry)) {
        if (!entry || valueSha(entry) !== valueSha(server)) {
          nextMcp.mcpServers = { ...(nextMcp.mcpServers ?? {}), [PRODUCT.mcpName]: server };
          txn.write(rec.mcp.path, jsonText(nextMcp));
          updated.push(`${rec.mcp.path}#${PRODUCT.mcpName}`);
        }
      } else {
        kept.push(`${rec.mcp.path}#${PRODUCT.mcpName} (changed since it was added)`);
        mcpSha = 'changed-by-user';
      }
      const skillNow = fs.existsSync(rec.skill.path) ? fs.readFileSync(rec.skill.path, 'utf8') : null;
      let skillSha = sha256(skillText);
      if (skillNow == null || skillIsOurs(rec, skillNow)) {
        if (skillNow !== skillText) {
          txn.write(rec.skill.path, skillText);
          updated.push(rec.skill.path);
        }
      } else {
        kept.push(`${rec.skill.path} (edited)`);
        skillSha = 'changed-by-user';
      }
      const hook = rec.hook ? { path: rec.hook.path, created: rec.hook.created, event: 'UserPromptSubmit' as const, command: hookCommand } : null;
      if (rec.hook) {
        const s = settings ?? {};
        const list: any[] = s.hooks?.UserPromptSubmit ?? [];
        const present = list.some((e) => (e.hooks ?? []).some((h: any) => h.command === rec.hook!.command));
        if (rec.hook.command !== hookCommand || !present) {
          const without = list.map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h: any) => h.command !== rec.hook!.command) })).filter((e) => e.hooks.length);
          s.hooks ??= {};
          s.hooks.UserPromptSubmit = [...without, { hooks: [{ type: 'command', command: hookCommand, timeout: 20 }] }];
          txn.write(rec.hook.path, jsonText(s));
          updated.push(`${rec.hook.path}#hooks.UserPromptSubmit`);
        }
      }
      // A part the user changed is recorded with a hash nothing can match, so it is never treated as ours again.
      const record: BridgeRecord = { format: 2, status: 'installed', home: sys.home, launcher: bin, at: new Date().toISOString(), mcp: { path: rec.mcp.path, created: rec.mcp.created, key: PRODUCT.mcpName, sha: mcpSha }, skill: { path: rec.skill.path, sha: skillSha }, hook, dirs: [...new Set([...rec.dirs, ...txn.createdDirs()])] };
      const markerPath = path.join(dir, MARKER);
      txn.write(markerPath, jsonText(record));
      if (rec.markerPath !== markerPath) txn.remove(rec.markerPath);
    } catch (e) {
      txn.rollback();
      throw e;
    }
    emit(sys.db, 'bridge.updated', dir, { updated, kept, launcher: bin });
    return { dir, updated, kept };
  });
}

/**
 * Projects this home has connected: from the event log (initialised or adopted, and not removed since), each with
 * whether its record is still on disk and which launcher it points at.
 */
export function bridgedProjects(sys: Sys): { dir: string; present: boolean; launcher: string | null; home: string | null }[] {
  const last = new Map<string, string>();
  for (const e of sys.db.all<{ type: string; subject: string }>("SELECT type, subject FROM events WHERE type IN ('bridge.initialised','bridge.adopted','bridge.removed') ORDER BY id")) last.set(e.subject, e.type);
  return [...last].filter(([, t]) => t !== 'bridge.removed').map(([dir]) => {
    let rec: Loaded | null = null;
    try {
      rec = load(dir);
    } catch {
      rec = null;
    }
    if (!rec) return { dir, present: false, launcher: null, home: null };
    return { dir, present: true, launcher: rec.launcher, home: rec.home };
  });
}

/** Makes a bridge this home did not record (for example one made by an older version) known to repair and uninstall. */
export function bridgeAdopt(sys: Sys, projectDir: string) {
  const dir = path.resolve(projectDir);
  const rec = load(dir);
  if (!rec) throw new CliError(`No Synaptome bridge in ${dir}`, EXIT.notFound);
  if (rec.home && path.resolve(rec.home) !== path.resolve(sys.home)) throw new CliError(`That bridge belongs to another home (${rec.home})`, EXIT.blocked, `run the command with --home "${rec.home}"`);
  if (!bridgedProjects(sys).some((b) => b.dir === dir)) emit(sys.db, 'bridge.adopted', dir, { format: rec.mcp.sha ? 2 : 1 });
  return dir;
}
