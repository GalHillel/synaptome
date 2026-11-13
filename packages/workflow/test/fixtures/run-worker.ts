// Executes one workflow run in its own OS process, so a test can kill it mid-step and resume the run elsewhere.
// Usage: node --import tsx run-worker.ts <home> <runId>
import { openSystem } from '@synaptome/core';
import { noopRunner, runWorkflow } from '../../src/index';

const [home, runId] = process.argv.slice(2);
const sys = openSystem(home);
const r = await runWorkflow(sys, runId, { runners: { noop: noopRunner } });
process.stdout.write(JSON.stringify(r));
sys.close();
