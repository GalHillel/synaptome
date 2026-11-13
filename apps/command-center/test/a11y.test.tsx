/**
 * Accessibility audit of every screen with axe-core, on markup rendered from real API data (a seeded throwaway
 * registry, the same service the dashboard calls). Colour contrast is not measurable without a browser's CSS engine;
 * it is covered by the ui-tokens contrast test instead.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { tempSystem } from '@synaptome/core';
import { addEvalCases } from '@synaptome/evaluation';
import { createApi } from '@synaptome/service';
import { startRun } from '@synaptome/workflow';
import { seedBenchmark } from '../../../packages/router/src/benchmark/run';

const h = vi.hoisted(() => ({ store: new Map<string, unknown>(), asked: new Map<string, [string, unknown]>() }));
vi.mock('../src/lib', async (importOriginal) => {
  const orig = await importOriginal<any>();
  const app = { rev: 0, events: [], online: true, view: 'audit', params: {}, go() {}, selection: null, open() {}, toast() {}, confirm: async () => false, run: async () => undefined };
  return {
    ...orig,
    useApp: () => app,
    useQuery: (name: string | null, args: unknown = {}) => {
      if (!name) return { loading: false, reload() {} };
      const key = `${name}:${JSON.stringify(args)}`;
      h.asked.set(key, [name, args]);
      return { data: h.store.get(key), loading: !h.store.has(key), reload() {} };
    },
  };
});

const views = await import('../src/views');
const screens = await import('../src/screens');
const graph = await import('../src/graph');
const axeSource = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

let sys: ReturnType<typeof tempSystem>;
let api: ReturnType<typeof createApi>;
let runId: string;
beforeAll(() => {
  sys = tempSystem();
  seedBenchmark(sys);
  api = createApi(sys, { origin: 'audit' });
  runId = startRun(sys, { id: 'audit.flow', title: 'Audit flow', steps: [{ id: 'one', kind: 'noop' }, { id: 'two', kind: 'approval', needs: ['one'] }] });
  addEvalCases(sys, 'bench.release-notes', [{ kind: 'behaviour', prompt: 'Write release notes for 2.1', must: ['Added'] }], { split: 'heldout', author: 'person:auditor' });
});
afterAll(() => sys.dispose());

/** Renders until every query the screen asks for has an answer from the real API. */
async function render(el: ReturnType<typeof createElement>): Promise<string> {
  for (let pass = 0; pass < 4; pass++) {
    h.asked.clear();
    renderToString(el);
    const missing = [...h.asked].filter(([k]) => !h.store.has(k));
    if (!missing.length) break;
    for (const [k, [name, args]] of missing) h.store.set(k, await api.call(name, args).catch(() => null));
  }
  return renderToString(el);
}

async function audit(html: string) {
  const dom = new JSDOM(`<!doctype html><html lang="en"><head><title>Synaptome audit</title></head><body><main>${html}</main></body></html>`, { runScripts: 'outside-only' });
  dom.window.eval(axeSource);
  const r = await (dom.window as any).axe.run(dom.window.document, { rules: { 'color-contrast': { enabled: false } } });
  return r.violations.map((v: any) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.slice(0, 2).map((n: any) => n.html.slice(0, 120)).join(' | ')}`);
}

const SCREENS: [string, () => ReturnType<typeof createElement>][] = [
  ['Overview', () => createElement(views.Overview)],
  ['Library', () => createElement(views.Library)],
  ['Discovery', () => createElement(views.Discovery)],
  ['Queue', () => createElement(views.Queue)],
  ['Security', () => createElement(views.Security)],
  ['Routing', () => createElement(views.Routing)],
  ['Forge', () => createElement(views.Forge)],
  ['Workflows', () => createElement(views.Workflows)],
  ['Run inspector', () => createElement(views.RunInspector, { id: runId })],
  ['Activity', () => createElement(views.Activity)],
  ['Settings', () => createElement(views.Settings, { theme: 'auto', setTheme() {} })],
  ['Capability graph', () => createElement(graph.Graph)],
  ['Get started', () => createElement(screens.GetStarted)],
  ['Sources', () => createElement(screens.Sources)],
  ['Source inspector', () => createElement(screens.SourceInspector, { id: 'github' })],
  ['Notifications', () => createElement(screens.Notifications)],
  ['Integrations', () => createElement(screens.Integrations)],
  ['Agents', () => createElement(screens.Agents)],
  ['Evaluation Lab', () => createElement(screens.EvalLab)],
  ['Eval set inspector', () => createElement(screens.EvalSetInspector, { id: 'bench.release-notes' })],
];

describe('accessibility (axe-core, WCAG rules except colour contrast)', () => {
  for (const [name, make] of SCREENS) {
    it(`${name} has no violations`, async () => {
      const html = await render(make());
      expect(html.length).toBeGreaterThan(200);
      const violations = await audit(html);
      expect(violations, `\n${violations.join('\n')}`).toEqual([]);
    }, 30_000);
  }
});
