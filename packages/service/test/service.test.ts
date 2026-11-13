import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emit, tempSystem, upsertCapability, writeSnapshot } from '@synaptome/core';
import { ApiError, type ServerHandle, createApi, startServer } from '../src/index';

let sys: ReturnType<typeof tempSystem>;
let claudeRoot: string;
let server: ServerHandle | undefined;

function seed(id: string, status: 'approved' | 'registered' = 'approved') {
  const files = [{ path: 'SKILL.md', content: `---\nname: ${id.split('.')[1]}\ndescription: Write release notes and changelog documentation from merged changes\nlicense: MIT\n---\n# Notes\nLead with user impact.`, size: 1 }];
  upsertCapability(sys, { id, name: id.split('.')[1], description: 'Write release notes and changelog documentation from merged changes', kind: 'skill', domain: 'docs', tags: ['changelog', 'documentation'], entryFile: 'SKILL.md', license: { spdx: 'MIT', compatible: 'yes', evidence: 'test' }, provenance: { verified: true, method: 'test' }, security: { tier: 'A' } }, { status, ...writeSnapshot(sys, id, files), body: files[0].content });
}

beforeEach(() => {
  sys = tempSystem();
  claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synaptome-claude-'));
  fs.mkdirSync(path.join(claudeRoot, 'skills'));
  seed('a.release-notes');
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  sys.dispose();
  fs.rmSync(claudeRoot, { recursive: true, force: true });
});

describe('command surface', () => {
  it('serves queries and actions through one call interface', async () => {
    const api = createApi(sys, { claudeRoot, origin: 'test' });
    expect((await api.call('system.overview')).capabilities.total).toBe(1);
    expect((await api.call('capabilities.list', { q: 'changelog' })).items[0].id).toBe('a.release-notes');
    expect((await api.call('capabilities.get', { id: 'a.release-notes', content: true })).entry.content).toContain('Lead with user impact');
    const inst = await api.call('capabilities.install', { id: 'a.release-notes' });
    expect(inst).toMatchObject({ scope: 'sandbox', status: 'installed' });
    expect((await api.call('queue.get')).installations).toHaveLength(1);
    const routed = await api.call('routing.route', { task: 'Write the changelog and release notes documentation for version 2' });
    expect(routed.selected[0].capabilityId).toBe('a.release-notes');
    expect((await api.call('routing.decision', { id: routed.id })).explanation).toMatch(/Selected:/);
    expect((await api.call('installations.rollback', { id: inst.id })).status).toBe('rolled_back');
    expect((await api.call('system.settings')).policy.autoInstallThreshold).toBe(88);
    expect((await api.call('settings.set', { key: 'ui.theme', value: 'dark' })).ui.theme).toBe('dark');
    expect((await api.call('system.diagnostics')).find((d: any) => d.id === 'schema').status).toBe('ok');
    expect(Object.values(api.commands).every((c) => c.kind === 'query' || c.kind === 'action')).toBe(true);
  });

  it('maps domain failures to typed errors with hints', async () => {
    const api = createApi(sys, { claudeRoot });
    seed('a.pending', 'registered');
    await expect(api.call('nope')).rejects.toMatchObject({ status: 404, code: 'unknown-command' });
    await expect(api.call('capabilities.get', { id: 'missing' })).rejects.toMatchObject({ status: 404 });
    await expect(api.call('capabilities.install', { id: 'a.pending' })).rejects.toMatchObject({ status: 409, code: 'not-approved' });
    await expect(api.call('capabilities.install', { id: 'a.release-notes', real: true })).rejects.toMatchObject({ code: 'needs-confirmation' });
    await expect(api.call('settings.set', { key: 'policy.nope', value: 1 })).rejects.toBeInstanceOf(ApiError);
    await expect(api.call('scan.run', { mode: 'need' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('local server', () => {
  const post = (s: ServerHandle, name: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${s.url}api/call/${name}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-synaptome-token': s.token, ...headers } });

  it('requires the session token, rejects foreign origins and serves the page with the token injected', async () => {
    server = await startServer(sys, { port: 0, claudeRoot, assets: () => ({ html: '<meta name="t" content="__SYNAPTOME_TOKEN__">', js: 'console.log(1)', css: 'body{}' }) });
    expect(await (await fetch(server.url)).text()).toContain(server.token);
    expect((await fetch(`${server.url}app.js`)).headers.get('content-type')).toMatch(/javascript/);
    expect((await post(server, 'system.overview', {}, { 'x-synaptome-token': 'wrong' })).status).toBe(401);
    expect((await post(server, 'system.overview', {}, { origin: 'https://evil.example' })).status).toBe(403);
    const ok = await (await post(server, 'system.overview', {})).json();
    expect(ok).toMatchObject({ ok: true, data: { capabilities: { total: 1 } } });
    const bad = await post(server, 'capabilities.get', { id: 'missing' });
    expect(bad.status).toBe(404);
    expect((await bad.json()).error.code).toBe('not-found');
    expect((await fetch(`${server.url}api/call/system.overview`)).status).toBe(404); // GET is not a command route
  });

  const stream = (s: ServerHandle, headers: Record<string, string> = {}, query = '') => fetch(`${s.url}api/events/stream${query}`, { headers });
  const rawGet = (s: ServerHandle, pathname: string, headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: s.port, path: pathname, method: 'GET', headers }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });

  it('streams events over a header-authenticated request and resumes after a given id', async () => {
    server = await startServer(sys, { port: 0, claudeRoot });
    const first = emit(sys.db, 'test.before', 'x');
    emit(sys.db, 'test.missed', 'x');
    const res = await stream(server, { 'x-synaptome-token': server.token, 'last-event-id': String(first) });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    let text = '';
    setTimeout(() => emit(sys.db, 'test.live', 'x'), 150);
    const deadline = Date.now() + 5000;
    while (!text.includes('test.live') && Date.now() < deadline) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(text).toContain('test.missed'); // replayed after the last seen id
    expect(text).toContain('test.live'); // delivered live
    expect(text).not.toContain('test.before');
  });

  it('never accepts a credential in the URL and refuses every unauthenticated or cross-site stream request', async () => {
    server = await startServer(sys, { port: 0, claudeRoot });
    const good = { 'x-synaptome-token': server.token };
    expect((await stream(server)).status).toBe(401); // no credential
    expect((await stream(server, { 'x-synaptome-token': 'wrong' })).status).toBe(401);
    expect((await stream(server, { 'x-synaptome-token': server.token.slice(0, -1) + 'x' })).status).toBe(401);
    expect((await stream(server, {}, `?token=${server.token}`)).status).toBe(400); // the old URL form, even with the right value
    expect((await stream(server, good, `?token=${server.token}`)).status).toBe(400); // refused even alongside a valid header
    expect((await stream(server, { ...good, cookie: `token=${server.token}` })).status).toBe(200); // cookies are ignored, not required
    expect((await stream(server, { cookie: `token=${server.token}; x-synaptome-token=${server.token}` })).status).toBe(401); // a cookie alone is never a credential
    expect((await stream(server, { ...good, origin: 'https://evil.example' })).status).toBe(403);
    expect((await stream(server, { ...good, origin: `http://localhost:${server.port + 1}` })).status).toBe(403); // another local port is another origin
    expect((await stream(server, { ...good, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await stream(server, { ...good, 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect(await rawGet(server, '/api/events/stream', { ...good, host: 'evil.example' })).toBe(403); // DNS rebinding
    expect(await rawGet(server, '/api/events/stream', { ...good, host: `127.0.0.1:${server.port}` })).toBe(200);
  });

  it('applies the same rules to commands and binds to loopback only', async () => {
    server = await startServer(sys, { port: 0, claudeRoot });
    expect((await post(server, 'system.overview', {}, { 'x-synaptome-token': '' })).status).toBe(401);
    expect((await post(server, 'system.overview', {}, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await fetch(`${server.url}api/call/system.overview?token=${server.token}`, { method: 'POST', body: '{}' })).status).toBe(400);
    expect(new URL(server.url).hostname).toBe('127.0.0.1');
    expect(server.url).not.toContain(server.token);
    const page = await (await fetch(server.url)).text();
    expect(page).not.toMatch(/[?&]token=/);
  });

  it('refuses every registered command, old and new, without the token, from another origin or under another Host name', async () => {
    server = await startServer(sys, { port: 0, claudeRoot });
    const names = Object.keys(createApi(sys, { claudeRoot }).commands);
    expect(names).toEqual(expect.arrayContaining(['graph.get', 'evalsets.list', 'workflows.start', 'providers.test', 'agents.list', 'sources.list', 'notifications.list']));
    const rawPost = (name: string, headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: server!.port, path: `/api/call/${name}`, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));
        req.on('error', reject);
        req.end('{}');
      });
    const events = () => sys.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events')!.n;
    const before = events();
    for (const name of names) {
      expect([name, (await post(server, name, {}, { 'x-synaptome-token': '' })).status]).toEqual([name, 401]);
      expect([name, (await post(server, name, {}, { origin: 'https://evil.example' })).status]).toEqual([name, 403]);
      expect([name, await rawPost(name, { 'x-synaptome-token': server.token, host: 'evil.example' })]).toEqual([name, 403]);
    }
    expect(events()).toBe(before); // nothing ran
  });
});
