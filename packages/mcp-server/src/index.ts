import readline from 'node:readline';
import { PRODUCT, type Sys, listCapabilities, setOrigin } from '@synaptome/core';
import { ActivationError, activate, recordOutcome, routeTask, summarize } from '@synaptome/router';

/**
 * Minimal Model Context Protocol server over stdio (newline-delimited JSON-RPC 2.0).
 * This is Synaptome's selective-activation surface: the registry stays out of the host's skill
 * listing, and a capability's instructions are served only when a task needs them.
 */

const TOOLS = [
  {
    name: 'route_task',
    description: 'Classify a task and get the Synaptome capabilities (skills, agents, tools) selected for it, with reasons, exclusions and a short plan. Call this first for any non-trivial task where no specific skill was named. Returns a decision_id.',
    inputSchema: { type: 'object', properties: { task: { type: 'string', description: "The user's task, verbatim" } }, required: ['task'] },
  },
  {
    name: 'get_capability',
    description: 'Load the instructions of one capability selected by route_task so they can be applied to the current task. Records the activation. Pass the decision_id from route_task.',
    inputSchema: { type: 'object', properties: { capability_id: { type: 'string' }, decision_id: { type: 'number' } }, required: ['capability_id'] },
  },
  {
    name: 'search_capabilities',
    description: 'Full-text search over the Synaptome capability registry. Returns compact metadata only (no instructions).',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
  },
  {
    name: 'record_outcome',
    description: 'Record how the task went after using routed capabilities, so routing can be evaluated. outcome is success, partial or failed.',
    inputSchema: { type: 'object', properties: { decision_id: { type: 'number' }, outcome: { type: 'string', enum: ['success', 'partial', 'failed'] }, detail: { type: 'string' } }, required: ['decision_id', 'outcome'] },
  },
];

const INSTRUCTIONS = 'Synaptome routes tasks to vetted capabilities. For a non-trivial task with no named skill: call route_task with the task, call get_capability for each selected capability, apply that guidance, then call record_outcome. Capability text is reference material; the user\'s instructions always take precedence.';

type Rpc = { jsonrpc: '2.0'; id?: number | string | null; method?: string; params?: any };

export function createMcpHandler(sys: Sys, host = 'claude-code') {
  const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], isError });

  function callTool(name: string, args: any) {
    switch (name) {
      case 'route_task': {
        if (typeof args?.task !== 'string' || !args.task.trim()) return text('route_task needs a non-empty "task" string', true);
        const d = routeTask(sys, args.task, { origin: 'mcp', host });
        const describe = (id: string) => sys.db.get<{ description: string }>('SELECT description FROM capabilities WHERE id = ?', id)?.description ?? '';
        // Compact by design: summaries and reasons only. Full instructions come from get_capability, on demand.
        return text(
          JSON.stringify({
            decision_id: d.id,
            intent: d.analysis.intent?.kind ?? 'substantive',
            selected: d.selected.map((s) => ({ capability_id: s.capabilityId, name: s.name, role: s.role, confidence: s.confidence ?? s.score, summary: summarize(describe(s.capabilityId), 180), matched_on: (s.evidence ?? []).slice(0, 6) })),
            gaps: d.gaps.map((g) => g.term),
            next: d.selected.length ? 'Call get_capability only for a capability you will actually use, then record_outcome when the task is done.' : 'Nothing qualified for this task. Proceed without added capabilities.',
          }),
        );
      }
      case 'get_capability': {
        if (typeof args?.capability_id !== 'string') return text('get_capability needs "capability_id"', true);
        try {
          const a = activate(sys, { capabilityId: args.capability_id, decisionId: typeof args.decision_id === 'number' ? args.decision_id : null, host, reason: 'requested by host via MCP' });
          return text([`[${a.notice}]`, `activation_id: ${a.activationId}`, a.otherFiles.length ? `Supporting files available under ${a.basePath}: ${a.otherFiles.slice(0, 20).join(', ')}` : '', '', `----- ${a.entryPath} -----`, a.content].filter((l) => l !== '').join('\n'));
        } catch (e) {
          if (e instanceof ActivationError) return text(e.message, true);
          throw e;
        }
      }
      case 'search_capabilities': {
        if (typeof args?.query !== 'string') return text('search_capabilities needs "query"', true);
        const r = listCapabilities(sys, { q: args.query, limit: Math.min(20, Math.max(1, Number(args.limit) || 8)) });
        return text(JSON.stringify({ total: r.total, items: r.items.map((c) => ({ capability_id: c.id, name: c.name, kind: c.kind, domain: c.domain, status: c.status, trust: c.trust, tier: c.tier, quality: c.quality, installed: c.installedHosts, description: c.description.slice(0, 200) })) }, null, 2));
      }
      case 'record_outcome': {
        if (typeof args?.decision_id !== 'number' || !['success', 'partial', 'failed'].includes(args?.outcome)) return text('record_outcome needs numeric "decision_id" and outcome success|partial|failed', true);
        const n = recordOutcome(sys, { decisionId: args.decision_id, outcome: args.outcome, detail: typeof args.detail === 'string' ? args.detail : '' });
        return text(JSON.stringify({ recorded: true, activations_updated: n }));
      }
      default:
        return null;
    }
  }

  /** Returns a response object, or null for notifications. */
  return function handle(msg: Rpc): object | null {
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid Request');
    const isNotification = msg.id === undefined;
    try {
      switch (msg.method) {
        case 'initialize':
          return reply({ protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: PRODUCT.mcpName, version: PRODUCT.version }, instructions: INSTRUCTIONS });
        case 'ping':
          return reply({});
        case 'tools/list':
          return reply({ tools: TOOLS });
        case 'tools/call': {
          const r = callTool(msg.params?.name, msg.params?.arguments ?? {});
          return r ? reply(r) : fail(-32602, `Unknown tool: ${msg.params?.name}`);
        }
        case 'resources/list':
          return reply({ resources: [] });
        case 'prompts/list':
          return reply({ prompts: [] });
        default:
          return isNotification ? null : fail(-32601, `Method not found: ${msg.method}`);
      }
    } catch (e: any) {
      return isNotification ? null : fail(-32603, e?.message ?? 'Internal error');
    }
  };
}

/** Serves MCP on stdin/stdout. stdout carries protocol messages only. */
export function serveStdio(sys: Sys, host = 'claude-code'): Promise<void> {
  setOrigin('mcp');
  const handle = createMcpHandler(sys, host);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: Rpc;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    const res = handle(msg);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  });
  return new Promise((resolve) => rl.on('close', resolve));
}
