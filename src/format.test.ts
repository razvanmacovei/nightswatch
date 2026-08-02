import { describe, expect, test } from 'vitest';
import { describeDetection, formatTable, shortenHome, summarizeJournal } from './format.js';
import type { JournalEntry } from './journal.js';

describe('shortenHome', () => {
  test('replaces the home prefix with ~', () => {
    expect(shortenHome('/Users/x/Repos/proj', '/Users/x')).toBe('~/Repos/proj');
  });

  test('leaves other paths untouched', () => {
    expect(shortenHome('/tmp/foo', '/Users/x')).toBe('/tmp/foo');
  });

  test('handles undefined as a dash', () => {
    expect(shortenHome(undefined, '/Users/x')).toBe('-');
  });
});

describe('describeDetection', () => {
  test('describes a working session', () => {
    expect(describeDetection({ kind: 'none' })).toBe('working / idle');
  });

  test('describes a waiting limit state with the reset time', () => {
    const resetAt = new Date(2026, 6, 30, 3, 0, 0);
    expect(describeDetection({ kind: 'limit-idle', resetAt })).toBe('limit hit · resets 03:00');
  });

  test('describes a limit state without a parsed time', () => {
    expect(describeDetection({ kind: 'limit-idle', resetAt: null })).toBe('limit hit');
  });

  test('describes a pending permission prompt', () => {
    expect(describeDetection({ kind: 'permission-prompt', yesOption: 1, question: 'x' })).toBe(
      'waiting on permission prompt',
    );
  });
});

describe('formatTable', () => {
  test('aligns columns and prefixes rows with their index', () => {
    const out = formatTable(
      ['DIRECTORY', 'STATE'],
      [
        ['~/short', 'working / idle'],
        ['~/a-much-longer-path', 'limit hit'],
      ],
    );
    expect(out).toEqual([
      '  #  DIRECTORY             STATE',
      '  1  ~/short               working / idle',
      '  2  ~/a-much-longer-path  limit hit',
    ]);
  });
});

describe('summarizeJournal', () => {
  const entry = (event: JournalEntry['event']): JournalEntry => ({
    at: '2026-08-02T15:21:03',
    event,
    sessionId: 'S-1',
    sessionName: 'carpathwise',
    detail: '',
  });

  test('counts approvals, answered questions and resumes', () => {
    const line = summarizeJournal([
      entry('auto-approve'),
      entry('auto-approve'),
      entry('question-answered'),
      entry('resume-sent'),
    ]);
    expect(line).toBe('2 auto-approvals, 1 question answered, 1 resume');
  });

  test('reports how many resumes were confirmed and how many failed', () => {
    const line = summarizeJournal([
      entry('resume-sent'),
      entry('resume-confirmed'),
      entry('resume-sent'),
      entry('resume-failed'),
    ]);
    expect(line).toBe('0 auto-approvals, 0 questions answered, 2 resumes (1 confirmed, 1 failed)');
  });
});
