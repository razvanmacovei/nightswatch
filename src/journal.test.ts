import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createJournal, journalFileFor, readJournalEntries } from './journal.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nightswatch-test-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('journalFileFor', () => {
  test('names the file after the local date', () => {
    const date = new Date(2026, 6, 30, 3, 12, 0);
    expect(journalFileFor('/home/x/.nightswatch', date)).toBe(
      '/home/x/.nightswatch/journal-2026-07-30.jsonl',
    );
  });
});

describe('createJournal', () => {
  test('appends one JSON line per event with timestamp and session info', () => {
    const dir = tempDir();
    const journal = createJournal(dir, () => new Date(2026, 6, 30, 3, 12, 5));
    journal.record({
      event: 'auto-approve',
      sessionId: 'S-1',
      sessionName: 'pentx',
      detail: 'permission prompt approved',
    });
    journal.record({
      event: 'resume-sent',
      sessionId: 'S-1',
      sessionName: 'pentx',
      detail: 'sent "continue" after limit reset',
    });
    const lines = readFileSync(join(dir, 'journal-2026-07-30.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first.event).toBe('auto-approve');
    expect(first.sessionId).toBe('S-1');
    expect(first.at).toMatch(/^2026-07-30T/);
  });

  test('creates the journal directory when missing', () => {
    const dir = join(tempDir(), 'nested', 'deeper');
    const journal = createJournal(dir, () => new Date(2026, 6, 30));
    journal.record({ event: 'watch-start', sessionId: 'S-2', sessionName: 'x', detail: '' });
    expect(readJournalEntries(dir, new Date(2026, 6, 30))).toHaveLength(1);
  });
});

describe('readJournalEntries', () => {
  test('returns [] when no journal exists for the date', () => {
    expect(readJournalEntries(tempDir(), new Date(2026, 6, 30))).toEqual([]);
  });

  test('skips corrupt lines instead of throwing', () => {
    const dir = tempDir();
    const journal = createJournal(dir, () => new Date(2026, 6, 30));
    journal.record({ event: 'watch-start', sessionId: 'S-3', sessionName: 'y', detail: '' });
    const file = journalFileFor(dir, new Date(2026, 6, 30));
    appendFileSync(file, 'not-json\n');
    expect(readJournalEntries(dir, new Date(2026, 6, 30))).toHaveLength(1);
  });
});
