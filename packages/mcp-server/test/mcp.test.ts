import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempSystem, upsertCapability, writeSnapshot } from '@synaptome/core';
import { createMcpHandler } from '../src/index';

let sys: ReturnType<typeof tempSystem>;
let handle: ReturnType<typeof createMcpHandler>;
let id = 0;
const call = (method: string, params?: unknown) => handle({ jsonrpc: '2.0', id: ++id, method, params }) as any;
const tool = (name: string, args: unknown) => call('tools/call', { name, arguments: args }).result;

beforeEach(() => {
  sys = tempSystem();
  const files = [{ path: 'SKILL.md', content: '---\nname: release-notes\ndescription: Write release notes and changelog documentation from merged changes\n---\n# Release notes\nLead with user impact.', size: 1 }];
  upsertCapability(sys, { id: 'a.release-notes', name: 'release-notes', description: 'Write release notes and changelog documentation from merged changes', kind: 'skill', domain: 'docs', tags: ['changelog', 'documentation', 'writing'], entryFile: 'SKILL.md' }, { status: 'approved', ...writeSnapshot(sys, 'a.release-notes', files), body: files[0].content });
  upsertCapability(sys, { id: 'a.blocked', name: 'blocked', description: 'x', kind: 'skill' }, { status: 'blocked' });
  handle = createMcpHandler(sys);
});
afterEach(() => sys.dispose());

describe('MCP server', () => {
  it('speaks the protocol: initialize, tools/list, ping, notifications, unknown methods', () => {
    const init = call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'synaptome' }, capabilities: { tools: {} } });
    expect(handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(call('tools/list').result.tools.map((t: any) => t.name)).toEqual(['route_task', 'get_capability', 'search_capabilities', 'record_outcome']);
    expect(call('ping').result).toEqual({});
    expect(call('nope').error.code).toBe(-32601);
    expect(call('tools/call', { name: 'nope', arguments: {} }).error.code).toBe(-32602);
    expect((handle({ foo: 1 } as any) as any).error.code).toBe(-32600);
  });

  it('routes a task, serves the selected capability on demand and records the outcome', () => {
    const routed = JSON.parse(tool('route_task', { task: 'Write the changelog and release notes documentation for version 2.3 from the merged changes' }).content[0].text);
    expect(routed.selected[0].capability_id).toBe('a.release-notes');
    const got = tool('get_capability', { capability_id: 'a.release-notes', decision_id: routed.decision_id });
    expect(got.isError).toBe(false);
    expect(got.content[0].text).toContain('Lead with user impact.');
    expect(got.content[0].text).toMatch(/served by Synaptome/);
    expect(JSON.parse(tool('record_outcome', { decision_id: routed.decision_id, outcome: 'success', detail: 'notes written' }).content[0].text)).toEqual({ recorded: true, activations_updated: 1 });
    const row = sys.db.get<any>('SELECT * FROM activations');
    expect(row).toMatchObject({ capability_id: 'a.release-notes', host: 'claude-code', outcome: 'success', decision_id: routed.decision_id });
    expect(sys.db.get<any>('SELECT origin FROM route_decisions').origin).toBe('mcp');
  });

  it('returns tool errors (not protocol errors) for bad input and refuses blocked capabilities', () => {
    expect(tool('route_task', {}).isError).toBe(true);
    expect(tool('get_capability', { capability_id: 'a.blocked' }).isError).toBe(true);
    expect(tool('get_capability', { capability_id: 'a.blocked' }).content[0].text).toMatch(/blocked by the security audit/);
    expect(tool('record_outcome', { decision_id: 1, outcome: 'great' }).isError).toBe(true);
    expect(sys.db.get<{ n: number }>('SELECT COUNT(*) n FROM activations')!.n).toBe(0);
  });

  it('searches the registry without returning instruction bodies', () => {
    const r = JSON.parse(tool('search_capabilities', { query: 'changelog' }).content[0].text);
    expect(r.items[0].capability_id).toBe('a.release-notes');
    expect(JSON.stringify(r)).not.toContain('Lead with user impact');
  });
});
