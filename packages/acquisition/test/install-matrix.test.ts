/**
 * Phase 4 install matrix. Every case runs against disposable homes and temporary host directories only:
 * the sandbox host lives in the temp home, and the "real" host is a temp directory standing in for ~/.claude.
 * The invariant checked throughout: after a failure or a rollback, the host is byte-identical to before.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdapterRegistry, buildAdapterRegistry, claudeCodeAdapter } from '@synaptome/adapters';
import { type CandidateDraft, type DiscoveryConnector, type FetchedFile, getCandidate, hashFiles, listNotifications, readTree, sha256, shortHash, tempSystem } from '@synaptome/core';
import { ConnectorRegistry, checkUpdates, scan, syncSources } from '@synaptome/discovery';
import { type Deps, applyUpdate, approve, inspectUpdate, promotionPolicy, downgrade, evaluateCandidate, getInstallation, install, listInstallations, rollback, treeDigest, uninstall } from '../src/index';

const run = promisify(execFile);
const ROOT = path.resolve(__dirname, '..', '..', '..');
const WORKER = path.join(__dirname, 'fixtures', 'install-worker.ts');

const MIT = 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software';
const f = (p: string, content: string): FetchedFile => ({ path: p, content, size: content.length });
const skillMd = (name: string, extra = '') =>
  `---\nname: ${name}\ndescription: Write clear release notes from a list of merged changes. Use when the user asks for a changelog or release summary. Do not use for commit messages.\n---\n# ${name}\n\n## Workflow\n1. Group changes by type.\n2. Lead with user-visible impact.\n\n## Example\n\`\`\`\n### Added\n- Export to CSV\n\`\`\`\n\n${'Guidance line that explains the reasoning behind the structure in plain language. '.repeat(12)}\n${extra}`;

let sys: ReturnType<typeof tempSystem>;
let claudeRoot: string;
let deps: Deps;
/** Upstream packages keyed by "publisher/name"; tests change them to publish new versions. */
let upstream: Record<string, { ref: string; files: FetchedFile[] }>;
/** Who owns each upstream now, as an update check would report after a repository transfer. */
let owners: Record<string, string>;

function connector(): DiscoveryConnector {
  return {
    id: 'fx', kind: 'fixture', title: 'Fixture', description: '', official: false,
    health: async () => ({ ok: true, detail: 'ok', authenticated: false }),
    search: async () => ({
      drafts: Object.entries(upstream).map(([key, u]): CandidateDraft => {
        const [publisher, name] = key.split('/');
        return { externalId: `${publisher}/skills:${name}`, kind: 'skill', name, description: 'Release notes helper for changelog writing tasks and summaries', repo: `${publisher}/skills`, path: key, ref: u.ref, upstreamVersion: u.ref, publisher, pushedAt: new Date().toISOString(), stars: 500, licenseSpdx: 'MIT' };
      }),
    }),
    fetchPackage: async (c) => ({ files: upstream[c.path!].files, ref: c.ref ?? upstream[c.path!].ref, skipped: [], provenance: { url: `https://example.test/${c.path}@${c.ref}`, method: 'fixture pinned ref', verified: true } }),
    checkUpdate: async (c) => ({ changed: upstream[c.path!].ref !== c.ref, ref: upstream[c.path!].ref, ...(owners[c.path!] ? { publisher: owners[c.path!], repo: `${owners[c.path!]}/skills` } : {}) }),
  };
}

async function discover(key: string): Promise<string> {
  const r = await scan(sys, deps.connectors.get('fx'), { mode: 'broad' });
  return r.candidateIds.find((id) => getCandidate(sys, id)!.path === key)!;
}
const sandboxRoot = () => path.join(sys.paths.sandboxHosts, 'claude-code');
const sandboxTarget = () => path.join(sandboxRoot(), 'skills', 'release-notes');
/**
 * Fingerprint of both hosts: the staged one and the stand-in for the real one. Every file counts; an empty
 * directory does not (the host's own skills/ folder is left in place on uninstall, it is host structure).
 */
const NO_FILES = sha256(''); // what treeDigest gives a directory holding no files
const fp = (dir: string) => treeDigest(dir) ?? NO_FILES;
const hosts = () => `${fp(sandboxRoot())}|${fp(claudeRoot)}`;
const live = (capId: string) => listInstallations(sys, { managedOnly: true, status: 'installed' }).filter((i) => i.capabilityId === capId);
/** Files as installed, without the management marker. */
const payloadHash = (dir: string) => hashFiles(readTree(dir).filter((x) => x.path !== '.synaptome.json'));

/** Publishes a new text-only version of acme/release-notes and applies it; returns [previous live install, new live install]. */
async function publishAndApply(id: string, ref: string, wording: string) {
  const before = live('acme.release-notes')[0];
  upstream['acme/release-notes'] = { ref, files: [f('SKILL.md', skillMd('release-notes', wording)), f('LICENSE', MIT)] };
  await scan(sys, deps.connectors.get('fx'), { mode: 'incremental' });
  const r = await applyUpdate(sys, deps, id);
  expect(r.gate!.decision).toBe('auto-promote');
  const after = live('acme.release-notes')[0];
  expect(after.previousId).toBe(before.id);
  return [before, after] as const;
}
const upgradeToV2 = (id: string) => publishAndApply(id, 'b'.repeat(40), 'Second edition wording.');

/** An adapter registry whose Claude Code adapter breaks in a chosen way. */
function brokenAdapters(how: 'materialize' | 'verify'): AdapterRegistry {
  const base = claudeCodeAdapter({ claudeRoot });
  return new AdapterRegistry().register({
    ...base,
    materialize(cap, files, target) {
      if (how === 'materialize') {
        // write part of the package, then fail, the way a full disk or a killed process would
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, 'SKILL.md'), files[0].content.slice(0, 40));
        throw new Error('disk full (simulated)');
      }
      base.materialize(cap, files, target);
    },
    verify: (cap, target) => (how === 'verify' ? { ok: false, detail: 'simulated verification failure' } : base.verify(cap, target)),
  });
}

beforeEach(() => {
  sys = tempSystem();
  claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synaptome-claude-'));
  fs.mkdirSync(path.join(claudeRoot, 'skills'), { recursive: true });
  deps = { connectors: new ConnectorRegistry().register(connector()), adapters: buildAdapterRegistry({ claudeRoot }) };
  syncSources(sys, deps.connectors);
  upstream = { 'acme/release-notes': { ref: 'a'.repeat(40), files: [f('SKILL.md', skillMd('release-notes')), f('LICENSE', MIT)] } };
  owners = {};
});
afterEach(() => {
  sys.dispose();
  fs.rmSync(claudeRoot, { recursive: true, force: true });
});

describe('install matrix', () => {
  it('fresh install: verified, fingerprinted, one live record', async () => {
    const r = await evaluateCandidate(sys, deps, await discover('acme/release-notes'));
    const [inst] = live(r.capabilityId!);
    expect(inst).toMatchObject({ scope: 'sandbox', verified: true, targetPath: sandboxTarget() });
    expect(inst.treeHash).toBe(treeDigest(sandboxTarget()));
    expect(payloadHash(sandboxTarget())).toBe(inst.contentHash);
  });

  it('repeat install: changes nothing and returns the same record', async () => {
    const r = await evaluateCandidate(sys, deps, await discover('acme/release-notes'));
    const before = hosts();
    const rows = listInstallations(sys).length;
    expect(install(sys, deps, r.capabilityId!, { host: 'claude-code', scope: 'sandbox' }).id).toBe(r.autoInstalled[0]);
    expect(hosts()).toBe(before);
    expect(listInstallations(sys).length).toBe(rows);
  });

  it('upgrade, then rollback: the host is byte-identical to before the upgrade', async () => {
    const id = await discover('acme/release-notes');
    await evaluateCandidate(sys, deps, id);
    const before = hosts();
    const [v1, v2] = await upgradeToV2(id);
    expect(fs.readFileSync(path.join(sandboxTarget(), 'SKILL.md'), 'utf8')).toContain('Second edition');
    expect(hosts()).not.toBe(before);
    const rb = rollback(sys, deps, v2.id);
    expect(rb).toMatchObject({ status: 'rolled_back', restored: v1.id, restoredFrom: 'backup' });
    expect(hosts()).toBe(before);
    expect(live('acme.release-notes').map((i) => i.id)).toEqual([v1.id]);
  });

  it('failed upgrade (partial write or failed verification): reverted byte for byte, failure recorded', async () => {
    const id = await discover('acme/release-notes');
    await evaluateCandidate(sys, deps, id);
    const [v1, v2] = await upgradeToV2(id);
    rollback(sys, deps, v2.id); // v1 live again while v2 is the approved current version
    for (const how of ['materialize', 'verify'] as const) {
      const before = hosts();
      expect(() => install(sys, { ...deps, adapters: brokenAdapters(how) }, 'acme.release-notes', { host: 'claude-code', scope: 'sandbox' })).toThrow(/reverted/);
      expect(hosts()).toBe(before);
      expect(live('acme.release-notes').map((i) => i.id)).toEqual([v1.id]);
    }
    expect(listInstallations(sys, { status: 'failed' })).toHaveLength(2);
    // and a fresh install that fails leaves nothing behind
    uninstall(sys, deps, v1.id);
    const empty = hosts();
    expect(() => install(sys, { ...deps, adapters: brokenAdapters('materialize') }, 'acme.release-notes', { host: 'claude-code', scope: 'sandbox' })).toThrow(/disk full/);
    expect(hosts()).toBe(empty);
    expect(fs.existsSync(sandboxTarget())).toBe(false);
  });

  it('downgrade to an earlier verified version, and rollback of the downgrade', async () => {
    const id = await discover('acme/release-notes');
    await evaluateCandidate(sys, deps, id);
    const [v1, v2] = await upgradeToV2(id);
    const atV2 = hosts();
    const down = downgrade(sys, deps, 'acme.release-notes', { host: 'claude-code', scope: 'sandbox', contentHash: v1.contentHash.slice(0, 12) });
    expect(down).toMatchObject({ contentHash: v1.contentHash, previousId: v2.id });
    expect(payloadHash(sandboxTarget())).toBe(v1.contentHash);
    expect(rollback(sys, deps, down.id).restored).toBe(v2.id);
    expect(hosts()).toBe(atV2);
    expect(() => downgrade(sys, deps, 'acme.release-notes', { host: 'claude-code', scope: 'sandbox', contentHash: 'deadbeef00' })).toThrow(/No recorded version/);
    expect(() => downgrade(sys, deps, 'acme.release-notes', { host: 'claude-code', scope: 'sandbox', contentHash: 'xyz' })).toThrow(/not a content hash/);
  });

  it('refuses to downgrade to a recorded version that was never installed (it never passed the gate)', async () => {
    const id = await discover('acme/release-notes');
    await evaluateCandidate(sys, deps, id);
    // v2 adds a script: registered, held for approval, never installed
    upstream['acme/release-notes'] = { ref: 'c'.repeat(40), files: [f('SKILL.md', skillMd('release-notes', 'v2')), f('scripts/x.sh', 'echo hi'), f('LICENSE', MIT)] };
    await scan(sys, deps.connectors.get('fx'), { mode: 'incremental' });
    expect((await applyUpdate(sys, deps, id)).gate!.decision).toBe('needs-approval');
    const v2Hash = sys.db.get<any>("SELECT content_hash FROM capability_versions WHERE capability_id='acme.release-notes' AND ref=?", 'c'.repeat(40)).content_hash;
    // v3 removes the script again and is applied normally
    await publishAndApply(id, 'e'.repeat(40), 'Third edition wording.');
    const before = hosts();
    expect(() => downgrade(sys, deps, 'acme.release-notes', { host: 'claude-code', scope: 'sandbox', contentHash: v2Hash })).toThrow(/never installed and verified/);
    expect(hosts()).toBe(before);
  });

  it('uninstall: removes exactly what was installed, and earlier records stay as history', async () => {
    const empty = hosts();
    const id = await discover('acme/release-notes');
    await evaluateCandidate(sys, deps, id);
    const [v1, v2] = await upgradeToV2(id);
    expect(uninstall(sys, deps, v2.id).status).toBe('uninstalled');
    expect(hosts()).toBe(empty);
    expect(getInstallation(sys, v1.id)!.status).toBe('superseded');
    expect(() => rollback(sys, deps, v2.id)).toThrow(/not installed/);
  });

  it('never silently discards files edited after install; --force keeps a copy first', async () => {
    const id = await discover('acme/release-notes');
    await evaluateCandidate(sys, deps, id);
    const [, v2] = await upgradeToV2(id);
    fs.appendFileSync(path.join(sandboxTarget(), 'SKILL.md'), '\nMy own note.\n');
    const edited = hosts();
    expect(() => rollback(sys, deps, v2.id)).toThrow(/changed after Synaptome installed it; nothing was removed/);
    expect(() => uninstall(sys, deps, v2.id)).toThrow(/changed after/);
    expect(hosts()).toBe(edited);
    const rb = rollback(sys, deps, v2.id, { force: true });
    expect(fs.readFileSync(path.join(rb.preserved!, 'SKILL.md'), 'utf8')).toContain('My own note.');
    expect(fs.readFileSync(path.join(sandboxTarget(), 'SKILL.md'), 'utf8')).not.toContain('Second edition');
  });

  it('installations recorded before fingerprints existed are still protected against losing edits', async () => {
    const r = await evaluateCandidate(sys, deps, await discover('acme/release-notes'));
    sys.db.run('UPDATE installations SET tree_hash = NULL WHERE id=?', r.autoInstalled[0]); // as written by schema v3
    fs.appendFileSync(path.join(sandboxTarget(), 'SKILL.md'), '\nMy own note.\n');
    expect(() => uninstall(sys, deps, r.autoInstalled[0])).toThrow(/changed after/);
    fs.writeFileSync(path.join(sandboxTarget(), 'SKILL.md'), skillMd('release-notes')); // put it back as installed
    expect(uninstall(sys, deps, r.autoInstalled[0]).status).toBe('uninstalled');
  });

  it('rollback with a missing backup restores from the stored snapshot; with neither, refuses and changes nothing', async () => {
    const id = await discover('acme/release-notes');
    await evaluateCandidate(sys, deps, id);
    const [v1, v2] = await upgradeToV2(id);
    fs.rmSync(v2.backupPath!, { recursive: true });
    const rb = rollback(sys, deps, v2.id);
    expect(rb).toMatchObject({ restored: v1.id, restoredFrom: 'snapshot' });
    expect(payloadHash(sandboxTarget())).toBe(v1.contentHash);
    expect(getInstallation(sys, v1.id)!.treeHash).toBe(treeDigest(sandboxTarget())); // re-fingerprinted

    const v2b = install(sys, deps, 'acme.release-notes', { host: 'claude-code', scope: 'sandbox' });
    fs.rmSync(v2b.backupPath!, { recursive: true });
    const v1Snapshot = sys.db.get<any>('SELECT snapshot_path FROM capability_versions WHERE content_hash=?', v1.contentHash).snapshot_path;
    fs.rmSync(v1Snapshot, { recursive: true });
    const before = hosts();
    expect(() => rollback(sys, deps, v2b.id)).toThrow(/missing or damaged; nothing was changed/);
    expect(hosts()).toBe(before);
    expect(uninstall(sys, deps, v2b.id).status).toBe('uninstalled'); // the way out offered
  });

  it('an owned directory with no live record (lost tracking) is backed up before replacement and restored by rollback', async () => {
    const r = await evaluateCandidate(sys, deps, await discover('acme/release-notes'));
    sys.db.run("UPDATE installations SET status='uninstalled' WHERE id=?", r.autoInstalled[0]); // e.g. the database was restored from an older copy
    fs.writeFileSync(path.join(sandboxTarget(), 'notes.txt'), 'kept by the user');
    const before = hosts();
    const again = install(sys, deps, r.capabilityId!, { host: 'claude-code', scope: 'sandbox' });
    expect(again.previousId).toBeNull();
    expect(again.backupPath).toBeTruthy();
    expect(rollback(sys, deps, again.id).restoredFrom).toBe('backup');
    expect(hosts()).toBe(before);
  });

  it("a user's own skill with the same name in the real host is never touched", async () => {
    const mine = path.join(claudeRoot, 'skills', 'release-notes');
    fs.mkdirSync(mine);
    fs.writeFileSync(path.join(mine, 'SKILL.md'), '---\nname: release-notes\ndescription: mine\n---\nmy own skill');
    const realBefore = treeDigest(claudeRoot);
    const r = await evaluateCandidate(sys, deps, await discover('acme/release-notes'));
    expect(r.gate!.checks.find((c) => c.id === 'conflict')!.result).toBe('fail');
    approve(sys, deps, r.capabilityId!); // a person approves it anyway; the install must still refuse
    install(sys, deps, r.capabilityId!, { host: 'claude-code', scope: 'sandbox' });
    const staged = treeDigest(sandboxRoot());
    expect(() => install(sys, deps, r.capabilityId!, { host: 'claude-code', scope: 'real', confirmReal: true })).toThrow(/already exists and was not installed by Synaptome/);
    expect(treeDigest(claudeRoot)).toBe(realBefore);
    expect(treeDigest(sandboxRoot())).toBe(staged);
  });

  it('two capabilities that map to the same host directory: the second is refused', async () => {
    upstream['other/release-notes'] = { ref: 'd'.repeat(40), files: [f('SKILL.md', skillMd('release-notes', 'A different publisher wrote this one.')), f('LICENSE', MIT)] };
    const a = await evaluateCandidate(sys, deps, await discover('acme/release-notes'));
    const before = hosts();
    const b = await evaluateCandidate(sys, deps, await discover('other/release-notes'));
    expect(b.capabilityId).not.toBe(a.capabilityId);
    expect(b.autoInstalled).toEqual([]); // not auto-promoted, so nothing was attempted
    approve(sys, deps, b.capabilityId!); // even approved, it may not take over another capability's directory
    expect(() => install(sys, deps, b.capabilityId!, { host: 'claude-code', scope: 'sandbox' })).toThrow(/not installed by Synaptome for this capability/);
    expect(hosts()).toBe(before);
  });

  it('a broken host layout (skills path is a file): fails cleanly and changes nothing', async () => {
    fs.mkdirSync(sandboxRoot(), { recursive: true });
    fs.writeFileSync(path.join(sandboxRoot(), 'skills'), 'not a directory');
    const before = hosts();
    const r = await evaluateCandidate(sys, deps, await discover('acme/release-notes'));
    expect(r.autoInstalled).toEqual([]);
    expect(() => install(sys, deps, r.capabilityId!, { host: 'claude-code', scope: 'sandbox' })).toThrow(/reverted/);
    expect(hosts()).toBe(before);
    expect(live(r.capabilityId!)).toEqual([]);
  });

  it('a change of publisher upstream holds the next version for a person, once', async () => {
    const id = await discover('acme/release-notes');
    await evaluateCandidate(sys, deps, id);
    owners['acme/release-notes'] = 'mallory'; // the repository was transferred; content unchanged
    const checked = await checkUpdates(sys, deps.connectors);
    expect(checked.find((r) => r.id === id)!.detail).toBe('publisher changed: acme/skills -> mallory/skills');
    expect(listNotifications(sys).some((n: any) => n.kind === 'capability.publisher-change')).toBe(true);
    // the new owner publishes a harmless text change: still held for a person
    upstream['acme/release-notes'] = { ref: 'b'.repeat(40), files: [f('SKILL.md', skillMd('release-notes', 'Second edition wording.')), f('LICENSE', MIT)] };
    await checkUpdates(sys, deps.connectors);
    const insp = await inspectUpdate(sys, deps, id);
    expect(insp.verdict).toBe('requires-approval');
    expect(insp.reasons).toContain('publisher changed: acme/skills -> mallory/skills');
    const r = await applyUpdate(sys, deps, id);
    expect(r.gate!.decision).toBe('needs-approval');
    expect(r.gate!.checks.find((c) => c.id === 'publisher')!.result).toBe('fail');
    expect(r.autoInstalled).toEqual([]);
    // a person accepts the new owner once; from then on the candidate follows the new name
    approve(sys, deps, 'acme.release-notes');
    expect(getCandidate(sys, id)).toMatchObject({ publisher: 'mallory', repo: 'mallory/skills' });
    expect(promotionPolicy(sys, deps).evaluate('acme.release-notes', 'claude-code').checks.find((c) => c.id === 'publisher')!.result).toBe('pass');
  });

  it('a lock left by a process that has exited is taken over', async () => {
    const r = await evaluateCandidate(sys, deps, await discover('acme/release-notes'));
    uninstall(sys, deps, r.autoInstalled[0]);
    const lockDir = path.join(sys.paths.home, 'locks');
    const file = path.join(lockDir, `${shortHash(path.resolve(sandboxTarget()).toLowerCase(), 16)}.lock`);
    fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 7, target: sandboxTarget(), at: new Date().toISOString() }));
    expect(install(sys, deps, r.capabilityId!, { host: 'claude-code', scope: 'sandbox' }).status).toBe('installed');
    expect(fs.readdirSync(lockDir)).toEqual([]);
  });
});

describe('install matrix: separate processes at the same instant', () => {
  async function race(capIds: string[]) {
    const startAt = Date.now() + 3000;
    const outs = await Promise.all(
      capIds.map((capId) =>
        run(process.execPath, ['--import', 'tsx', WORKER, sys.paths.home, claudeRoot, capId, String(startAt)], { cwd: ROOT, env: { ...process.env, TSX_TSCONFIG_PATH: path.join(ROOT, 'tsconfig.json'), NODE_NO_WARNINGS: '1' }, timeout: 60_000 }),
      ),
    );
    return outs.map((o) => JSON.parse(o.stdout));
  }

  it('four processes installing the same capability: one install, the same record for all, no corruption', async () => {
    const r = await evaluateCandidate(sys, deps, await discover('acme/release-notes'));
    uninstall(sys, deps, r.autoInstalled[0]);
    const results = await race([r.capabilityId!, r.capabilityId!, r.capabilityId!, r.capabilityId!]);
    expect(results.every((x) => x.ok)).toBe(true);
    expect(new Set(results.map((x) => x.id)).size).toBe(1);
    const [inst] = live(r.capabilityId!);
    expect(inst.id).toBe(results[0].id);
    expect(inst.treeHash).toBe(treeDigest(sandboxTarget()));
    expect(listInstallations(sys, { status: 'failed' })).toEqual([]);
    expect(sys.db.get<any>('PRAGMA integrity_check').integrity_check).toBe('ok');
    expect(fs.readdirSync(path.join(sys.paths.home, 'locks'))).toEqual([]);
  }, 90_000);

  it('two processes installing different capabilities into the same directory: exactly one wins', async () => {
    upstream['other/release-notes'] = { ref: 'd'.repeat(40), files: [f('SKILL.md', skillMd('release-notes', 'A different publisher wrote this one.')), f('LICENSE', MIT)] };
    const a = await evaluateCandidate(sys, deps, await discover('acme/release-notes'));
    uninstall(sys, deps, a.autoInstalled[0]);
    const b = await evaluateCandidate(sys, deps, await discover('other/release-notes'));
    for (const id of b.autoInstalled) uninstall(sys, deps, id);
    const results = await race([a.capabilityId!, b.capabilityId!]);
    expect(results.filter((x) => x.ok)).toHaveLength(1);
    expect(results.find((x) => !x.ok)).toMatchObject({ code: 'conflict' });
    const winner = results.findIndex((x) => x.ok) === 0 ? a.capabilityId! : b.capabilityId!;
    expect(JSON.parse(fs.readFileSync(path.join(sandboxTarget(), '.synaptome.json'), 'utf8')).capabilityId).toBe(winner);
    expect(sys.db.get<any>("SELECT COUNT(*) n FROM installations WHERE status='installed' AND scope='sandbox'").n).toBe(1);
  }, 90_000);
});
