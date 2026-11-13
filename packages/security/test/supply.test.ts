import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type FetchedFile } from '@synaptome/core';
import { auditPackage, extractDependencies, isSpdxExpression, spdxCompatible } from '../src/index';

const f = (path: string, content: string): FetchedFile => ({ path, content, size: content.length });
const settings = () => structuredClone(DEFAULT_SETTINGS) as any;
const allowed = DEFAULT_SETTINGS.policy.allowedLicenses as string[];

describe('licence expressions', () => {
  it('recognises SPDX expressions and judges them against the allow list', () => {
    expect(isSpdxExpression('MIT OR Apache-2.0')).toBe(true);
    expect(isSpdxExpression('(MIT AND BSD-3-Clause)')).toBe(true);
    expect(isSpdxExpression('GPL-2.0-only WITH Classpath-exception-2.0')).toBe(true);
    expect(isSpdxExpression('Proprietary OR MIT')).toBe(false);
    expect(spdxCompatible('MIT OR GPL-3.0', allowed)).toBe(true); // you may choose MIT
    expect(spdxCompatible('MIT AND GPL-3.0', allowed)).toBe(false); // both apply
    expect(spdxCompatible('(Apache-2.0 AND MIT) OR AGPL-3.0', allowed)).toBe(true);
    expect(spdxCompatible('AGPL-3.0', allowed)).toBe(false);
  });

  it('reads the licence from front-matter expressions and from licence files with suffixes', () => {
    const skill = (fm: string, extra: FetchedFile[] = []) => auditPackage({ kind: 'skill', settings: settings(), files: [f('SKILL.md', `---\nname: x\ndescription: A skill with a long enough description to route on.\n${fm}---\nbody`), ...extra] });
    expect(skill('license: MIT OR Apache-2.0\n').licence).toMatchObject({ spdx: 'MIT OR Apache-2.0', compatible: 'yes' });
    expect(skill('license: MIT AND AGPL-3.0\n').licence).toMatchObject({ compatible: 'no' });
    const mit = 'Permission is hereby granted, free of charge, to any person obtaining a copy of this software';
    expect(skill('', [f('LICENSE-MIT', mit)]).licence).toMatchObject({ spdx: 'MIT', compatible: 'yes' });
    expect(skill('', [f('LICENSE.md', mit)]).licence.evidence).toMatch(/LICENSE\.md/);
    expect(skill('', [f('LICENSE.txt', 'Boost Software License - Version 1.0 - August 17th, 2003')]).licence).toMatchObject({ spdx: 'BSL-1.0', compatible: 'no' });
  });
});

describe('dependency extraction', () => {
  it('reads npm, Python and MCP manifests and front-matter, without resolving anything', () => {
    const deps = extractDependencies(
      [
        f('package.json', JSON.stringify({ dependencies: { zod: '^3.23.0' }, peerDependencies: { react: '>=18' }, peerDependenciesMeta: { react: { optional: true } }, engines: { node: '>=20' } })),
        f('requirements.txt', 'requests>=2.31  # http\n# comment\n-r other.txt\nuvicorn[standard]==0.30.0\n'),
        f('pyproject.toml', '[project]\nname = "x"\nrequires-python = ">=3.11"\ndependencies = [\n  "httpx>=0.27",\n  "pydantic[email]",\n]\n'),
        f('server.json', JSON.stringify({ name: 'w', packages: [{ registryType: 'npm', identifier: '@acme/weather', version: '1.2.0' }], remotes: [{ type: 'streamable-http', url: 'https://mcp.example.net/v1' }] })),
        f('.upstream/package.json', JSON.stringify({ dependencies: { ignored: '1' } })),
      ],
      { requires: ['gh', 'acme.formatter'] },
    );
    const by = (name: string) => deps.find((d) => d.name === name);
    expect(by('npm:zod')).toMatchObject({ kind: 'package', spec: '^3.23.0', required: true });
    expect(by('npm:react')).toMatchObject({ required: false });
    expect(by('node')).toMatchObject({ kind: 'runtime', spec: '>=20' });
    expect(by('pypi:requests')).toMatchObject({ spec: '>=2.31' });
    expect(by('pypi:uvicorn')).toMatchObject({ spec: '==0.30.0' });
    expect(by('pypi:httpx')).toMatchObject({ spec: '>=0.27' });
    expect(by('pypi:pydantic')).toBeTruthy();
    expect(by('python')).toMatchObject({ kind: 'runtime', spec: '>=3.11' });
    expect(by('npm:@acme/weather')).toMatchObject({ spec: '1.2.0' });
    expect(by('mcp.example.net')).toMatchObject({ kind: 'service' });
    expect(by('gh')).toMatchObject({ kind: 'tool' });
    expect(by('acme.formatter')).toMatchObject({ kind: 'capability' });
    expect(by('npm:ignored')).toBeUndefined();
    expect(deps.some((d) => d.name.startsWith('pypi:-r'))).toBe(false);
  });

  it('tolerates malformed manifests', () => {
    expect(extractDependencies([f('package.json', '{ not json'), f('server.json', '')])).toEqual([]);
  });
});

describe('declared versus needed permissions', () => {
  it('reports a skill whose allowed tools leave out the shell it evidently uses', () => {
    const r = auditPackage({ kind: 'skill', settings: settings(), files: [f('SKILL.md', '---\nname: setup\ndescription: Sets up the project tooling for a new contributor quickly.\nallowed-tools: Read, Edit\n---\n```bash\nnpm install -g pnpm\n```'), f('scripts/setup.sh', 'pnpm install')] });
    expect(r.findings.find((x) => x.id === 'perm-undeclared')).toMatchObject({ severity: 'medium' });
    const honest = auditPackage({ kind: 'skill', settings: settings(), files: [f('SKILL.md', '---\nname: setup\ndescription: Sets up the project tooling for a new contributor quickly.\nallowed-tools: Read, Edit, Bash(pnpm:*)\n---\n```bash\nnpm install -g pnpm\n```')] });
    expect(honest.findings.some((x) => x.id === 'perm-undeclared')).toBe(false);
  });
});
