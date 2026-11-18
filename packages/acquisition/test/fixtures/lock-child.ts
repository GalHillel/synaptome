// Child process for the host-lock crash and contention test (install-matrix.test.ts).
//   hold-forever <home> <target>               take the lock, print "held", never release (the parent kills it)
//   contend <home> <target> <startAt> <holdMs>  wait for the shared instant, take the lock, hold, release, print "done"
import { openSystem } from '@synaptome/core';
import { withHostLock } from '../../src/index';

const [mode, home, target, startAt, holdMs] = process.argv.slice(2);
const sys = openSystem(home);
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
if (mode === 'hold-forever') {
  withHostLock(sys, target, () => {
    process.stdout.write('held\n');
    for (;;) sleep(1000);
  });
} else {
  while (Date.now() < Number(startAt)) {
    /* spin to the shared instant */
  }
  try {
    withHostLock(sys, target, () => sleep(Number(holdMs)), 30_000);
    process.stdout.write('done');
  } catch (e) {
    process.stdout.write(`error ${(e as Error).message}`);
  }
  sys.close();
}
