import { describe, expect, test } from 'vitest';
import {
  ancestorTtys,
  findClaudeProcesses,
  matchSessionsToProcesses,
  parsePsTable,
} from './discovery.js';
import type { ItermSession } from './types.js';

// Real-world shape captured on macOS, including the nested-PTY case where a
// shell wrapper (kiro-cli-term) gives claude a different tty than the iTerm2 tab.
const PS_OUTPUT = `  PID  PPID TTY      COMMAND
    1     0 ??       /sbin/launchd
54746     1 ??       /Applications/iTerm.app/Contents/MacOS/iTerm2
54747 54746 ttys000  login -fp razvanmac
54748 54747 ttys000  zsh (kiro-cli-term)
54757 54748 ttys001  /bin/zsh --login
55402 54757 ttys001  claude
55415 55402 ttys001  npm exec chrome-devtools-mcp@1.6.0
73971 54746 ttys002  login -fp razvanmac
73972 73971 ttys002  zsh (kiro-cli-term)
80001 73972 ttys003  /bin/zsh --login
80002 80001 ttys003  /Users/razvanmac/.local/bin/claude --continue
90001 54746 ttys004  login -fp razvanmac
90002 90001 ttys004  -zsh
99999     1 ??       claude -p --output-format json --model haiku
`;

describe('parsePsTable', () => {
  test('parses pid, ppid, tty and command from ps output', () => {
    const table = parsePsTable(PS_OUTPUT);
    const claude = table.find((p) => p.pid === 55402);
    expect(claude).toEqual({
      pid: 55402,
      ppid: 54757,
      tty: 'ttys001',
      command: 'claude',
    });
  });

  test('skips the header line', () => {
    const table = parsePsTable(PS_OUTPUT);
    expect(table.some((p) => Number.isNaN(p.pid))).toBe(false);
  });
});

describe('findClaudeProcesses', () => {
  test('finds bare and path-prefixed interactive claude processes', () => {
    const pids = findClaudeProcesses(parsePsTable(PS_OUTPUT)).map((p) => p.pid);
    expect(pids).toContain(55402);
    expect(pids).toContain(80002);
  });

  test('ignores headless claude (-p) and processes without a tty', () => {
    const pids = findClaudeProcesses(parsePsTable(PS_OUTPUT)).map((p) => p.pid);
    expect(pids).not.toContain(99999);
  });

  test('ignores unrelated processes mentioning claude in arguments', () => {
    const table = parsePsTable(
      `  PID  PPID TTY      COMMAND\n123 1 ttys009  vim claude-notes.md\n`,
    );
    expect(findClaudeProcesses(table)).toEqual([]);
  });
});

describe('ancestorTtys', () => {
  test('collects every tty in the ancestor chain (nested PTY wrapper case)', () => {
    const table = parsePsTable(PS_OUTPUT);
    const ttys = ancestorTtys(table, 55402);
    expect(ttys).toContain('ttys001');
    expect(ttys).toContain('ttys000');
  });

  test('stops at processes without a parent in the table', () => {
    const table = parsePsTable(PS_OUTPUT);
    expect(() => ancestorTtys(table, 90002)).not.toThrow();
  });
});

describe('matchSessionsToProcesses', () => {
  const sessions: ItermSession[] = [
    { id: 'S-AAA', tty: '/dev/ttys000', name: 'claude tab', windowIndex: 0, tabIndex: 0 },
    { id: 'S-BBB', tty: '/dev/ttys002', name: 'other claude tab', windowIndex: 0, tabIndex: 1 },
    { id: 'S-CCC', tty: '/dev/ttys004', name: 'plain zsh', windowIndex: 1, tabIndex: 0 },
  ];

  test('matches claude processes to iTerm2 sessions through the ancestor tty chain', () => {
    const table = parsePsTable(PS_OUTPUT);
    const procs = findClaudeProcesses(table);
    const matched = matchSessionsToProcesses(sessions, table, procs);
    expect(matched.map((m) => [m.session.id, m.process.pid])).toEqual([
      ['S-AAA', 55402],
      ['S-BBB', 80002],
    ]);
  });

  test('sessions without a claude process are not matched', () => {
    const table = parsePsTable(PS_OUTPUT);
    const procs = findClaudeProcesses(table);
    const matched = matchSessionsToProcesses(sessions, table, procs);
    expect(matched.some((m) => m.session.id === 'S-CCC')).toBe(false);
  });
});
