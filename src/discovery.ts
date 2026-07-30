import type { ClaudeProcess, DiscoveredSession, ItermSession, ProcessInfo } from './types.js';

/** Parse `ps -axo pid,ppid,tty,command` output into a process table. */
export function parsePsTable(output: string): ProcessInfo[] {
  const rows: ProcessInfo[] = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      tty: match[3]!,
      command: match[4]!.trim(),
    });
  }
  return rows;
}

/**
 * Interactive Claude Code processes: the executable is `claude` (bare or by
 * path), attached to a tty, and not running headless (`-p`/`--print`).
 */
export function findClaudeProcesses(table: ProcessInfo[]): ClaudeProcess[] {
  return table.filter((p) => {
    if (!p.tty.startsWith('tty')) return false;
    const [executable = '', ...args] = p.command.split(/\s+/);
    const basename = executable.split('/').pop();
    if (basename !== 'claude') return false;
    return !args.includes('-p') && !args.includes('--print');
  });
}

/**
 * All ttys seen while walking from `pid` up the parent chain. Shell wrappers
 * (kiro-cli-term, script, etc.) run claude on a nested PTY, so the tty iTerm2
 * reports for the tab appears further up the chain, not on claude itself.
 */
export function ancestorTtys(table: ProcessInfo[], pid: number): string[] {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const ttys: string[] = [];
  const seen = new Set<number>();
  let current = byPid.get(pid);
  while (current && !seen.has(current.pid)) {
    seen.add(current.pid);
    if (current.tty.startsWith('tty') && !ttys.includes(current.tty)) {
      ttys.push(current.tty);
    }
    current = byPid.get(current.ppid);
  }
  return ttys;
}

/** Match iTerm2 sessions to claude processes via the ancestor tty chain. */
export function matchSessionsToProcesses(
  sessions: ItermSession[],
  table: ProcessInfo[],
  procs: ClaudeProcess[],
): DiscoveredSession[] {
  const matched: DiscoveredSession[] = [];
  const claimed = new Set<number>();
  for (const session of sessions) {
    const shortTty = session.tty.replace(/^\/dev\//, '');
    const process = procs.find(
      (p) => !claimed.has(p.pid) && ancestorTtys(table, p.pid).includes(shortTty),
    );
    if (process) {
      claimed.add(process.pid);
      matched.push({ session, process });
    }
  }
  return matched;
}
