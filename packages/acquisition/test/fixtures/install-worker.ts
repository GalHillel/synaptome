// Runs one install in its own OS process, so the matrix can test real concurrency between processes.
// Usage: node --import tsx install-worker.ts <home> <claudeRoot> <capabilityId> <startAtMs>
import { buildAdapterRegistry } from '@synaptome/adapters';
import { openSystem } from '@synaptome/core';
import { ConnectorRegistry } from '@synaptome/discovery';
import { install } from '../../src/index';

const [home, claudeRoot, capabilityId, startAt] = process.argv.slice(2);
const sys = openSystem(home);
const deps = { connectors: new ConnectorRegistry(), adapters: buildAdapterRegistry({ claudeRoot }) };
// Every worker starts at the same instant, after its loader has warmed up.
while (Date.now() < Number(startAt)) {
  /* spin */
}
try {
  const r = install(sys, deps, capabilityId, { host: 'claude-code', scope: 'sandbox', by: 'worker' });
  process.stdout.write(JSON.stringify({ ok: true, id: r.id }));
} catch (e: any) {
  process.stdout.write(JSON.stringify({ ok: false, code: e.code ?? null, message: e.message }));
} finally {
  sys.close();
}
