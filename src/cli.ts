#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { detect } from './detector.js';
import { findClaudeProcesses, matchSessionsToProcesses, selectSessions } from './discovery.js';
import { describeDetection, formatTable, shortenHome } from './format.js';
import { createItermAdapter, type ItermAdapter } from './iterm.js';
import { createJournal, readJournalEntries } from './journal.js';
import { runJxa } from './jxa.js';
import { processCwd, processTable } from './sysinfo.js';
import type { DiscoveredSession } from './types.js';
import { createWatcher } from './watcher.js';

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// The env overrides exist for tests; the defaults are the product behavior.
const POLL_INTERVAL_MS = envMs('NIGHTSWATCH_POLL_INTERVAL_MS', 3_000);
const COOLDOWN_MS = envMs('NIGHTSWATCH_COOLDOWN_MS', 5_000);
const RESUME_MARGIN_MS = envMs('NIGHTSWATCH_RESUME_MARGIN_MS', 60_000);
const FALLBACK_WAIT_MS = envMs('NIGHTSWATCH_FALLBACK_WAIT_MS', 30 * 60_000);

const JOURNAL_DIR = join(homedir(), '.nightswatch');

const HELP = `nightswatch — keep your Claude Code sessions moving overnight

Usage:
  nightswatch ls                 List Claude Code sessions running in iTerm2
  nightswatch watch <n>          Watch session <n> from \`nightswatch ls\`
  nightswatch watch <dir>        Watch the session whose directory matches <dir>
  nightswatch watch --all        Watch every discovered session
  nightswatch watch <s> --yolo   Also answer questions Claude asks (see below)

Prefer <dir> over <n> when other iTerm2 windows may open or refocus: numeric
indexes follow window order, which changes; a directory match does not.
  nightswatch log [YYYY-MM-DD]   Show the journal for a day (default: today)
  nightswatch --version          Print the version
  nightswatch --help             Show this help

While watching, nightswatch auto-approves permission prompts (the plain "Yes"
option) and, when a usage limit is hit, selects "Stop and wait for limit to
reset", parses the reset time and sends "continue" once the window reopens.

With --yolo, question menus (AskUserQuestion) are answered too: the
"(Recommended)" option when one exists, otherwise the highlighted default;
multi-select questions get "select all" then confirm. Without --yolo,
questions are journaled but left for you to answer.

Safety: watching a session approves EVERY prompt it raises — functionally the
same as --dangerously-skip-permissions. Configure deny rules in Claude Code's
own permission settings before leaving sessions unattended.`;

async function discover(iterm: ItermAdapter): Promise<DiscoveredSession[]> {
  const [sessions, table] = await Promise.all([iterm.listSessions(), processTable()]);
  const procs = findClaudeProcesses(table);
  const matched = matchSessionsToProcesses(sessions, table, procs);
  return Promise.all(
    matched.map(async (m) => ({ ...m, cwd: await processCwd(m.process.pid) })),
  );
}

function log(line: string): void {
  const t = new Date();
  const stamp = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
  console.log(`${stamp} ${line}`);
}

async function cmdLs(iterm: ItermAdapter): Promise<void> {
  const discovered = await discover(iterm);
  if (discovered.length === 0) {
    console.log('No Claude Code sessions found in iTerm2.');
    return;
  }
  const home = homedir();
  const rows = await Promise.all(
    discovered.map(async (d) => {
      const screen = await iterm.readScreen(d.session.id).catch(() => '');
      const state = describeDetection(detect(screen, new Date()));
      return [
        `${d.session.windowIndex}/${d.session.tabIndex}`,
        shortenHome(d.cwd, home),
        state,
      ];
    }),
  );
  for (const line of formatTable(['WIN/TAB', 'DIRECTORY', 'STATE'], rows)) console.log(line);
}

async function cmdWatch(iterm: ItermAdapter, selector: string, yolo: boolean): Promise<void> {
  const discovered = await discover(iterm);
  if (discovered.length === 0) {
    console.error('No Claude Code sessions found in iTerm2. Nothing to watch.');
    process.exitCode = 1;
    return;
  }

  const selection = selectSessions(discovered, selector);
  if (selection.kind === 'error') {
    console.error(selection.message);
    process.exitCode = 1;
    return;
  }
  const targets: DiscoveredSession[] =
    selection.kind === 'all' ? discovered : [selection.session];

  const home = homedir();
  const journal = createJournal(JOURNAL_DIR);
  const watchers = targets.map((d) => {
    const name = shortenHome(d.cwd, home);
    journal.record({
      event: 'watch-start',
      sessionId: d.session.id,
      sessionName: name,
      detail: `pid ${d.process.pid}, tty ${d.session.tty}`,
    });
    log(
      `watching ${name} (window ${d.session.windowIndex}, tab ${d.session.tabIndex}) — auto-yes ON${yolo ? ', yolo ON' : ''}`,
    );
    return {
      name,
      watcher: createWatcher({
        session: { id: d.session.id, name },
        readScreen: async () => {
          try {
            return await iterm.readScreen(d.session.id);
          } catch {
            return null;
          }
        },
        send: (text, opts) => iterm.sendText(d.session.id, text, opts),
        journal: {
          record(event) {
            journal.record(event);
            log(`[${event.sessionName}] ${event.event}${event.detail ? ` — ${event.detail}` : ''}`);
          },
        },
        now: () => new Date(),
        cooldownMs: COOLDOWN_MS,
        resumeMarginMs: RESUME_MARGIN_MS,
        fallbackWaitMs: FALLBACK_WAIT_MS,
        yolo,
      }),
    };
  });

  log(`journal: ${JOURNAL_DIR}`);

  let shuttingDown = false;
  process.on('SIGINT', () => {
    shuttingDown = true;
    for (const w of watchers) {
      journal.record({
        event: 'watch-stop',
        sessionId: '-',
        sessionName: w.name,
        detail: 'stopped by user',
      });
    }
    log('stopped.');
    process.exit(0);
  });

  while (!shuttingDown) {
    for (const w of watchers) {
      if (!w.watcher.stopped) await w.watcher.tick();
    }
    if (watchers.every((w) => w.watcher.stopped)) {
      log('all sessions gone — exiting.');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

function cmdLog(dateArg?: string): void {
  const date = dateArg ? new Date(`${dateArg}T12:00:00`) : new Date();
  if (Number.isNaN(date.getTime())) {
    console.error(`Invalid date "${dateArg}". Use YYYY-MM-DD.`);
    process.exitCode = 1;
    return;
  }
  const entries = readJournalEntries(JOURNAL_DIR, date);
  if (entries.length === 0) {
    console.log('No journal entries for this day.');
    return;
  }
  for (const e of entries) {
    const time = e.at.slice(11, 19);
    console.log(`${time}  [${e.sessionName}] ${e.event}${e.detail ? ` — ${e.detail}` : ''}`);
  }
  const approvals = entries.filter((e) => e.event === 'auto-approve').length;
  const questions = entries.filter((e) => e.event === 'question-answered').length;
  const resumes = entries.filter((e) => e.event === 'resume-sent').length;
  console.log(`\n${approvals} auto-approvals, ${questions} questions answered, ${resumes} resumes.`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(HELP);
    return;
  }
  if (command === '--version' || command === '-v') {
    const require = createRequire(import.meta.url);
    console.log((require('../package.json') as { version: string }).version);
    return;
  }
  if (process.platform !== 'darwin') {
    console.error('nightswatch only supports macOS with iTerm2 (see ADR-0001).');
    process.exitCode = 1;
    return;
  }

  const iterm = createItermAdapter(runJxa);
  switch (command) {
    case 'ls':
      await cmdLs(iterm);
      return;
    case 'watch': {
      const yolo = rest.includes('--yolo');
      const selector = rest.filter((a) => a !== '--yolo')[0];
      if (!selector) {
        console.error('Usage: nightswatch watch <n> | --all [--yolo]');
        process.exitCode = 1;
        return;
      }
      await cmdWatch(iterm, selector, yolo);
      return;
    }
    case 'log':
      cmdLog(rest[0]);
      return;
    default:
      console.error(`Unknown command "${command}". Run \`nightswatch --help\`.`);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
