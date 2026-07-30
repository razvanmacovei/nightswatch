import { describe, expect, test } from 'vitest';
import { describeDetection, formatTable, shortenHome } from './format.js';

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
