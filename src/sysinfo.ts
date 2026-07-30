import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parsePsTable } from './discovery.js';
import type { ProcessInfo } from './types.js';

const execFileAsync = promisify(execFile);

/** Snapshot the process table (pid, ppid, tty, command). */
export async function processTable(): Promise<ProcessInfo[]> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid,ppid,tty,command'], {
    timeout: 10_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return parsePsTable(stdout);
}

/** Resolve a process's working directory via lsof; undefined when unavailable. */
export async function processCwd(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      timeout: 10_000,
    });
    const line = stdout.split('\n').find((l) => l.startsWith('n'));
    return line?.slice(1);
  } catch {
    return undefined;
  }
}
