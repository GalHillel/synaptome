// Child process for the cross-process reservation test: waits until a shared start instant, then tries to reserve.
// Prints "ok" or "refused". Arguments: <home> <runId> <tokens> <startAtMs>.
import { openSystem } from '@synaptome/core';
import { BudgetRefused, reserve } from '../src/budget';

const [home, runId, tokens, startAt] = process.argv.slice(2);
const sys = openSystem(home);
while (Date.now() < Number(startAt)) {
  /* spin to the shared start instant, so all children contend at once */
}
try {
  reserve(sys, runId, `child-${process.pid}`, { tokens: Number(tokens), usd: null });
  process.stdout.write('ok');
} catch (e) {
  process.stdout.write(e instanceof BudgetRefused ? 'refused' : `error ${(e as Error).message}`);
} finally {
  sys.close();
}
