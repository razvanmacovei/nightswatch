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

export type SessionSelection =
  | { kind: 'all' }
  | { kind: 'one'; session: DiscoveredSession }
  | { kind: 'error'; message: string };

/**
 * Resolve a watch selector. Numeric indexes match `nightswatch ls` order but
 * are unstable (iTerm2 windows re-order by focus), so a directory substring
 * is the reliable way to pin a session.
 */
export function selectSessions(
  discovered: DiscoveredSession[],
  selector: string,
): SessionSelection {
  if (selector === '--all') return { kind: 'all' };
  if (/^\d+$/.test(selector)) {
    const picked = discovered[Number(selector) - 1];
    return picked
      ? { kind: 'one', session: picked }
      : { kind: 'error', message: `No session ${selector}. Run \`nightswatch ls\` (1-${discovered.length}).` };
  }
  const needle = selector.toLowerCase();
  const matches = discovered.filter((d) => (d.cwd ?? '').toLowerCase().includes(needle));
  if (matches.length === 1) return { kind: 'one', session: matches[0]! };
  if (matches.length === 0) {
    return { kind: 'error', message: `No session directory matches "${selector}".` };
  }
  return {
    kind: 'error',
    message: `"${selector}" matches ${matches.length} sessions: ${matches.map((m) => m.cwd).join(', ')}. Be more specific.`,
  };
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
