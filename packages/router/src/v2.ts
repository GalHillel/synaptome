import { type CapabilityRow, type RouteDecision, type RouteSelection, type RoutingStrategy, type Sys, STAGE_ORDER, domainById, estimateTokens, listCapabilities, tokenize } from '@synaptome/core';
import { analyzeTask, baseEligibility } from './index';

/* =====================================================================
 * lexical-graph-v2: evidence-based routing that knows when not to activate.
 *
 *   intent gate   -> trivial, administrative, meta and lookup prompts select nothing
 *   retrieval     -> FTS5/BM25 over the task's salient terms
 *   conditions    -> explicit `requires:` / `never:` and exclusion sentences on the capability
 *   evidence      -> rarity-weighted hits; the capability's own name or tags must be among them
 *   confidence    -> a floor below which nothing is selected (an empty result is a valid result)
 *   selection     -> each further capability must bring evidence the earlier ones did not
 *   budget        -> capability count and estimated context are capped
 *
 * Deterministic, no model call, explainable: every selection lists the terms that justified it.
 * ===================================================================== */

export type IntentKind = 'substantive' | 'trivial' | 'administrative' | 'meta' | 'lookup';

/** Verbs that mark a request to produce, change or examine something of substance. */
const WORK =
  /\b(build|implement|design|architect|create|develop|write|draft|author|compose|add|fix|debug|diagnose|investigate|reproduce|review|audit|assess|evaluate|plan|propose|outline|map|model|migrate|deploy|set ?up|configure|optimi[sz]e|improve|tune|refactor|rewrite|port|convert|test|analy[sz]e|profile|scrape|scan|research|survey|compare|prepare|containeri[sz]e|integrate|secure|harden|document|extract|generate|train|benchmark|ship|launch|run an?|do an?|make)\b/i;
const ACK = /^(thanks|thank you|thx|ok|okay|k|yes|yep|yeah|no|nope|sure|great|nice|perfect|cool|good (morning|afternoon|evening|night)|hi|hello|hey|continue|proceed|go ahead|go on|wait|stop|never ?mind|please (proceed|continue|go ahead)|sounds good|looks good|lgtm|do it|carry on)\b/i;
const META = /\b(you just|did you|have you|are you|can you see|could you see|which model|what model|this session|this conversation|so far|what did (you|we)|what are you going to|what you are going to|before you do it|your (context|instructions|memory)|how many tokens)\b/i;
const LOOKUP = /^(what (does|do|is|are|was|were|time|version|day)|which (version|one|file|branch)|is (the|there|it|this)|are (the|there|we)|did (the|it|we)|does (the|it|this)|do we|how (many|much|long|old)|who (is|was|wrote)|when (is|was|did|does)|where (is|are|did))\b/i;
const ADMIN_VERB = /^(rename|delete|remove|move|open|show|list|commit|push|pull|run|rerun|re-run|install|bump|undo|revert|paste|copy|spell-?check|close|print|cat|cd|checkout|merge|stash|tag|save|export|upload|download|restart|kill|clear|refresh)\b/i;
const ADMIN_PHRASE = /^add .{1,40} to the (list|readme|notes?|changelog|issue|title|doc)\b|\bupdate my (note|notes|calendar|todo|reminder)\b/i;
/** Heavier work that happens to start with an administrative verb is recognised by these. */
const ADMIN_OVERRIDE = /\b(audit|review|migration|migrations|benchmark|profil\w*|analysis|refactor\w*|pipeline|architecture|threat|vulnerab\w*|accessib\w*)\b/i;

/** Prompts a host writes for its own housekeeping (summaries, titles) rather than a task from the person. */
const HOST_INTERNAL = /^\s*(below is|here is|the following is)\s+(a|an|the)\s+(conversation|chat|session|transcript)\b|^\s*(summari[sz]e|write a (title|summary) for)\s+(this|the following)\s+(conversation|chat|session|transcript)\b|^\s*(<system-reminder>\s*)?\[?system notification\b|<task-notification>|^\s*<system-reminder>/i;
/** Steering an agent through work it is already doing. */
const CONTINUE = /(^|[.!?]\s+)(please\s+|ok,?\s+|okay,?\s+|now\s+|so\s+)?(continue|resume|carry on|keep going|go on|pick up)\b/i;
/** Words that only name Synaptome or its tools; instructions about the router are not part of the task. */
const SELF_REFERENCE = /\b(the\s+)?synaptome(\s+mcp)?(\s+server)?\b|\b(route_task|get_capability|record_outcome|search_capabilities)\b/gi;

export function classifyIntent(task: string): { kind: IntentKind; reason: string } {
  const s = task.trim();
  if (HOST_INTERNAL.test(s)) return { kind: 'meta', reason: 'a host housekeeping prompt (summary or title of a conversation), not a task' };
  // "Please continue from where you left off and finish the plan" steers work already under way; it names no new task.
  const words = s.split(/\s+/).filter(Boolean).length;
  if (CONTINUE.test(s) && words <= 24) return { kind: 'trivial', reason: 'asks to continue work already under way' };
  if (words <= 3) return { kind: 'trivial', reason: `${words} word(s)` };
  if (ACK.test(s) && words <= 10) return { kind: 'trivial', reason: 'acknowledgement or steering' };
  if (META.test(s) && words <= 16) return { kind: 'meta', reason: 'about the assistant or the session, not a task' };
  if (LOOKUP.test(s) && words <= 16 && !WORK.test(s)) return { kind: 'lookup', reason: 'a short factual question' };
  if (((ADMIN_VERB.test(s) && words <= 10) || ADMIN_PHRASE.test(s)) && !ADMIN_OVERRIDE.test(s)) return { kind: 'administrative', reason: 'a file, version-control or housekeeping instruction' };
  return { kind: 'substantive', reason: 'a task' };
}

/** Words that describe ambition or carry no subject; dropped before evidence is counted. */
const GENERIC = new Set(
  'production quality advanced sophisticated complete full simple good best great high premium modern professional application applications app apps project projects system systems feature features code based including team work task tasks thing things level support ensure improve improved better proper properly correct correctly existing current right small big new old first next last one two three way ways time need needs like well also still now then here there every each any all more most less few many much really please could would should might must'.split(
    ' ',
  ),
);
/** Common enough that a hit proves little; they add a little weight and never justify a selection alone. */
const WEAK = new Set(
  'fix product service web data model guide report review index server node write writing copy verify design analysis analyze skill skills summary email bug test tests testing page file files list version user users change changes run set check add update updates format type types style rules strategy clear size state plan plans'.split(
    ' ',
  ),
);
/** Words too broad to anchor a capability even when they are in its name or tags. */
const ANCHOR_STOP = new Set('patterns pattern workflow workflows builder writing design review audit analysis service app best practices guide expert pro development operations optimization handlers handler planning strategy scenes modeling'.split(' '));

/** Engineering domains a task may name outright ("with a backend, a database and testing"); naming one is a request for it. */
const NAMED_DOMAINS = new Set(['frontend', 'backend', 'database', 'testing', 'devops', 'mobile', 'security', 'performance']);

/**
 * Words that tie a capability to one language, vendor, platform or framework. A capability whose name carries
 * such words fits a task only if the task names at least one of them (or an alias).
 */
const QUALIFIERS = new Set(
  'python typescript javascript rust go golang java kotlin swift swiftui csharp ruby php scala elixir dart cpp c++ azure aws gcp cloudflare vercel supabase firebase heroku netlify react vue angular svelte sveltekit nextjs nuxt remix django flask fastapi rails laravel spring nestjs express expo flutter ios android postgres postgresql mysql mongodb redis sqlite dynamodb tailwind pandas playwright cypress terraform pulumi github gitlab jira salesforce shopify stripe'.split(' '),
);
const QUALIFIER_ALIASES: Record<string, string[]> = {
  go: ['golang', 'goroutine', 'goroutines'],
  golang: ['go', 'goroutine', 'goroutines'],
  nextjs: ['next.js', 'next'],
  postgres: ['postgresql', 'psql'],
  postgresql: ['postgres', 'psql'],
  typescript: ['ts', 'tsx'],
  javascript: ['js', 'node', 'nodejs'],
  csharp: ['c#', '.net', 'dotnet'],
  ios: ['iphone', 'ipad', 'swiftui'],
  aws: ['amazon', 's3', 'lambda'],
  gcp: ['google', 'gke', 'bigquery'],
};

/** True when `word` appears in `text` as a whole word (punctuation such as next.js or c# allowed inside it). */
function mentions(text: string, word: string): boolean {
  const isWordChar = (ch: string | undefined) => !!ch && /[a-z0-9]/.test(ch);
  let from = 0;
  for (;;) {
    const i = text.indexOf(word, from);
    if (i < 0) return false;
    if (!isWordChar(text[i - 1]) && !isWordChar(text[i + word.length])) return true;
    from = i + 1;
  }
}

/** The individual trigger phrases in a capability's activation statements: quoted strings and list items. */
function triggerPhrases(c: CapabilityRow): string[] {
  const out: string[] = [];
  for (const line of c.record.activation ?? []) {
    if (/^\s*(requires|never)\s*:/i.test(line)) continue;
    for (const part of line.split(/["“”()\[\];,:]|\s(?:or|and|such as|e\.g\.|etc\.?)\s/i)) {
      const p = part.trim();
      if (p && p.split(/\s+/).length <= 8) out.push(p);
    }
  }
  return out;
}

/** Words of the activation sentence itself, not of its subject. */
const TRIGGER_BOILERPLATE = new Set('trigger triggers triggered use used using uses whenever asked ask asks claude should skill skills agent agents user users when wants want help helps sort kind kinds all any various etc including such'.split(' '));

const norm = (t: string) => t.replace(/isation/g, 'ization').replace(/ise$/, 'ize').replace(/ising$/, 'izing').replace(/ised$/, 'ized');
/** Same word or the same stem with an inflection: profile/profiling, containerize/containerization. Never config/configurator. */
export function near(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  if (short.length / long.length < 0.55) return false;
  let i = 0;
  while (i < short.length && short[i] === long[i]) i++;
  return i >= Math.max(4, short.length - 2);
}

/** For long prompts only the most salient terms describe the task; the rest is supporting text. */
const LONG_PROMPT_WORDS = 120;
const SALIENT_TERMS = 24;

export interface V2Config {
  assumeEligible?: Set<string>;
  minConfidence?: number;
  maxCapabilities?: number;
  contextBudgetTokens?: number;
}

interface Scored {
  c: CapabilityRow;
  confidence: number;
  score: number;
  strong: string[];
  anchorHits: string[];
  weakHits: string[];
  single: boolean;
}

const VERIFY: Record<string, string> = {
  research: 'claims are sourced and cross-checked',
  design: 'design is reviewed against the stated requirements',
  build: 'it builds and runs; tests cover the new behaviour',
  verify: 'tests, security checks and accessibility checks pass',
  ship: 'deployment is verified and the rollback path is known',
  document: 'documentation matches actual behaviour',
};

/** Structured conditions written as `requires: a, b` or `never: x, y` among a capability's activation/exclusion entries. */
function conditions(c: CapabilityRow) {
  const requires: string[] = [];
  const never: string[] = [];
  const exclusionSentences: string[] = [];
  for (const line of [...(c.record.activation ?? []), ...(c.record.exclusion ?? [])]) {
    const m = /^\s*(requires|never)\s*:\s*(.+)$/i.exec(line);
    if (m) (m[1].toLowerCase() === 'requires' ? requires : never).push(...m[2].split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
  }
  for (const line of c.record.exclusion ?? []) if (!/^\s*(requires|never)\s*:/i.test(line)) exclusionSentences.push(line);
  return { requires, never, exclusionSentences };
}

export function evidenceStrategy(sys: Sys, cfg: V2Config = {}): RoutingStrategy {
  const settings = (sys.settings() as any).routing ?? {};
  const minConfidence = cfg.minConfidence ?? settings.minConfidence ?? 0.55;
  const maxCapabilities = cfg.maxCapabilities ?? settings.maxCapabilities ?? 4;
  const contextBudget = cfg.contextBudgetTokens ?? settings.contextBudgetTokens ?? 12000;
  const eligibility = (c: CapabilityRow) => (cfg.assumeEligible?.has(c.id) ? { ok: true, reason: 'candidate under activation test' } : baseEligibility(c));

  return {
    id: 'lexical-graph-v2',
    route(task, opts = {}) {
      const started = performance.now();
      const analysis = analyzeTask(task);
      const intent = classifyIntent(task);
      const empty = (extra: Partial<RouteDecision> = {}): RouteDecision => ({ task, strategy: 'lexical-graph-v2', analysis: { ...analysis, intent }, selected: [], excluded: [], gaps: [], plan: [], metrics: { ms: Number((performance.now() - started).toFixed(2)), candidates: 0, qualified: 0 }, ...extra });
      if (intent.kind !== 'substantive') return empty();

      const words = task.trim().split(/\s+/).filter(Boolean).length;
      const lower = task.toLowerCase();
      const total = sys.db.get<{ n: number }>('SELECT COUNT(*) n FROM capabilities')!.n;
      const maxIdf = Math.log(1 + total) || 1;
      const idfCache = new Map<string, number>();
      /** Rarity of a term across capability names, descriptions and tags, scaled to 0..1. */
      const rarity = (k: string) => {
        if (!idfCache.has(k)) {
          const df = sys.db.get<{ n: number }>('SELECT COUNT(*) n FROM capabilities_fts WHERE capabilities_fts MATCH ?', `{name description tags} : "${k.replace(/"/g, '')}"*`)?.n ?? 0;
          idfCache.set(k, df === 0 ? 0 : Math.min(1, Math.log(1 + total / (1 + df)) / maxIdf));
        }
        return idfCache.get(k)!;
      };

      const subject = task.replace(SELF_REFERENCE, ' ');
      let terms = [...new Set(tokenize(subject.replace(/[-_/]/g, ' ')).concat(tokenize(subject)).map(norm))].filter((t) => !GENERIC.has(t) && !/^\d+$/.test(t));
      if (words > LONG_PROMPT_WORDS) {
        // Salience = how often the prompt says it, times how rare it is in the registry.
        const tf = new Map<string, number>();
        for (const raw of lower.split(/[^a-z0-9+#.]+/)) {
          const w = norm(raw);
          if (terms.includes(w)) tf.set(w, (tf.get(w) ?? 0) + 1);
        }
        terms = terms
          .map((t) => ({ t, s: Math.log(1 + (tf.get(t) ?? 1)) * rarity(t) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, SALIENT_TERMS)
          .map((x) => x.t);
      }
      if (!terms.length) return empty();
      const taskWords = tokenize(task.replace(/[-_/]/g, ' '));
      // Terms that occur only in an "about …" clause name the subject of the work, not the work itself.
      const topicStart = lower.search(/\b(about|regarding|concerning|on the subject of)\b/);
      const workPart = topicStart >= 0 ? lower.slice(0, topicStart) : lower;
      const workTerms = new Set(tokenize(workPart.replace(/[-_/]/g, ' ')).map(norm));
      const topicOnly = new Set(topicStart >= 0 ? terms.filter((x) => ![...workTerms].some((w) => near(w, x))) : []);

      const rows = listCapabilities(sys, { q: terms.join(' '), limit: 60 }).items;
      const priors = outcomePriors(sys);
      const excluded: RouteDecision['excluded'] = [];
      const noteExcluded = (c: CapabilityRow, reason: string) => {
        if (excluded.length < 10 && !excluded.some((e) => e.capabilityId === c.id)) excluded.push({ capabilityId: c.id, name: c.name, reason });
      };

      const scored: Scored[] = [];
      for (const c of rows) {
        const nameToks = tokenize(c.name.replace(/[-_.]/g, ' ')).map(norm);
        const tagToks = tokenize(c.tags.join(' ').replace(/[-_]/g, ' ')).concat(tokenize(c.tags.join(' '))).map(norm);
        const triggerText = (c.record.activation ?? []).filter((l) => !/^\s*(requires|never)\s*:/i.test(l)).join(' ');
        const hay = [...new Set([...nameToks, ...tagToks, ...tokenize(`${c.description} ${triggerText}`.replace(/[-_/]/g, ' ')).map(norm), ...tokenize(c.description).map(norm)])];
        // Anchors: what the capability says it is about — its name, its tags, and its own trigger phrases
        // ("use this skill whenever asked to write status reports, leadership updates, 3P updates…").
        // A trigger phrase counts only when the task hits two of its words: "leadership updates" matches
        // "leadership update"; "load" from "page load speed" plus "choose" from another phrase does not.
        const anchorOk = (a: string) => !GENERIC.has(a) && !WEAK.has(a) && !ANCHOR_STOP.has(a);
        const ownAnchors = [...new Set([...nameToks, ...tagToks])].filter(anchorOk);
        const triggerAnchors = triggerPhrases(c)
          .map((phrase) => tokenize(phrase.replace(/[-_/]/g, ' ')).map(norm).filter((w) => !TRIGGER_BOILERPLATE.has(w) && !GENERIC.has(w)))
          .filter((words) => words.filter((w) => terms.some((t) => near(t, w))).length >= 2)
          .flat()
          .filter(anchorOk);
        const anchors = [...new Set([...ownAnchors, ...triggerAnchors])];
        const hit = terms.filter((t) => hay.some((h) => near(h, t)));
        const domainNamed = terms.find((t) => t === c.domain && NAMED_DOMAINS.has(t));
        const strong = hit.filter((t) => !WEAK.has(t) || t === domainNamed);
        const weakHits = hit.filter((t) => WEAK.has(t) && t !== domainNamed);
        const anchorHits = strong.filter((t) => t === domainNamed || anchors.some((a) => near(a, t)));
        if (!anchorHits.length) continue; // nothing in the task names what this capability is about

        // Built for a specific language, vendor or framework the task does not name: not this task's capability.
        // Exception: the task asks outright for the capability's domain ("a frontend", "a database") without naming
        // a technology; then a technology-specific capability of that domain is a reasonable default.
        const quals = [...new Set(nameToks.filter((t) => QUALIFIERS.has(t)))];
        const domainDefault = !!domainNamed;
        const qualifierNamed = (q: string) => [q, ...(QUALIFIER_ALIASES[q] ?? [])].some((alias) => mentions(lower, alias)) || taskWords.some((w) => near(w, q)); // sveltekit names svelte
        if (quals.length && !domainDefault && !quals.some(qualifierNamed)) {
          noteExcluded(c, `built for ${quals.join(', ')}, which the task does not mention`);
          continue;
        }

        const cond = conditions(c);
        if (cond.never.some((n) => lower.includes(n))) {
          noteExcluded(c, `its exclusion condition matches the task (never: ${cond.never.filter((n) => lower.includes(n)).join(', ')})`);
          continue;
        }
        if (cond.requires.length && !cond.requires.some((r) => lower.includes(r))) {
          noteExcluded(c, `its activation condition is not met (requires one of: ${cond.requires.join(', ')})`);
          continue;
        }
        const blockedBy = cond.exclusionSentences.find((sentence) => {
          const toks = tokenize(sentence).map(norm).filter((x) => !GENERIC.has(x) && !WEAK.has(x));
          const overlap = toks.filter((x) => terms.some((t) => near(t, x)));
          return toks.length >= 2 && overlap.length >= 2 && overlap.length / toks.length >= 0.6;
        });
        if (blockedBy) {
          noteExcluded(c, `excluded by its own guidance: "${blockedBy.slice(0, 90)}"`);
          continue;
        }

        const evidence = strong.reduce((n, t) => n + rarity(t) * (anchorHits.includes(t) ? 1.5 : 1), 0) + weakHits.reduce((n, t) => n + rarity(t) * 0.3, 0);
        let confidence = 1 - Math.exp(-evidence / 1.4);
        // One matching word is never enough on its own. Measured on the real 1,034-capability registry, allowing a
        // single rare name word raised false activations from 2/58 to 5/58 for one extra selection (DECISIONS D-011).
        // The only exception: the task asks outright for the capability's domain ("add a backend").
        const single = strong.length < 2;
        if (single && !(domainNamed && WORK.test(task) && words >= 7)) continue;
        if (single && domainNamed) confidence = Math.max(confidence, minConfidence); // named outright: just clears the floor
        const prior = priors.get(c.id);
        if (prior && prior.total >= 3 && prior.rate < 0.34) confidence -= 0.1; // repeatedly unhelpful when served
        if (confidence < minConfidence) continue;
        const nameCover = nameToks.length ? nameToks.filter((a) => terms.some((t) => near(a, t))).length / nameToks.length : 0;
        const score = confidence * 0.78 + nameCover * 0.12 + ((c.quality ?? 50) / 100) * 0.04 + (prior ? (prior.rate - 0.5) * 0.06 : 0) + (c.installedHosts.length ? 0.01 : 0) + (c.trust === 'OFFICIAL_VERIFIED' ? 0.02 : 0);
        scored.push({ c, confidence: Number(confidence.toFixed(3)), score, strong, anchorHits, weakHits, single });
      }
      scored.sort((a, b) => b.score - a.score);

      const max = Math.min(opts.max ?? 99, maxCapabilities);
      const selected: (RouteSelection & { cost: number; domain: string })[] = [];
      const covered = new Set<string>();
      const overlapOf = (id: string) => new Set(sys.db.all<{ src: string; dst: string }>("SELECT src, dst FROM relations WHERE rel='overlaps' AND (src=? OR dst=?)", id, id).flatMap((r) => [r.src, r.dst]));
      for (const x of scored) {
        const elig = eligibility(x.c);
        if (!elig.ok) {
          noteExcluded(x.c, elig.reason);
          continue;
        }
        const clash = selected.find((s) => s.name === x.c.name || overlapOf(x.c.id).has(s.capabilityId));
        if (clash) {
          noteExcluded(x.c, `duplicates or overlaps ${clash.name}`);
          continue;
        }
        // A further capability must answer a part of the work the earlier ones did not. Words that only describe
        // what the task is about ("a status update about the billing migration") are its topic, not more work.
        const fresh = x.anchorHits.filter((t) => !covered.has(t));
        if (selected.length && fresh.length && fresh.every((t) => topicOnly.has(t))) {
          noteExcluded(x.c, `only matches what the task is about (${fresh.join(', ')}), not the work asked for`);
          continue;
        }
        if (selected.length && !fresh.length) {
          noteExcluded(x.c, `adds nothing beyond ${selected.map((s) => s.name).join(', ')} for this task`);
          continue;
        }
        if (selected.length >= max) {
          noteExcluded(x.c, `over the limit of ${max} capabilities per task`);
          continue;
        }
        for (const t of x.strong) covered.add(t);
        selected.push({
          capabilityId: x.c.id,
          name: x.c.name,
          kind: x.c.kind as RouteSelection['kind'],
          role: domainById(x.c.domain)?.title ?? x.c.domain,
          score: x.confidence,
          confidence: x.confidence,
          evidence: x.strong.slice(0, 8),
          installed: x.c.installedHosts.length > 0,
          reasons: [`matched on ${x.anchorHits.slice(0, 4).join(', ')}${x.strong.length > x.anchorHits.length ? ` with ${x.strong.filter((t) => !x.anchorHits.includes(t)).slice(0, 4).join(', ')}` : ''}`, `confidence ${x.confidence}`, elig.reason, x.c.quality != null ? `quality ${x.c.quality}` : 'quality not scored', `trust ${x.c.trust}, tier ${x.c.tier}`],
          cost: x.c.contextCost,
          domain: x.c.domain,
        });
      }

      while (selected.reduce((n, s) => n + s.cost, 0) > contextBudget && selected.length > 1) {
        const dropped = selected.pop()!;
        excluded.push({ capabilityId: dropped.capabilityId, name: dropped.name, reason: `dropped to stay within the ${contextBudget}-token context budget` });
      }

      // A strongly signalled domain with nothing selected for it is a gap worth recording.
      const gaps: RouteDecision['gaps'] = [];
      for (const d of analysis.domains) {
        if (d.score < 2 || selected.some((s) => s.domain === d.id)) continue;
        if (d.matched.every((k) => WEAK.has(k) || GENERIC.has(k))) continue;
        if (selected.some((s) => (s.evidence ?? []).some((e) => d.matched.some((k) => near(k, e))))) continue;
        gaps.push({ domain: d.id, term: d.matched.slice(0, 3).join(' '), reason: scored.some((x) => x.c.domain === d.id) ? 'matching capabilities exist but none is approved or installed' : 'no capability in the registry matches this part of the task with enough confidence' });
      }

      const plan = STAGE_ORDER.map((stage) => ({ stage, caps: selected.filter((s) => (domainById(s.domain)?.stage ?? 'build') === stage) }))
        .filter((x) => x.caps.length)
        .map((x, i) => ({ step: i + 1, stage: x.stage, capabilityIds: x.caps.map((cap) => cap.capabilityId), verify: VERIFY[x.stage] }));

      return {
        task,
        strategy: 'lexical-graph-v2',
        analysis: { ...analysis, intent },
        selected: selected.map(({ cost, domain, ...s }) => s),
        excluded,
        gaps: gaps.slice(0, 3),
        plan,
        metrics: { ms: Number((performance.now() - started).toFixed(2)), candidates: rows.length, qualified: scored.length },
      };
    },
  };
}

/** How served capabilities turned out, from recorded outcomes. Laplace-smoothed success rate. */
function outcomePriors(sys: Sys): Map<string, { rate: number; total: number }> {
  const out = new Map<string, { rate: number; total: number }>();
  const rows = sys.db.all<{ capability_id: string; good: number; bad: number }>(
    "SELECT capability_id, SUM(CASE WHEN outcome='success' THEN 1 WHEN outcome='partial' THEN 0.5 ELSE 0 END) good, SUM(CASE WHEN outcome='failed' THEN 1 WHEN outcome='partial' THEN 0.5 ELSE 0 END) bad FROM activations WHERE outcome IS NOT NULL GROUP BY capability_id",
  );
  for (const r of rows) out.set(r.capability_id, { rate: (r.good + 1) / (r.good + r.bad + 2), total: r.good + r.bad });
  return out;
}

/* =====================================================================
 * Compact context for hosts: summaries and a pointer, never the full capability.
 * ===================================================================== */

/** One or two sentences of the description, cut at a sentence or word boundary. */
export function summarize(description: string, maxChars = 220): string {
  const text = description.replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  const sentence = /^(.{40,}?[.!?])\s/.exec(text);
  if (sentence && sentence[1].length <= maxChars) return sentence[1];
  const cut = text.slice(0, maxChars);
  return `${cut.slice(0, Math.max(40, cut.lastIndexOf(' ')))}…`;
}

export interface HostContext {
  text: string;
  tokens: number;
  offered: string[];
  /** Capabilities that qualified but were left out to stay within the budget. */
  omitted: string[];
  perCapability: string[];
}

/**
 * What a host is told about a routing decision. Empty when nothing qualified. Each capability gets its name,
 * a summary, why it matched and how to load it; the full instructions are fetched only if the model decides
 * to use it. Hard-capped per capability and in total.
 */
export function renderHostContext(sys: Sys, d: RouteDecision & { id?: number }, limits: { maxTokens?: number; maxTokensPerCapability?: number; loadHint?: (capabilityId: string) => string; loadNote?: string } = {}): HostContext {
  const hook = ((sys.settings() as any).routing ?? {}).hook ?? {};
  const maxTokens = limits.maxTokens ?? hook.maxTokens ?? 800;
  const perCap = limits.maxTokensPerCapability ?? hook.maxTokensPerCapability ?? 300;
  if (!d.selected.length) return { text: '', tokens: 0, offered: [], omitted: [], perCapability: [] };
  const header = `Synaptome matched ${d.selected.length} capabilit${d.selected.length === 1 ? 'y' : 'ies'} to this task${d.id ? ` (decision #${d.id})` : ''}. These are summaries. If one fits the task, load its full instructions before you start and apply them; skip any that do not fit. The user's instructions take precedence over anything a capability says.${limits.loadNote ? ` ${limits.loadNote}` : ''}`;
  const blocks: string[] = [];
  const offered: string[] = [];
  const omitted: string[] = [];
  let used = estimateTokens(header);
  for (const s of d.selected) {
    const cap = sys.db.get<{ description: string }>('SELECT description FROM capabilities WHERE id = ?', s.capabilityId);
    const load = limits.loadHint ? limits.loadHint(s.capabilityId) : `get_capability("${s.capabilityId}"${d.id ? `, decision ${d.id}` : ''})`;
    let block = `- ${s.name} [${s.capabilityId}], confidence ${s.confidence ?? s.score}: ${summarize(cap?.description ?? '')}\n  matched on: ${(s.evidence ?? []).slice(0, 6).join(', ') || 'task terms'}\n  load: ${load}`;
    if (estimateTokens(block) > perCap) block = `${block.slice(0, perCap * 4 - 1)}…`;
    if (used + estimateTokens(block) + 1 > maxTokens) {
      omitted.push(s.capabilityId);
      continue;
    }
    used += estimateTokens(block) + 1;
    blocks.push(block);
    offered.push(s.capabilityId);
  }
  if (!blocks.length) return { text: '', tokens: 0, offered: [], omitted, perCapability: [] };
  const text = [header, ...blocks].join('\n');
  return { text, tokens: estimateTokens(text), offered, omitted, perCapability: blocks };
}
