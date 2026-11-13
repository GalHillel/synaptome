import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempSystem, upsertCapability } from '@synaptome/core';
import { listDependencies, storeDependencies } from '../src/index';

let sys: ReturnType<typeof tempSystem>;
beforeEach(() => {
  sys = tempSystem();
  upsertCapability(sys, { id: 'acme.server', name: 'server', description: 'd', kind: 'mcp-server' }, { reason: 'test', by: 'test' });
});
afterEach(() => sys.dispose());

describe('recorded dependencies', () => {
  it('stores what the current files declare, replaces it on the next version, and marks advisories as not checked', () => {
    const v1 = [{ path: 'package.json', content: JSON.stringify({ dependencies: { zod: '^3' }, engines: { node: '>=20' } }), size: 1 }];
    storeDependencies(sys, 'acme.server', v1, {});
    expect(listDependencies(sys, 'acme.server')).toEqual([
      { kind: 'package', name: 'npm:zod', spec: '^3', required: true, evidence: 'package.json dependencies', advisories: 'not checked' },
      { kind: 'runtime', name: 'node', spec: '>=20', required: true, evidence: 'package.json engines', advisories: 'not checked' },
    ]);
    const v2 = [{ path: 'package.json', content: JSON.stringify({ dependencies: { valibot: '^1' } }), size: 1 }];
    storeDependencies(sys, 'acme.server', v2, {});
    expect(listDependencies(sys, 'acme.server').map((d) => d.name)).toEqual(['npm:valibot']);
  });
});
