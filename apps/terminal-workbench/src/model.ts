/**
 * The Terminal Workbench's views, in navigation order (keys 1-9). Each view lives in `views/<id>.ts`; shared types,
 * status marks, line helpers and actions are in `kit.ts`. Everything goes through the same command surface
 * (`api.call`) that the Web Command Center uses over HTTP, so both interfaces show the same state.
 */
import type { ViewDef } from './kit';
import { view as overview } from './views/overview';
import { view as discover } from './views/discover';
import { view as skills } from './views/skills';
import { view as queue } from './views/queue';
import { view as security } from './views/security';
import { view as routing } from './views/routing';
import { view as forge } from './views/forge';
import { view as workflows } from './views/workflows';
import { view as logs } from './views/logs';
import { view as settings } from './views/settings';
import { view as sources } from './views/sources';
import { view as notifications } from './views/notifications';
import { view as integrations } from './views/integrations';
import { view as agents } from './views/agents';
import { view as evals } from './views/evals';
import { view as start } from './views/start';
import { view as network } from './views/network';

export * from './kit';

/** One or two sentences per view, shown at the top of the help overlay (?). */
export const ABOUT: Record<string, string> = {
  overview: 'What the system holds and whether it is healthy: capabilities by status, installations, recent decisions and the diagnostics.',
  discover: 'Candidates found by the discovery sources, before and after evaluation. Scanning never installs anything.',
  skills: 'The registry: every capability with its status, security tier and quality. Approve, reject, install to a sandbox host or roll back.',
  queue: 'What waits for a person: capabilities pending approval and candidates waiting for evaluation.',
  security: 'Audit findings, blocked capabilities and the promotion gate. Nothing that failed the audit is routed or installed.',
  routing: 'Routing decisions: which capabilities were chosen for a task and why, with confidence, budget and the candidates left out.',
  forge: 'Skill Forge: drafts written for routing gaps, their checks, evaluations and promotion decisions.',
  workflows: 'Workflow runs and definitions. Start a workflow, approve a waiting step, resume or cancel a run.',
  logs: 'The shared event log. Every change made from the CLI, the Web Command Center or here appears once, with where it came from.',
  network: 'The capability graph as text: domains as a tree, each capability with its links. On a domain, a then Enter expands or collapses it; on a capability, a lists jumps to linked capabilities. A filter opens every domain with a match.',
  sources: 'Where capabilities are discovered: health, access terms, backoff, daily budgets and recent checks. Switch a source off or set its budget.',
  notifications: 'Things that need a person: approvals waiting, updates that change risk, failing sources, publisher changes. Each cause appears once.',
  integrations: 'Model providers (where task text may go; VERIFIED only by a recorded live call) and host adapters (where capabilities can be installed).',
  agents: 'The specialists an agent team is made of. They run as workflow steps; start a team from Workflows.',
  evals: 'Evaluation sets with their training and held-out split and authors, and every evaluation run. Promotion uses held-out cases only.',
  settings: 'Every setting with its current value. Changes are shared with the CLI and the Web Command Center.',
  start: 'Five setup steps, each read from the current state of the system, with the next action for each.',
};
/** Keys 1-9 open the first nine; the rest are reached with Tab, left/right or the command palette. */
export const VIEWS: ViewDef[] = [overview, discover, skills, queue, security, routing, forge, workflows, logs, network, sources, notifications, integrations, agents, evals, settings, start];
