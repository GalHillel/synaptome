/**
 * A demo home for screenshots and the landing page (Phase 12 S2): the 70 labelled benchmark capabilities, a few
 * routed tasks with outcomes, one sandbox install, and capabilities waiting for approval. Its path is what screenshots
 * show, so put it somewhere without a personal name in it, and point SYNAPTOME_CLAUDE_ROOT at an empty folder beside it.
 *
 *   npx tsx scripts/demo-home.ts <home>
 */
import path from 'node:path';
import { openSystem, setOrigin, upsertCapability } from '@synaptome/core';
import { BENCH_TASKS, recordOutcome, seedBenchmark } from '@synaptome/router';
import { createApi } from '@synaptome/service';

if (!process.argv[2]) throw new Error('usage: demo-home.ts <home>');
const home = path.resolve(process.argv[2]);
const sys = openSystem(home);
setOrigin('cli');
const n = seedBenchmark(sys);
// A few that wait for a decision.
for (const [name, domain, description] of [
  ['incident-postmortem', 'devops', 'Write a blameless incident postmortem with timeline, impact, causes and follow-ups'],
  ['api-changelog', 'docs', 'Summarise API changes between two OpenAPI files as a changelog for client developers'],
  ['sql-explain-reader', 'data', 'Read a SQL execution plan and point out the expensive steps and missing indexes'],
] as const) {
  upsertCapability(sys, { id: `demo.${name}`, name, description, kind: 'skill', domain, tags: name.split('-'), entryFile: 'SKILL.md', quality: { total: 84 }, security: { tier: 'A', trust: 'REVIEWED_COMMUNITY' } }, { status: 'registered', body: `# ${name}\n\n${description}` });
}
const api = createApi(sys, { claudeRoot: process.env.SYNAPTOME_CLAUDE_ROOT, origin: 'cli' });
let routed = 0;
for (const t of BENCH_TASKS.filter((x) => x.category === 'simple' || x.category === 'multi-domain').slice(0, 12)) {
  const d = await api.call('routing.route', { task: t.task });
  if (d.selected.length) recordOutcome(sys, { decisionId: d.id, outcome: routed % 4 === 3 ? 'partial' : 'success' });
  routed++;
}
const inst = await api.call('capabilities.install', { id: 'b.unit-test-writing' });
process.stdout.write(`demo home ${home}: ${n + 3} capabilities, ${routed} routed tasks, sandbox install ${inst.id}\n`);
sys.close();
