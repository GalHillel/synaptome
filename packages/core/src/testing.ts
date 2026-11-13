import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Sys, openSystem } from './db';

/** Test helper: an isolated system in a temp home. Call dispose() when done. */
export function tempSystem(): Sys & { dispose(): void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synaptome-test-'));
  const sys = openSystem(home);
  return Object.assign(sys, {
    dispose() {
      try {
        sys.close();
      } catch {
        /* already closed */
      }
      fs.rmSync(home, { recursive: true, force: true });
    },
  });
}
