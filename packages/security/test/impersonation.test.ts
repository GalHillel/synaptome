import { describe, expect, it } from 'vitest';
import { getSettings, tempSystem } from '@synaptome/core';
import { auditPackage } from '../src/index';

// Backported from D-062 (0.2.1 hotfix): official trust follows who holds the code, never a name a listing states.
const MIT = 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software';
const skill = `---\nname: notes\ndescription: Write clear release notes from merged changes. Use when preparing a release.\n---\n# notes\n${'Plain guidance. '.repeat(30)}`;
const files = [{ path: 'SKILL.md', content: skill, size: skill.length }, { path: 'LICENSE', content: MIT, size: MIT.length }];

describe('publisher impersonation (0.2.1)', () => {
  it('a listing that says "by anthropics" for code someone else holds is not official; the real holder is', () => {
    const sys = tempSystem();
    try {
      const settings = getSettings(sys.db);
      expect(auditPackage({ kind: 'skill', files, publisher: 'anthropics', codeHolder: 'evil', provenanceVerified: true, settings }).trust).not.toBe('OFFICIAL_VERIFIED');
      expect(auditPackage({ kind: 'skill', files, publisher: 'anthropics', codeHolder: null, provenanceVerified: true, settings }).trust).not.toBe('OFFICIAL_VERIFIED');
      expect(auditPackage({ kind: 'skill', files, publisher: 'anthropics', codeHolder: 'anthropics', provenanceVerified: true, settings }).trust).toBe('OFFICIAL_VERIFIED');
      // A deny rule applies to the holder too.
      const denied = { ...settings, policy: { ...settings.policy, denyPublishers: ['evil'] } };
      expect(auditPackage({ kind: 'skill', files, publisher: 'acme', codeHolder: 'evil', provenanceVerified: true, settings: denied }).trust).toBe('BLOCKED');
    } finally {
      sys.dispose();
    }
  });
});
