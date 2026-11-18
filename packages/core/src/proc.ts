import { type ChildProcess, spawnSync } from 'node:child_process';

/**
 * Stops a child process and everything it started (plan NG, M1; audit W1, W2). On Windows `child.kill()` ends only
 * the direct child: when that is `cmd.exe` running `claude.cmd`, the real `claude` process kept running. `taskkill /T`
 * ends the whole tree. Elsewhere the child must have been started with `detached: true` (its own process group), and
 * the group is signalled. Never throws; returns whether a kill was attempted.
 */
export function killProcessTree(child: ChildProcess | { pid?: number }): boolean {
  const pid = child.pid;
  if (!pid) return false;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        process.kill(pid, 'SIGTERM');
      }
      const t = setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }, 2000);
      t.unref();
    }
    return true;
  } catch {
    return false;
  }
}

/** Options for `spawn` so that `killProcessTree` can end the whole tree on every platform. */
export const treeKillable = process.platform === 'win32' ? {} : { detached: true };
