import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tempSystem } from '@synaptome/core';
import { type ServerHandle, createApi, startServer } from '../src/index';

// The local HTTP API under random and hostile requests (Phase 11, T-13/T-14/T-17). Seeded, so a failure reproduces.
// Commands that would reach the network or a model are left out: random arguments must not start a real scan.
const NETWORKED = new Set(['scan.run', 'sources.check', 'updates.check', 'updates.inspect', 'updates.apply', 'providers.test', 'forge.author', 'candidates.evaluate', 'queue.evaluateNext', 'workflows.start', 'workflows.resume', 'workflows.approve']);
function prng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const pick = <T,>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)];
const VALUES: unknown[] = ['', 'x', 'a.release-notes', '../../etc/passwd', 'C:\\Windows', '%00', '<script>', "' OR 1=1 --", '\u202e', 'é😀', 'a'.repeat(5000), -1, 0, 1, 1e308, NaN, true, false, null, [], [1, 'two'], {}, { nested: { deep: [null] } }];
function randomArgs(r: () => number) {
  const keys = ['id', 'q', 'key', 'value', 'limit', 'task', 'step', 'approve', 'reason', 'host', 'real', 'confirm', 'force', 'content', 'after', 'enabled', 'scansPerDay', 'gap', 'name', 'statuses', 'all', 'full', 'workflow'];
  const o: Record<string, unknown> = {};
  for (let i = 0, n = Math.floor(r() * 5); i < n; i++) o[pick(r, keys)] = pick(r, VALUES);
  return o;
}
function raw(s: ServerHandle, method: string, p: string, headers: Record<string, string>, body?: string) {
  return new Promise<{ status: number; body: string }>((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, path: p, method, headers }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    req.on('error', (e) => resolve({ status: -1, body: String(e) }));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

let sys: ReturnType<typeof tempSystem>;
let server: ServerHandle;
let claudeRoot: string;
let commands: string[];
beforeAll(async () => {
  sys = tempSystem();
  claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synaptome-claude-'));
  server = await startServer(sys, { port: 0, claudeRoot, assets: () => ({ html: '<meta name="t" content="__SYNAPTOME_TOKEN__">', js: '', css: '' }) });
  commands = Object.keys(createApi(sys, { claudeRoot }).commands).filter((c) => !NETWORKED.has(c));
});
afterAll(async () => {
  await server.close();
  sys.dispose();
  fs.rmSync(claudeRoot, { recursive: true, force: true });
});

describe('HTTP API fuzzing', () => {
  it('600 random requests without valid credentials: none succeeds, the server never fails and keeps answering', async () => {
    const r = prng(11);
    const hosts = [`127.0.0.1:${server.port}`, `localhost:${server.port}`, 'evil.example', `127.0.0.1:${server.port + 1}`, '', 'localhost'];
    const origins = [undefined, 'http://evil.example', 'null', `http://127.0.0.1:${server.port}`];
    for (let i = 0; i < 600; i++) {
      const name = pick(r, [...commands, 'nope', '../x', 'system.overview/../x', '%2e%2e', 'a'.repeat(300)]);
      const headers: Record<string, string> = { host: pick(r, hosts), 'content-type': pick(r, ['application/json', 'text/plain', 'multipart/form-data']) };
      const o = pick(r, origins);
      if (o) headers.origin = o;
      const token = pick(r, ['', 'wrong', server.token.slice(0, -1) + 'x', server.token.toUpperCase()]);
      if (token) headers['x-synaptome-token'] = token;
      const body = r() < 0.2 ? '{not json' : JSON.stringify(randomArgs(r));
      const res = await raw(server, pick(r, ['POST', 'GET', 'PUT', 'DELETE', 'OPTIONS']), pick(r, [`/api/call/${name}`, `/api/${name}`, `/${name}`, '/api/events', `/api/call/${name}?token=${server.token}`]), headers, body);
      // A request without a Host header is rejected by Node's HTTP parser itself (HTTP/1.1 requires one): the connection
      // is reset before the application sees it. That is a refusal too, and only allowed in that case.
      if (res.status === -1 && headers.host === '') continue;
      expect(res.status, `request ${i}: ${name} ${JSON.stringify(headers)} -> ${res.body.slice(0, 200)}`).toBeGreaterThanOrEqual(300);
      expect(res.status, `request ${i}: ${name} ${res.body.slice(0, 200)}`).toBeLessThan(500);
    }
    expect((await raw(server, 'POST', '/api/call/system.overview', { host: `127.0.0.1:${server.port}`, 'content-type': 'application/json', 'x-synaptome-token': server.token }, '{}')).status).toBe(200);
  }, 60_000);

  it('random arguments to every local command with valid credentials: refused with a 4xx or answered, never a server error', async () => {
    const r = prng(12);
    const failures: string[] = [];
    for (const name of commands) {
      for (let i = 0; i < 12; i++) {
        const args = randomArgs(r);
        const res = await raw(server, 'POST', `/api/call/${name}`, { host: `127.0.0.1:${server.port}`, 'content-type': 'application/json', 'x-synaptome-token': server.token }, JSON.stringify(args));
        if (res.status >= 500 || res.status < 0) failures.push(`${name} ${JSON.stringify(args).slice(0, 160)} -> ${res.status} ${res.body.slice(0, 160)}`);
      }
    }
    expect(failures).toEqual([]);
    expect((await raw(server, 'POST', '/api/call/system.overview', { host: `127.0.0.1:${server.port}`, 'content-type': 'application/json', 'x-synaptome-token': server.token }, '{}')).status).toBe(200);
  }, 120_000);
});
