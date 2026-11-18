import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { fakeClaudeRoot, syn, tempDir } from './harness';

// The prompt hook must never get in the way of the host; routing must pick what fits; source status must be truthful.
// `it.fails` marks a confirmed defect (see bridge.test.ts for the convention).

const hookPayload = (prompt: string) => JSON.stringify({ session_id: 'bb-session', hook_event_name: 'UserPromptSubmit', cwd: process.cwd(), prompt });

describe('prompt hook', () => {
  it('stays silent and exits 0 for a trivial prompt', () => {
    const home = tempDir('home');
    const r = syn(home, ['hook', 'user-prompt'], { input: hookPayload('thanks') });
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
  });

  it('H4 fixed: exits 0 and prints nothing when the data was written by a newer version', () => {
    const home = tempDir('home');
    expect(syn(home, ['status']).code).toBe(0);
    const db = new DatabaseSync(path.join(home, 'synaptome.db'));
    db.exec("INSERT INTO schema_migrations (version, name, applied_at) VALUES (999, 'from the future', '2030-01-01')");
    db.close();
    const r = syn(home, ['hook', 'user-prompt'], { input: hookPayload('Write integration tests for the payment webhook handler') });
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
  });

  it('never creates a home: with none, it exits 0, prints nothing and leaves the folder absent', () => {
    const home = path.join(tempDir('parent'), 'not-there');
    const r = syn(home, ['hook', 'user-prompt'], { input: hookPayload('Write integration tests for the payment webhook handler') });
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
    expect(fs.existsSync(home)).toBe(false);
  });

  it('exits 0 for malformed input and for an event it does not know', () => {
    const home = tempDir('home');
    expect(syn(home, ['status']).code).toBe(0);
    expect(syn(home, ['hook', 'user-prompt'], { input: 'not json' })).toMatchObject({ code: 0, out: '' });
    expect(syn(home, ['hook', 'session-start'], { input: '{}' })).toMatchObject({ code: 0, out: '' });
  });
});

describe('source status is truthful', () => {
  it('S1 fixed: a source that never completed a scan says so, instead of only a health word', () => {
    const home = tempDir('home');
    const r = syn(home, ['--json', 'sources']);
    expect(r.code, r.err).toBe(0);
    expect(r.json.length).toBeGreaterThan(0);
    for (const s of r.json) expect(s.scanState, s.id).toBe('never-scanned');
  });
});

// Permanent regression case from the owner's real Claude Code test (Claude Code 2.1.323, 2026-11-13): the task below
// selected a client-SDK generator and a generic clean-code skill, excluded the JavaScript testing skill because the
// task said "TypeScript", and missed the Node.js backend skill. Descriptions here are written for this test.
const SKILLS = [
  { name: 'api-sdk-generator', description: 'Generates client SDKs and API wrapper libraries for an existing REST API: request and response models and language-specific client usage. Use when asked to generate an SDK or a client library.' },
  { name: 'clean-code', description: 'Readable, maintainable code: naming, small functions, clean error handling. Use for code review, naming conventions, code smells and refactoring for readability.' },
  { name: 'javascript-testing-patterns', description: 'Testing strategies with Jest, Vitest and Testing Library: unit, integration and end-to-end tests, mocking and fixtures. Use when writing JavaScript or TypeScript tests or setting up test infrastructure.' },
  { name: 'nodejs-backend-patterns', description: 'Production Node.js backend services with Express or Fastify: middleware, error handling, validation, authentication, database access and API design. Use when creating Node.js servers, REST APIs or microservices.' },
  { name: 'typescript-advanced-types', description: 'Advanced TypeScript types: generics, conditional and mapped types, utility types. Use when designing complex type-safe abstractions.' },
  { name: 'api-design-principles', description: 'REST and GraphQL API design: resources, status codes, versioning, pagination and error formats for intuitive, maintainable APIs.' },
  { name: 'python-fastapi-service', description: 'Build Python web services with FastAPI and Pydantic: routing, dependency injection, validation and async database access.' },
  { name: 'react-component-patterns', description: 'React component design: hooks, composition, state management and accessibility for front-end interfaces.' },
  { name: 'terraform-modules', description: 'Write reusable Terraform modules for cloud infrastructure: variables, outputs, state and provider configuration.' },
  { name: 'postgres-query-tuning', description: 'Diagnose slow PostgreSQL queries with EXPLAIN, choose indexes and rewrite queries for performance.' },
  { name: 'docker-compose-setup', description: 'Containerise applications with Dockerfiles and docker compose for local development environments.' },
  { name: 'rust-cli-builder', description: 'Build command-line tools in Rust with clap, error handling and packaging for release.' },
  { name: 'kubernetes-deployments', description: 'Deploy services to Kubernetes: manifests, Helm charts, probes, autoscaling and rollouts.' },
  { name: 'playwright-e2e', description: 'Browser end-to-end tests with Playwright: locators, fixtures, tracing and flaky-test diagnosis.' },
  { name: 'git-release-notes', description: 'Write release notes and changelogs from merged pull requests and commit history.' },
  { name: 'security-code-review', description: 'Review code for security vulnerabilities: injection, authentication flaws, secrets and unsafe deserialisation.' },
];
const REST_TASK = 'Create a small TypeScript REST API with validation, error handling, and unit tests. Explain the architecture and verify the result.';

function routed(task: string) {
  const home = tempDir('home');
  const claudeRoot = fakeClaudeRoot(SKILLS);
  const inv = syn(home, ['--json', 'inventory'], { claudeRoot });
  expect(inv.code, inv.err).toBe(0);
  const r = syn(home, ['--json', 'route', task], { claudeRoot });
  expect(r.code, r.err).toBe(0);
  return (r.json.selected as any[]).map((s) => String(s.capabilityId).split('.').pop());
}

describe('routing regression: the TypeScript REST API task', () => {
  // Observed during M0: with fewer skills in the registry the SDK generator *is* selected ("matched on api with rest"),
  // and the testing skill is excluded as "built for javascript, which the task does not mention".
  it.fails('KNOWN DEFECT R1: offers the testing and Node.js backend skills, not the client-SDK generator', () => {
    const picked = routed(REST_TASK);
    expect(picked).toContain('javascript-testing-patterns');
    expect(picked).toContain('nodejs-backend-patterns');
    expect(picked).not.toContain('api-sdk-generator');
  });

  it.fails('KNOWN DEFECT R1 (small registry): the client-SDK generator is not chosen for building a server', () => {
    const home = tempDir('home');
    const claudeRoot = fakeClaudeRoot(SKILLS.filter((s) => ['api-sdk-generator', 'clean-code', 'javascript-testing-patterns', 'nodejs-backend-patterns'].includes(s.name)));
    syn(home, ['--json', 'inventory'], { claudeRoot });
    const r = syn(home, ['--json', 'route', REST_TASK], { claudeRoot });
    expect((r.json.selected as any[]).map((s) => String(s.capabilityId).split('.').pop())).not.toContain('api-sdk-generator');
  });
});
