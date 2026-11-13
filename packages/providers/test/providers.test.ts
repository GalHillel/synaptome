import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ModelProvider, setSetting, tempSystem } from '@synaptome/core';
import { claudeCliProvider } from '@synaptome/evaluation';
import { anthropicProvider, buildProviders, checkProvider, costOf, geminiProvider, openAICompatibleProvider, providerStatus, selectProvider } from '../src/index';

let sys: ReturnType<typeof tempSystem>;
beforeEach(() => {
  sys = tempSystem();
});
afterEach(() => sys.dispose());

const SECRET = 'sk-test-0123456789abcdef';
/** A fake HTTP transport that records each request and answers with a fixed body. */
function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const f = (async (url: any, init: any) => {
    calls.push({ url: String(url), headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : null });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { f, calls };
}

describe('provider protocols (contract tests against a fake transport)', () => {
  it('Anthropic: messages request shape, text and usage; key in a header only', async () => {
    const { f, calls } = fakeFetch(200, { id: 'm1', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use' }], usage: { input_tokens: 12, output_tokens: 3 } });
    const p = anthropicProvider({ model: 'claude-sonnet-5-5', env: { ANTHROPIC_API_KEY: SECRET }, fetch: f });
    const r = await p.complete({ prompt: 'hi', system: 'be brief', maxTokens: 50 });
    expect(r).toMatchObject({ ok: true, text: 'Hello', usage: { inputTokens: 12, outputTokens: 3 } });
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0].headers).toMatchObject({ 'x-api-key': SECRET, 'anthropic-version': '2023-06-01' });
    expect(calls[0].body).toEqual({ model: 'claude-sonnet-5-5', max_tokens: 50, system: 'be brief', messages: [{ role: 'user', content: 'hi' }] });
  });

  it('OpenAI-compatible: chat-completions shape; works without a key for a local server', async () => {
    const { f, calls } = fakeFetch(200, { model: 'llama3', choices: [{ message: { content: 'Hi there' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2 } });
    const p = openAICompatibleProvider({ id: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1/', model: 'llama3', env: {}, fetch: f });
    const r = await p.complete({ prompt: 'hi', system: 'sys' });
    expect(r).toMatchObject({ ok: true, text: 'Hi there', usage: { inputTokens: 7, outputTokens: 2 } });
    expect(calls[0].url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[0].body.messages).toEqual([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]);
  });

  it('Gemini: generateContent shape; key in a header, not the URL', async () => {
    const { f, calls } = fakeFetch(200, { candidates: [{ content: { parts: [{ text: 'A' }, { text: 'B' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 } });
    const p = geminiProvider({ model: 'gemini-test', env: { GEMINI_API_KEY: SECRET }, fetch: f });
    const r = await p.complete({ prompt: 'hi' });
    expect(r).toMatchObject({ ok: true, text: 'AB', usage: { inputTokens: 4, outputTokens: 2 } });
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
    expect(calls[0].url).not.toContain(SECRET);
    expect(calls[0].headers['x-goog-api-key']).toBe(SECRET);
  });

  it('never puts a credential into an error, even when the server echoes it back', async () => {
    const { f } = fakeFetch(401, { error: { message: `invalid key ${SECRET}` } });
    const r = await anthropicProvider({ model: 'm', env: { ANTHROPIC_API_KEY: SECRET }, fetch: f }).complete({ prompt: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('HTTP 401: invalid key [redacted]');
  });

  it('reports a missing credential or model as unavailable, without calling anything', async () => {
    const { f, calls } = fakeFetch(200, {});
    expect(await anthropicProvider({ model: 'm', env: {}, fetch: f }).availability()).toMatchObject({ available: false, detail: 'set ANTHROPIC_API_KEY to use it' });
    expect(await openAICompatibleProvider({ id: 'openai', baseUrl: 'https://x.test/v1', model: null, env: { OPENAI_API_KEY: SECRET }, fetch: f }).availability()).toMatchObject({ available: false, detail: expect.stringMatching(/no model configured/) });
    expect(await geminiProvider({ model: 'g', env: {}, fetch: f }).complete({ prompt: 'x' })).toMatchObject({ ok: false, error: 'no credential (GEMINI_API_KEY)' });
    expect(calls).toEqual([]);
  });
});

describe('headless Claude Code arguments', () => {
  it('quotes tool scopes that contain spaces, so the shell cannot split them (found in the Phase 6 real run)', async () => {
    const seen: string[][] = [];
    const exec = (async (_bin: string, args: string[]) => (seen.push(args), { code: 0, stdout: JSON.stringify({ result: 'ok', is_error: false }), stderr: '', timedOut: false })) as any;
    await claudeCliProvider({ exec }).complete({ prompt: 'x', extraArgs: ['--allowedTools', 'Read', 'Bash(node --test:*)'] });
    expect(seen[0]).toEqual(expect.arrayContaining(['--allowedTools', 'Read', '"Bash(node --test:*)"']));
    expect(seen[0]).not.toContain('--test:*)');
  });

  it('creates its working folder only when a model call is made (building the provider list leaves nothing behind)', async () => {
    const made = vi.spyOn(fs, 'mkdtempSync');
    const before = made.mock.calls.length;
    const p = claudeCliProvider({ exec: (async () => ({ code: 0, stdout: JSON.stringify({ result: 'ok', is_error: false }), stderr: '', timedOut: false })) as any });
    expect(made.mock.calls.length).toBe(before);
    await p.complete({ prompt: 'x' });
    await p.complete({ prompt: 'y' });
    expect(made.mock.calls.length).toBe(before + 1);
    made.mockRestore();
  });

  it('refuses a model name or program path that carries shell syntax (they reach cmd.exe on Windows)', () => {
    expect(() => claudeCliProvider({ model: 'sonnet & calc' })).toThrow(/refused/);
    expect(() => claudeCliProvider({ model: 'opus"|whoami' })).toThrow(/refused/);
    expect(() => claudeCliProvider({ bin: 'claude & del x' })).toThrow(/refused/);
    expect(() => claudeCliProvider({ model: 'claude-sonnet-4-5@20250929', bin: 'C:\\Program Files (x86)\\npm\\claude.cmd' })).not.toThrow();
  });

  it('answers text-only by default (no tools, empty folder); only callers that ask for tools get them', async () => {
    const seen: { args: string[]; cwd?: string }[] = [];
    const exec = (async (_bin: string, args: string[], _input: string, _t: number, cwd?: string) => (seen.push({ args, cwd }), { code: 0, stdout: JSON.stringify({ result: 'ok', is_error: false }), stderr: '', timedOut: false })) as any;
    const p = claudeCliProvider({ exec });
    await p.complete({ prompt: 'Write a CI step for drift detection' });
    expect(seen[0].args.join(' ')).toContain('--tools ""');
    expect(seen[0].cwd).toMatch(/synaptome-model-/);
    await p.complete({ prompt: 'x', cwd: '/repo', extraArgs: ['--allowedTools', 'Read'] });
    expect(seen[1].args).not.toContain('""');
    expect(seen[1].cwd).toBe('/repo');
  });
});

describe('registry, verification and selection', () => {
  const fakeClaude = (answer: string, ok = true): ModelProvider => ({ id: 'claude-code-headless', title: 'Claude (fake)', availability: async () => ({ available: true, authenticated: true, detail: 'fake' }), complete: async () => ({ ok, text: answer, ms: 5, usage: { inputTokens: 10, outputTokens: 1 } }) });

  it('a provider is VERIFIED only after a recorded successful live call', async () => {
    const entries = buildProviders(sys, { env: {}, claude: fakeClaude('OK') });
    expect(providerStatus(sys, entries).every((s) => s.status === 'UNVERIFIED')).toBe(true);
    expect(await checkProvider(sys, entries[0])).toMatchObject({ ok: true });
    expect(await checkProvider(sys, entries[1])).toMatchObject({ ok: false, detail: 'not available: set ANTHROPIC_API_KEY to use it' });
    const st = Object.fromEntries(providerStatus(sys, entries).map((s) => [s.id, s.status]));
    expect(st).toEqual({ 'claude-code-headless': 'VERIFIED', anthropic: 'FAILED', openai: 'UNVERIFIED', gemini: 'UNVERIFIED', ollama: 'UNVERIFIED' });
  });

  it('an answer that is not the one asked for does not verify a provider', async () => {
    const entries = buildProviders(sys, { env: {}, claude: fakeClaude('I cannot help with that') });
    expect(await checkProvider(sys, entries[0])).toMatchObject({ ok: false, detail: expect.stringMatching(/not as asked/) });
  });

  it('selects by preference and availability, explains each skip, and never leaves the machine under local-only', async () => {
    const entries = buildProviders(sys, { env: {}, claude: fakeClaude('OK') });
    expect((await selectProvider(sys, entries)).entry!.spec.id).toBe('claude-code-headless');
    setSetting(sys.db, 'providers.disabled', ['claude-code-headless']);
    const none = await selectProvider(sys, entries);
    expect(none.entry).toBeNull();
    expect(none.considered.find((c) => c.id === 'claude-code-headless')!.why).toBe('switched off');
    setSetting(sys.db, 'providers.disabled', []);
    setSetting(sys.db, 'providers.privacy', 'local-only');
    const local = await selectProvider(sys, entries);
    expect(local.entry).toBeNull(); // only Ollama is local, and it has no model configured here
    expect(local.considered.find((c) => c.id === 'claude-code-headless')!.why).toMatch(/local-only/);
  });

  it('reports cost only when a price is configured', () => {
    expect(costOf(sys, 'anthropic', { inputTokens: 1_000_000, outputTokens: 0 })).toBeNull();
    setSetting(sys.db, 'providers.prices', { anthropic: { input: 3, output: 15 } });
    expect(costOf(sys, 'anthropic', { inputTokens: 1_000_000, outputTokens: 100_000 })).toBeCloseTo(4.5);
  });
});
