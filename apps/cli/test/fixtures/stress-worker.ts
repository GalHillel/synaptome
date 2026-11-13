/**
 * One writer of the concurrency stress test (`stress.test.ts`), run as its own process: the same calls an interface
 * makes (settings changes, events, installs and rollbacks into a sandbox host), as fast as it can.
 *   node --import tsx stress-worker.ts <home> <worker number> <rounds> <claude root>
 */
import { emit, openSystem, setOrigin } from '@synaptome/core';
import { createApi } from '@synaptome/service';

const [home, who, roundsArg, claudeRoot] = process.argv.slice(2);
const rounds = Number(roundsArg);
const sys = openSystem(home);
const origin = ['cli', 'tui', 'web', 'mcp'][Number(who) % 4];
setOrigin(origin);
const api = createApi(sys, { claudeRoot, origin });
const errors: string[] = [];
let installs = 0;
for (let i = 0; i < rounds; i++) {
  try {
    emit(sys.db, 'stress.tick', `w${who}`, { i });
    await api.call('settings.set', { key: 'ui.theme', value: ['dark', 'light', 'auto'][(i + Number(who)) % 3] });
    if (i % 5 === 0) {
      // Every worker installs and rolls back the SAME capability: the host lock and the one-live-installation rule
      // must keep the host and the records consistent while they race.
      try {
        const inst = await api.call('capabilities.install', { id: 'acme.shared' });
        installs++;
        await api.call('installations.rollback', { id: inst.id });
      } catch (e: any) {
        // Losing a race is allowed (busy, already rolled back by another worker, or not installed any more); corruption is not.
        if (!/busy|not installed|is "rolled_back"|is "superseded"|is "uninstalled"|Another process|no longer carries/.test(e.message)) errors.push(`install/rollback: ${e.message}`);
      }
    }
    await api.call('system.overview');
  } catch (e: any) {
    errors.push(e.message);
  }
}
sys.close();
process.stdout.write(JSON.stringify({ who, rounds, installs, errors }) + '\n');
