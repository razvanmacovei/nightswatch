import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface JournalEvent {
  event:
    | 'watch-start'
    | 'watch-stop'
    | 'auto-approve'
    | 'limit-detected'
    | 'stop-and-wait-selected'
    | 'resume-scheduled'
    | 'resume-sent'
    | 'session-gone'
    | 'error';
  sessionId: string;
  sessionName: string;
  detail: string;
}

export interface JournalEntry extends JournalEvent {
  at: string;
}

export interface Journal {
  record(event: JournalEvent): void;
}

function localDateStamp(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function journalFileFor(dir: string, date: Date): string {
  return join(dir, `journal-${localDateStamp(date)}.jsonl`);
}

export function createJournal(dir: string, now: () => Date = () => new Date()): Journal {
  return {
    record(event) {
      const at = now();
      mkdirSync(dir, { recursive: true });
      // `at` keeps the local date in the ISO string so journal-file date and
      // entry timestamps agree even across midnight UTC.
      const offsetMs = at.getTimezoneOffset() * 60_000;
      const localIso = new Date(at.getTime() - offsetMs).toISOString().replace('Z', '');
      const entry: JournalEntry = { at: localIso, ...event };
      appendFileSync(journalFileFor(dir, at), `${JSON.stringify(entry)}\n`);
    },
  };
}

export function readJournalEntries(dir: string, date: Date): JournalEntry[] {
  let raw: string;
  try {
    raw = readFileSync(journalFileFor(dir, date), 'utf8');
  } catch {
    return [];
  }
  const entries: JournalEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as JournalEntry);
    } catch {
      // Skip corrupt lines; a half-written line must not break `nightswatch log`.
    }
  }
  return entries;
}
