import { describe, expect, test } from 'vitest';
import { detect, parseResetTime } from './detector.js';

const NOW = new Date(2026, 6, 30, 1, 0, 0); // Jul 30 2026, 01:00 local

// Fixtures approximate real Claude Code screens; option labels are exact
// strings from the v2.1.220 bundle.

const PERMISSION_PROMPT = `
● Bash(npm test)
  ⎿ Running…

  Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for npm commands in /Users/x/proj
  3. No, and tell Claude what to do differently (esc)
`;

const PERMISSION_PROMPT_EDIT = `
● Edit(src/index.ts)

  Do you want to make this edit to index.ts?
❯ 1. Yes
  2. Yes, and don't ask again this session
  3. No, and tell Claude what to do differently (esc)
`;

const LIMIT_MENU = `
You've reached your usage limit · resets 3am

❯ 1. Continue with usage credits
  2. Stop and wait for limit to reset
`;

const LIMIT_MENU_WAIT_VARIANT = `
You've hit your 5-hour limit · resets in 2h 30m

❯ 1. Continue with usage credits
  2. Wait for limit to reset
`;

const LIMIT_IDLE = `
✗ 5-hour limit reached ∙ resets 3am

❯
`;

const WORKING = `
● Reading src/app.ts…
  ✻ Churning… (12s · esc to interrupt)
`;

const PLAIN_SHELL = `
Last login: Thu Jul 30 10:40:38 on ttys002
➜  ~ echo hello
hello
➜  ~
`;

describe('detect', () => {
  test('recognizes a permission prompt and points at the plain Yes option', () => {
    const d = detect(PERMISSION_PROMPT, NOW);
    expect(d).toMatchObject({ kind: 'permission-prompt', yesOption: 1 });
  });

  test('recognizes edit permission prompts too', () => {
    const d = detect(PERMISSION_PROMPT_EDIT, NOW);
    expect(d).toMatchObject({ kind: 'permission-prompt', yesOption: 1 });
  });

  test('recognizes the limit menu and points at the wait option', () => {
    const d = detect(LIMIT_MENU, NOW);
    expect(d).toMatchObject({ kind: 'limit-menu', waitOption: 2 });
    if (d.kind !== 'limit-menu') throw new Error('unreachable');
    expect(d.resetAt).toEqual(new Date(2026, 6, 30, 3, 0, 0));
  });

  test('recognizes the "Wait for limit to reset" menu variant', () => {
    const d = detect(LIMIT_MENU_WAIT_VARIANT, NOW);
    expect(d).toMatchObject({ kind: 'limit-menu', waitOption: 2 });
    if (d.kind !== 'limit-menu') throw new Error('unreachable');
    expect(d.resetAt).toEqual(new Date(2026, 6, 30, 3, 30, 0));
  });

  test('limit menu takes priority over permission-style parsing', () => {
    const d = detect(LIMIT_MENU, NOW);
    expect(d.kind).toBe('limit-menu');
  });

  test('recognizes the stopped/idle limit state with reset info', () => {
    const d = detect(LIMIT_IDLE, NOW);
    expect(d).toMatchObject({ kind: 'limit-idle' });
    if (d.kind !== 'limit-idle') throw new Error('unreachable');
    expect(d.resetAt).toEqual(new Date(2026, 6, 30, 3, 0, 0));
  });

  test('returns none for a working session', () => {
    expect(detect(WORKING, NOW).kind).toBe('none');
  });

  test('returns none for a plain shell', () => {
    expect(detect(PLAIN_SHELL, NOW).kind).toBe('none');
  });

  test('does not treat a numbered list in chat output as a menu', () => {
    const screen = `
● Here is my plan:
  1. Yes, we should refactor the parser
  2. Stop and wait for CI to pass
`;
    expect(detect(screen, NOW).kind).toBe('none');
  });
});

describe('parseResetTime', () => {
  test('parses bare am/pm times as the next occurrence', () => {
    expect(parseResetTime('resets 3am', NOW)).toEqual(new Date(2026, 6, 30, 3, 0, 0));
  });

  test('parses times with minutes', () => {
    expect(parseResetTime('resets 2:30pm', NOW)).toEqual(new Date(2026, 6, 30, 14, 30, 0));
  });

  test('rolls over to tomorrow when the time already passed today', () => {
    const lateNow = new Date(2026, 6, 30, 22, 0, 0);
    expect(parseResetTime('resets 3am', lateNow)).toEqual(new Date(2026, 6, 31, 3, 0, 0));
  });

  test('parses "resets at" with a timezone suffix', () => {
    expect(parseResetTime('Your limit will reset at 11:59pm (Europe/Bucharest)', NOW)).toEqual(
      new Date(2026, 6, 30, 23, 59, 0),
    );
  });

  test('parses relative "resets in Xh Ym"', () => {
    expect(parseResetTime('resets in 2h 30m', NOW)).toEqual(new Date(2026, 6, 30, 3, 30, 0));
  });

  test('parses relative minutes only', () => {
    expect(parseResetTime('resets in 45m', NOW)).toEqual(new Date(2026, 6, 30, 1, 45, 0));
  });

  test('parses noon and midnight correctly', () => {
    expect(parseResetTime('resets 12pm', NOW)).toEqual(new Date(2026, 6, 30, 12, 0, 0));
    expect(parseResetTime('resets 12am', NOW)).toEqual(new Date(2026, 6, 31, 0, 0, 0));
  });

  test('returns null when nothing matches', () => {
    expect(parseResetTime('no reset info here', NOW)).toBeNull();
  });
});
