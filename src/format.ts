import type { Detection } from './detector.js';
import type { JournalEntry } from './journal.js';

export function shortenHome(path: string | undefined, home: string): string {
  if (!path) return '-';
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Clock time as the user reads it on screen — the machine's local zone. */
export function localTime(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function describeDetection(detection: Detection): string {
  switch (detection.kind) {
    case 'none':
      return 'working / idle';
    case 'permission-prompt':
      return 'waiting on permission prompt';
    case 'question-menu':
      return 'waiting on a question';
    case 'limit-menu':
    case 'limit-idle': {
      const { resetAt } = detection;
      return resetAt ? `limit hit · resets ${localTime(resetAt)}` : 'limit hit';
    }
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function summarizeJournal(entries: JournalEntry[]): string {
  const count = (event: JournalEntry['event']) => entries.filter((e) => e.event === event).length;
  const confirmed = count('resume-confirmed');
  const failed = count('resume-failed');
  // A resume is only interesting together with its outcome: a run full of
  // "resume-sent" with nothing confirmed is the signal something went wrong.
  const outcome =
    confirmed || failed ? ` (${confirmed} confirmed, ${failed} failed)` : '';
  return [
    plural(count('auto-approve'), 'auto-approval'),
    `${plural(count('question-answered'), 'question')} answered`,
    `${plural(count('resume-sent'), 'resume')}${outcome}`,
  ].join(', ');
}

export function formatTable(headers: string[], rows: string[][]): string[] {
  const all = [['#', ...headers], ...rows.map((row, i) => [String(i + 1), ...row])];
  const widths = all[0]!.map((_, col) => Math.max(...all.map((row) => (row[col] ?? '').length)));
  return all.map((row) =>
    row
      .map((cell, col) => (col === row.length - 1 ? cell : cell.padEnd(widths[col]!)))
      .join('  ')
      .replace(/\s+$/, '')
      .replace(/^/, '  '),
  );
}
