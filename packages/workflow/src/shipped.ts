import fs from 'node:fs';
import path from 'node:path';
import type { Sys } from '@synaptome/core';
import { type WorkflowDefinition, validateWorkflow } from './definition';

/** Workflows that ship with Synaptome. They only call the same API the CLI and dashboard use. */
export const SHIPPED_WORKFLOWS: unknown[] = [
  {
    id: 'capability.acquire',
    version: '1',
    title: 'Find, audit and stage a capability',
    description: 'Searches GitHub for a need, audits the best match in quarantine, installs it into the sandbox host only, reads the installation back and reports. Nothing reaches a real host.',
    inputs: {
      need: { type: 'string', description: 'what the capability should do, in a few words' },
      limit: { type: 'number', required: false, default: 5, description: 'how many search results to consider' },
    },
    permissions: ['network', 'write', 'configuration'],
    steps: [
      { id: 'discover', title: 'Search GitHub for the need', kind: 'api-call', permissions: ['network'], retry: { max: 2, backoffMs: 2000 }, with: { command: 'scan.run', args: { mode: 'need', query: '${inputs.need}', sources: ['github'], limit: '${inputs.limit}' } }, output: { required: ['reports'] } },
      { id: 'audit', title: 'Quarantine, audit and gate the best match', kind: 'api-call', needs: ['discover'], permissions: ['network'], timeoutMs: 600_000, with: { command: 'candidates.evaluate', args: { id: '${steps.discover.output.reports.0.candidateIds.0}' } }, output: { required: ['state'] } },
      // Only when the gate asked for a person: the run waits here for that person's decision (permission "configuration").
      { id: 'approve', title: 'A person approves the capability', kind: 'api-call', needs: ['audit'], permissions: ['configuration'], when: { path: 'steps.audit.output.gate.decision', equals: 'needs-approval' }, with: { command: 'capabilities.approve', args: { id: '${steps.audit.output.capabilityId}' } } },
      { id: 'stage', title: 'Install into the sandbox host', kind: 'api-call', needs: ['audit', 'approve'], ifNeedsSkipped: 'run', permissions: ['write'], when: { path: 'steps.audit.output.state', equals: 'registered' }, continueOnError: true, with: { command: 'capabilities.install', args: { id: '${steps.audit.output.capabilityId}', host: 'claude-code' } } },
      { id: 'verify', title: 'Read the capability and its installations back', kind: 'api-call', needs: ['stage'], ifNeedsSkipped: 'run', with: { command: 'capabilities.get', args: { id: '${steps.audit.output.capabilityId}' } }, output: { required: ['capability'] } },
      {
        id: 'report', title: 'Report', kind: 'noop', needs: ['verify'],
        with: { value: { need: '${inputs.need}', candidate: '${steps.discover.output.reports.0.candidateIds.0}', capability: '${steps.audit.output.capabilityId}', tier: '${steps.audit.output.tier}', gate: '${steps.audit.output.gate.decision}', approval: '${steps.approve.status}', stage: '${steps.stage.status}', installation: '${steps.stage.output.id}', verified: '${steps.stage.output.verifyDetail}', status: '${steps.verify.output.capability.status}' } },
      },
    ],
  },
  {
    id: 'capability.forge-gap',
    version: '1',
    title: 'Draft a capability for a gap and check it',
    description: 'Creates a forge draft for a capability gap (after searching for alternatives), asks a model to write it when one is available, then runs the deterministic forge checks. Promotion stays a separate, human decision.',
    inputs: { gap: { type: 'string', description: 'the gap term, as listed by synaptome gaps, or a short need' } },
    permissions: ['write', 'api'],
    steps: [
      { id: 'draft', title: 'Create the draft workspace', kind: 'api-call', permissions: ['write'], with: { command: 'forge.new', args: { gap: '${inputs.gap}' } }, output: { required: ['id'] } },
      { id: 'author', title: 'Write the draft with a model (if available)', kind: 'api-call', needs: ['draft'], permissions: ['api'], continueOnError: true, timeoutMs: 900_000, with: { command: 'forge.author', args: { id: '${steps.draft.output.id}' } } },
      { id: 'check', title: 'Run the forge checks', kind: 'api-call', needs: ['author'], permissions: ['write'], with: { command: 'forge.check', args: { id: '${steps.draft.output.id}' } }, output: { required: ['state'] } },
      { id: 'report', title: 'Report', kind: 'noop', needs: ['check'], with: { value: { gap: '${inputs.gap}', forge: '${steps.draft.output.id}', authored: '${steps.author.output.status}', authorDetail: '${steps.author.output.detail}', state: '${steps.check.output.state}', path: '${steps.draft.output.path}' } } },
    ],
  },
];

const teamCtx = (extra: Record<string, string>) => ({ task: '${inputs.task}', workdir: '${inputs.workdir}', provider: '${inputs.provider}', ...extra });
SHIPPED_WORKFLOWS.push({
  id: 'team.build',
  version: '1',
  title: 'Build a small change with a specialist team',
  description: 'Research, architecture and implementation, then review and tests in parallel, one repair round when the review asks for changes, and a final test run. Works only in a git repository you name, so every change stays reviewable (git diff) and reversible. Running tests waits for your approval.',
  inputs: {
    task: { type: 'string', description: 'what to build or change' },
    workdir: { type: 'string', description: 'a git repository to work in' },
    provider: { type: 'string', required: false, default: '', description: 'provider id; empty = the preferred available one' },
  },
  permissions: ['api', 'write', 'shell'],
  budget: { tokens: 3_000_000, ms: 90 * 60_000 },
  steps: [
    { id: 'research', title: 'Research', kind: 'agent', permissions: ['api'], timeoutMs: 900_000, retry: { max: 1, backoffMs: 5000 }, with: { agent: 'researcher', ...teamCtx({}) } },
    { id: 'design', title: 'Architecture', kind: 'agent', needs: ['research'], permissions: ['api'], timeoutMs: 900_000, retry: { max: 1, backoffMs: 5000 }, with: { agent: 'architect', ...teamCtx({}), context: { research: '${steps.research.output.text}' } } },
    { id: 'implement', title: 'Implementation', kind: 'agent', needs: ['design'], permissions: ['api', 'write'], timeoutMs: 1_200_000, with: { agent: 'implementer', ...teamCtx({}), context: { plan: '${steps.design.output.text}' } } },
    { id: 'review', title: 'Review', kind: 'agent', needs: ['implement'], permissions: ['api'], timeoutMs: 900_000, retry: { max: 1, backoffMs: 5000 }, with: { agent: 'reviewer', ...teamCtx({}), context: { plan: '${steps.design.output.summary}', implementation: '${steps.implement.output.summary}' } } },
    { id: 'test', title: 'Testing', kind: 'agent', needs: ['implement'], permissions: ['api', 'write', 'shell'], timeoutMs: 900_000, with: { agent: 'tester', ...teamCtx({}), context: { plan: '${steps.design.output.summary}', implementation: '${steps.implement.output.summary}' } } },
    { id: 'fix', title: 'Repair round', kind: 'agent', needs: ['review', 'test'], permissions: ['api', 'write'], when: { path: 'steps.review.output.verdict', equals: 'changes' }, timeoutMs: 1_200_000, with: { agent: 'implementer', ...teamCtx({}), context: { review: '${steps.review.output.text}', tests: '${steps.test.output.summary}' } } },
    { id: 'retest', title: 'Final tests', kind: 'agent', needs: ['fix'], permissions: ['api', 'write', 'shell'], timeoutMs: 900_000, with: { agent: 'tester', ...teamCtx({}), context: { repair: '${steps.fix.output.summary}' } } },
    {
      id: 'report', title: 'Report', kind: 'noop', needs: ['retest'], ifNeedsSkipped: 'run',
      with: { value: { task: '${inputs.task}', research: '${steps.research.output.summary}', design: '${steps.design.output.summary}', implementation: '${steps.implement.output.summary}', changes: '${steps.implement.output.changes}', review: '${steps.review.output.verdict}', reviewSummary: '${steps.review.output.summary}', tests: '${steps.test.output.verdict}', testSummary: '${steps.test.output.summary}', repair: '${steps.fix.status}', finalTests: '${steps.retest.output.verdict}' } },
    },
  ],
});

export interface WorkflowEntry {
  def: WorkflowDefinition;
  origin: 'shipped' | 'home';
  file?: string;
}

/** Shipped workflows plus the owner's own from <home>/workflows/*.json. Invalid files are reported, never run. */
export function loadWorkflows(sys: Sys): { workflows: WorkflowEntry[]; problems: { file: string; errors: string[] }[] } {
  const workflows: WorkflowEntry[] = [];
  const problems: { file: string; errors: string[] }[] = [];
  for (const raw of SHIPPED_WORKFLOWS) {
    const v = validateWorkflow(raw);
    if (!v.ok) throw new Error(`shipped workflow is invalid: ${v.errors.join('; ')}`);
    workflows.push({ def: v.def, origin: 'shipped' });
  }
  const dir = path.join(sys.home, 'workflows');
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
      const file = path.join(dir, name);
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e: any) {
        problems.push({ file, errors: [`not valid JSON: ${e.message}`] });
        continue;
      }
      const v = validateWorkflow(raw);
      if (!v.ok) problems.push({ file, errors: v.errors });
      else if (workflows.some((w) => w.def.id === v.def.id)) problems.push({ file, errors: [`id "${v.def.id}" is already taken`] });
      else workflows.push({ def: v.def, origin: 'home', file });
    }
  }
  return { workflows, problems };
}

export function findWorkflow(sys: Sys, id: string): WorkflowEntry | null {
  return loadWorkflows(sys).workflows.find((w) => w.def.id === id) ?? null;
}
