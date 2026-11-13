import { type ModelProvider, type Sys, emit, nowIso } from '@synaptome/core';
import { claudeCliProvider } from '@synaptome/evaluation';

/* =====================================================================
 * Model providers. Credentials are read from the environment at call time and never stored, logged or echoed.
 * A provider is VERIFIED only when a live call has succeeded and been recorded (provider_checks, schema v6).
 * ===================================================================== */

type Fetch = typeof fetch;
type Completion = Awaited<ReturnType<ModelProvider['complete']>>;

export interface ProviderSpec {
  id: string;
  title: string;
  /** Where task text goes. "remote" means it leaves this machine. */
  location: 'local' | 'remote';
  /** How the owner pays: a subscription login, per token, or nothing (a local model). */
  billing: 'subscription' | 'per-token' | 'free-local';
  /** Environment variables that hold its credential (any one is enough); empty when none is needed. */
  credentialEnv: string[];
  defaultModel: string | null;
}

export const SPECS: ProviderSpec[] = [
  { id: 'claude-code-headless', title: 'Claude Code (headless, your login)', location: 'remote', billing: 'subscription', credentialEnv: [], defaultModel: null },
  { id: 'anthropic', title: 'Anthropic API', location: 'remote', billing: 'per-token', credentialEnv: ['ANTHROPIC_API_KEY'], defaultModel: 'claude-sonnet-5-5' },
  { id: 'openai', title: 'OpenAI-compatible API', location: 'remote', billing: 'per-token', credentialEnv: ['OPENAI_API_KEY'], defaultModel: null },
  { id: 'gemini', title: 'Google Gemini API', location: 'remote', billing: 'per-token', credentialEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], defaultModel: null },
  { id: 'ollama', title: 'Local OpenAI-compatible server (Ollama and similar)', location: 'local', billing: 'free-local', credentialEnv: [], defaultModel: null },
];

const credential = (spec: ProviderSpec, env: NodeJS.ProcessEnv) => spec.credentialEnv.map((k) => env[k]).find((v) => !!v) ?? null;
/** Never let a credential reach an error message, even if a server echoes it back. */
const scrub = (s: string, secret: string | null) => (secret ? s.split(secret).join('[redacted]') : s);

async function postJson(f: Fetch, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number, secret: string | null) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ac.signal });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (!res.ok) return { ok: false as const, error: scrub(`HTTP ${res.status}: ${String(json?.error?.message ?? text).slice(0, 300)}`, secret) };
    return { ok: true as const, json };
  } catch (e: any) {
    return { ok: false as const, error: scrub(ac.signal.aborted ? `timed out after ${timeoutMs} ms` : `request failed: ${e?.message ?? e}`, secret) };
  } finally {
    clearTimeout(t);
  }
}

/** Anthropic Messages API. */
export function anthropicProvider(opts: { model: string; env?: NodeJS.ProcessEnv; fetch?: Fetch; baseUrl?: string }): ModelProvider {
  const spec = SPECS.find((s) => s.id === 'anthropic')!;
  const env = opts.env ?? process.env;
  const f = opts.fetch ?? fetch;
  return {
    id: 'anthropic',
    title: spec.title,
    async availability() {
      return credential(spec, env) ? { available: true, authenticated: true, detail: `key found in ${spec.credentialEnv.join(' / ')}; model ${opts.model}` } : { available: false, authenticated: false, detail: `set ${spec.credentialEnv[0]} to use it` };
    },
    async complete(req): Promise<Completion> {
      const key = credential(spec, env);
      const started = Date.now();
      if (!key) return { ok: false, text: '', error: `no credential (${spec.credentialEnv[0]})`, ms: 0 };
      const r = await postJson(f, `${opts.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`, { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, { model: opts.model, max_tokens: req.maxTokens ?? 2048, ...(req.system ? { system: req.system } : {}), messages: [{ role: 'user', content: req.prompt }] }, req.timeoutMs ?? 180_000, key);
      if (!r.ok) return { ok: false, text: '', error: r.error, ms: Date.now() - started };
      const text = (r.json?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      return { ok: true, text, raw: { id: r.json?.id, model: r.json?.model, stop: r.json?.stop_reason }, ms: Date.now() - started, usage: { inputTokens: r.json?.usage?.input_tokens ?? 0, outputTokens: r.json?.usage?.output_tokens ?? 0 } };
    },
  };
}

/** Any server speaking the OpenAI chat-completions protocol: OpenAI itself, Ollama, LM Studio, vLLM and others. */
export function openAICompatibleProvider(opts: { id: 'openai' | 'ollama'; baseUrl: string; model: string | null; env?: NodeJS.ProcessEnv; fetch?: Fetch }): ModelProvider {
  const spec = SPECS.find((s) => s.id === opts.id)!;
  const env = opts.env ?? process.env;
  const f = opts.fetch ?? fetch;
  const url = opts.baseUrl.replace(/\/+$/, '');
  return {
    id: opts.id,
    title: spec.title,
    async availability() {
      if (!opts.model) return { available: false, authenticated: false, detail: `no model configured (setting providers.models.${opts.id})` };
      if (spec.credentialEnv.length && !credential(spec, env)) return { available: false, authenticated: false, detail: `set ${spec.credentialEnv[0]} to use it` };
      if (spec.location === 'local') {
        try {
          const res = await f(`${url}/models`, { signal: AbortSignal.timeout(2000) });
          return res.ok ? { available: true, authenticated: true, detail: `${url} answered; model ${opts.model}` } : { available: false, authenticated: false, detail: `${url} answered HTTP ${res.status}` };
        } catch {
          return { available: false, authenticated: false, detail: `nothing is listening at ${url}` };
        }
      }
      return { available: true, authenticated: true, detail: `key found; model ${opts.model} at ${url}` };
    },
    async complete(req): Promise<Completion> {
      const key = credential(spec, env);
      const started = Date.now();
      if (!opts.model) return { ok: false, text: '', error: 'no model configured', ms: 0 };
      if (spec.credentialEnv.length && !key) return { ok: false, text: '', error: `no credential (${spec.credentialEnv[0]})`, ms: 0 };
      const messages = [...(req.system ? [{ role: 'system', content: req.system }] : []), { role: 'user', content: req.prompt }];
      const r = await postJson(f, `${url}/chat/completions`, key ? { authorization: `Bearer ${key}` } : {}, { model: opts.model, messages, max_tokens: req.maxTokens ?? 2048 }, req.timeoutMs ?? 180_000, key);
      if (!r.ok) return { ok: false, text: '', error: r.error, ms: Date.now() - started };
      return { ok: true, text: String(r.json?.choices?.[0]?.message?.content ?? ''), raw: { model: r.json?.model, finish: r.json?.choices?.[0]?.finish_reason }, ms: Date.now() - started, usage: { inputTokens: r.json?.usage?.prompt_tokens ?? 0, outputTokens: r.json?.usage?.completion_tokens ?? 0 } };
    },
  };
}

/** Google Gemini generateContent API. */
export function geminiProvider(opts: { model: string | null; env?: NodeJS.ProcessEnv; fetch?: Fetch; baseUrl?: string }): ModelProvider {
  const spec = SPECS.find((s) => s.id === 'gemini')!;
  const env = opts.env ?? process.env;
  const f = opts.fetch ?? fetch;
  return {
    id: 'gemini',
    title: spec.title,
    async availability() {
      if (!opts.model) return { available: false, authenticated: false, detail: 'no model configured (setting providers.models.gemini)' };
      return credential(spec, env) ? { available: true, authenticated: true, detail: `key found; model ${opts.model}` } : { available: false, authenticated: false, detail: `set ${spec.credentialEnv[0]} to use it` };
    },
    async complete(req): Promise<Completion> {
      const key = credential(spec, env);
      const started = Date.now();
      if (!opts.model) return { ok: false, text: '', error: 'no model configured', ms: 0 };
      if (!key) return { ok: false, text: '', error: `no credential (${spec.credentialEnv[0]})`, ms: 0 };
      const body = { contents: [{ role: 'user', parts: [{ text: req.prompt }] }], ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}), generationConfig: { maxOutputTokens: req.maxTokens ?? 2048 } };
      const r = await postJson(f, `${opts.baseUrl ?? 'https://generativelanguage.googleapis.com'}/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`, { 'x-goog-api-key': key }, body, req.timeoutMs ?? 180_000, key);
      if (!r.ok) return { ok: false, text: '', error: r.error, ms: Date.now() - started };
      const text = (r.json?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
      return { ok: true, text, raw: { finish: r.json?.candidates?.[0]?.finishReason }, ms: Date.now() - started, usage: { inputTokens: r.json?.usageMetadata?.promptTokenCount ?? 0, outputTokens: r.json?.usageMetadata?.candidatesTokenCount ?? 0 } };
    },
  };
}

/* ---------- registry ---------- */

export interface ProviderEntry {
  spec: ProviderSpec;
  provider: ModelProvider;
  model: string | null;
}

export function buildProviders(sys: Sys, opts: { env?: NodeJS.ProcessEnv; fetch?: Fetch; claude?: ModelProvider } = {}): ProviderEntry[] {
  const s = sys.settings().providers;
  const model = (id: string) => s.models[id] ?? SPECS.find((x) => x.id === id)!.defaultModel;
  const common = { env: opts.env, fetch: opts.fetch };
  return [
    { spec: SPECS[0], provider: opts.claude ?? claudeCliProvider(s.models['claude-code-headless'] ? { model: s.models['claude-code-headless'] } : {}), model: s.models['claude-code-headless'] ?? null },
    { spec: SPECS[1], provider: anthropicProvider({ ...common, model: model('anthropic')! }), model: model('anthropic') },
    { spec: SPECS[2], provider: openAICompatibleProvider({ ...common, id: 'openai', baseUrl: s.endpoints.openai ?? 'https://api.openai.com/v1', model: model('openai') }), model: model('openai') },
    { spec: SPECS[3], provider: geminiProvider({ ...common, model: model('gemini') }), model: model('gemini') },
    { spec: SPECS[4], provider: openAICompatibleProvider({ ...common, id: 'ollama', baseUrl: s.endpoints.ollama ?? 'http://127.0.0.1:11434/v1', model: model('ollama') }), model: model('ollama') },
  ];
}

export interface ProviderStatus {
  id: string;
  title: string;
  location: 'local' | 'remote';
  billing: ProviderSpec['billing'];
  model: string | null;
  enabled: boolean;
  allowedByPrivacy: boolean;
  /** VERIFIED: the last recorded live call succeeded. FAILED: it failed. UNVERIFIED: never checked. */
  status: 'VERIFIED' | 'FAILED' | 'UNVERIFIED';
  lastCheck: { ok: boolean; detail: string; at: string; model: string | null } | null;
  price: { input: number; output: number } | null;
}

export function providerStatus(sys: Sys, entries: ProviderEntry[]): ProviderStatus[] {
  const s = sys.settings().providers;
  return entries.map((e) => {
    const last = sys.db.get<any>('SELECT ok, detail, model, created_at FROM provider_checks WHERE provider_id=? ORDER BY id DESC LIMIT 1', e.spec.id);
    return {
      id: e.spec.id, title: e.spec.title, location: e.spec.location, billing: e.spec.billing, model: e.model,
      enabled: !s.disabled.includes(e.spec.id), allowedByPrivacy: s.privacy === 'any' || e.spec.location === 'local',
      status: !last ? 'UNVERIFIED' : last.ok ? 'VERIFIED' : 'FAILED',
      lastCheck: last ? { ok: !!last.ok, detail: last.detail, at: last.created_at, model: last.model } : null,
      price: s.prices[e.spec.id] ?? null,
    };
  });
}

/** Availability, then one tiny live call. The outcome is recorded either way; that record is the provider's status. */
export async function checkProvider(sys: Sys, entry: ProviderEntry): Promise<{ ok: boolean; detail: string; ms: number }> {
  const a = await entry.provider.availability();
  let ok = false;
  let detail = a.detail;
  let ms = 0;
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  if (a.available && a.authenticated) {
    const r = await entry.provider.complete({ prompt: 'Reply with exactly the word OK and nothing else.', maxTokens: 16, timeoutMs: 120_000 });
    ms = r.ms;
    usage = r.usage;
    ok = r.ok && /\bok\b/i.test(r.text);
    detail = r.ok ? (ok ? `live call answered in ${r.ms} ms` : `answered, but not as asked: "${r.text.slice(0, 60)}"`) : `live call failed: ${r.error}`;
  } else detail = `not available: ${a.detail}`;
  sys.db.run('INSERT INTO provider_checks (provider_id, model, ok, detail, ms, input_tokens, output_tokens, created_at) VALUES (?,?,?,?,?,?,?,?)', entry.spec.id, entry.model, ok ? 1 : 0, detail, ms, usage?.inputTokens ?? null, usage?.outputTokens ?? null, nowIso());
  emit(sys.db, 'provider.checked', entry.spec.id, { ok, detail });
  return { ok, detail, ms };
}

/**
 * Picks a provider for a task: the named one if allowed, otherwise the first preferred provider that is enabled,
 * allowed by the privacy setting and available. Never silently falls back to a remote provider under "local-only".
 */
export async function selectProvider(sys: Sys, entries: ProviderEntry[], want: { id?: string; localOnly?: boolean } = {}): Promise<{ entry: ProviderEntry | null; reason: string; considered: { id: string; why: string }[] }> {
  const s = sys.settings().providers;
  const localOnly = want.localOnly || s.privacy === 'local-only';
  const order = want.id ? [want.id] : [...s.preferred, ...entries.map((e) => e.spec.id).filter((id) => !s.preferred.includes(id))];
  const considered: { id: string; why: string }[] = [];
  for (const id of order) {
    const e = entries.find((x) => x.spec.id === id);
    if (!e) {
      considered.push({ id, why: 'unknown provider' });
      continue;
    }
    if (s.disabled.includes(id)) {
      considered.push({ id, why: 'switched off' });
      continue;
    }
    if (localOnly && e.spec.location !== 'local') {
      considered.push({ id, why: 'would send text off this machine; privacy is local-only' });
      continue;
    }
    // A live call that succeeded in the last day counts; otherwise ask the provider (which may itself cost a call).
    const recent = sys.db.get<any>('SELECT ok, created_at FROM provider_checks WHERE provider_id=? ORDER BY id DESC LIMIT 1', id);
    const fresh = recent?.ok && Date.now() - Date.parse(recent.created_at) < 24 * 3_600_000;
    if (!fresh) {
      const a = await e.provider.availability();
      if (!a.available || !a.authenticated) {
        considered.push({ id, why: a.detail });
        continue;
      }
    }
    considered.push({ id, why: fresh ? 'selected (verified by a live call in the last day)' : 'selected' });
    return { entry: e, reason: `${e.spec.title}${e.model ? ` (${e.model})` : ''}`, considered };
  }
  return { entry: null, reason: 'no provider is enabled, allowed and available', considered };
}

/** Cost of a call in USD when a price is configured; null when it is not known. */
export function costOf(sys: Sys, providerId: string, usage?: { inputTokens: number; outputTokens: number }): number | null {
  const p = sys.settings().providers.prices[providerId];
  if (!p || !usage) return null;
  return (usage.inputTokens * p.input + usage.outputTokens * p.output) / 1_000_000;
}
