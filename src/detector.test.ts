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

  test('classifies a limit menu even when the wait label drifts (compact "Stop")', () => {
    // The bundle carries a compact "Stop" wait label on narrow windows. Any
    // label drift must stay a limit menu — never fall through to question-menu
    // where yolo would confirm the caret default (= "Continue with usage credits").
    const screen = `
You've reached your usage limit · resets 3am

  1. Continue with usage credits
❯ 2. Stop
  3. Upgrade your plan
`;
    const d = detect(screen, NOW);
    expect(d).toMatchObject({ kind: 'limit-menu', waitOption: 2 });
  });

  test('holds (waitOption null) when no safe wait option can be identified', () => {
    const screen = `
You've reached your usage limit · resets 3am

❯ 1. Continue with usage credits
  2. Upgrade your plan
`;
    const d = detect(screen, NOW);
    expect(d).toMatchObject({ kind: 'limit-menu', waitOption: null });
  });

  test('a caret menu on a limit screen is never a question-menu', () => {
    const screen = `
You've reached your usage limit · resets 3am

❯ 1. Continue with usage credits
  2. Stop
`;
    expect(detect(screen, NOW).kind).toBe('limit-menu');
  });

  test('chat text merely mentioning "usage limit" is not a limit state', () => {
    const screen = `
● When you reach your usage limit, Claude Code shows a menu.
  The phrase "usage limit" appears in the banner text.

❯
`;
    expect(detect(screen, NOW).kind).toBe('none');
  });

  test('returns none for a working session', () => {
    expect(detect(WORKING, NOW).kind).toBe('none');
  });

  test('returns none for a plain shell', () => {
    expect(detect(PLAIN_SHELL, NOW).kind).toBe('none');
  });

  test('rejects multi-digit option numbers (real menus are single-digit)', () => {
    const screen = `
❯ 10. Yes
  11. No, and tell Claude what to do differently (esc)
`;
    expect(detect(screen, NOW).kind).toBe('none');
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

describe('question menus (AskUserQuestion)', () => {
  const QUESTION_SINGLE = `
● Which language should the landing page use?

❯ 1. Romanian (Recommended)
  2. English
  3. Both languages
`;

  const QUESTION_SINGLE_NO_RECOMMENDED = `
● Which database do you prefer?

❯ 1. Postgres
  2. SQLite
`;

  // Captured verbatim from Claude Code v2.1.212 rendering a multiSelect
  // AskUserQuestion: checkboxes after the number, 2-space descriptions,
  // tab bar with a Submit tab, no space-to-toggle hint.
  const QUESTION_MULTISELECT = `
←  ☐ Features  ✔ Submit  →
Which features do you want to enable?
❯ 1. [ ] Alpha
  Enable the Alpha feature.
  2. [ ] Beta
  Enable the Beta feature.
  3. [x] Gamma
  Enable the Gamma feature.
  4. [ ] Type something
     Submit
──────────────────────────────────────────────────────────────────────────────
  5. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel
`;

  // Captured verbatim from Claude Code v2.1.212 rendering AskUserQuestion.
  const REAL_QUESTION = `
❯ Use the AskUserQuestion tool now: ask me which color for the logo, options Red, Green, Blue, and mark Green as recommended. After I answer, ask a
  second AskUserQuestion with multiSelect true: which features to enable, options Alpha, Beta, Gamma. After that answer, run with Bash: touch
  yolo-proof.txt — then say TEST-COMPLETE and stop.
──────────────────────────────────────────────────────────────────────────────
 ☐ Logo color
Which color should the logo be?
❯ 1. Green (Recommended)
     Marked as the recommended option per your request.
  2. Red
     Red logo color.
  3. Blue
     Blue logo color.
  4. Type something.
──────────────────────────────────────────────────────────────────────────────
  5. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel
`;

  test('recognizes the real Claude Code question rendering with description lines', () => {
    const d = detect(REAL_QUESTION, NOW);
    expect(d).toMatchObject({ kind: 'question-menu', multiSelect: false, recommendedOption: 1 });
  });

  test('exposes option labels so the journal can say what was answered', () => {
    const d = detect(REAL_QUESTION, NOW);
    if (d.kind !== 'question-menu') throw new Error('unreachable');
    expect(d.recommendedLabel).toBe('Green (Recommended)');
    expect(d.selectedLabel).toBe('Green (Recommended)');
  });

  test('exposes toggle labels for multi-select answers', () => {
    const d = detect(QUESTION_MULTISELECT, NOW);
    if (d.kind !== 'question-menu') throw new Error('unreachable');
    expect(d.toggleLabels).toEqual(['[ ] Alpha', '[ ] Beta']);
  });

  test('recognizes a single-select question and finds the recommended option', () => {
    const d = detect(QUESTION_SINGLE, NOW);
    expect(d).toMatchObject({ kind: 'question-menu', multiSelect: false, recommendedOption: 1 });
  });

  test('recommended option is found even when not first', () => {
    const screen = `
● Pick a plan:

❯ 1. Free
  2. Pro (Recommended)
  3. Enterprise
`;
    const d = detect(screen, NOW);
    expect(d).toMatchObject({ kind: 'question-menu', recommendedOption: 2 });
  });

  test('single-select without a recommendation has no recommendedOption', () => {
    const d = detect(QUESTION_SINGLE_NO_RECOMMENDED, NOW);
    expect(d).toMatchObject({ kind: 'question-menu', multiSelect: false, recommendedOption: null });
  });

  test('recognizes the real multi-select rendering via checkbox labels', () => {
    const d = detect(QUESTION_MULTISELECT, NOW);
    expect(d).toMatchObject({ kind: 'question-menu', multiSelect: true });
  });

  test('lists unchecked real options as toggle targets, skipping free-text and chat', () => {
    const d = detect(QUESTION_MULTISELECT, NOW);
    if (d.kind !== 'question-menu') throw new Error('unreachable');
    // 3 is already checked; 4 is "Type something"; 5 is "Chat about this".
    expect(d.toggleOptions).toEqual([1, 2]);
  });

  test('legacy space-to-toggle hint still marks multi-select', () => {
    const screen = `
● Which features?

❯ 1. Newsletter
  2. Contact form

Space to toggle, Enter to confirm, a to select all
`;
    const d = detect(screen, NOW);
    expect(d).toMatchObject({ kind: 'question-menu', multiSelect: true });
  });

  test('extracts the question text, not the key hints', () => {
    const d = detect(QUESTION_MULTISELECT, NOW);
    if (d.kind !== 'question-menu') throw new Error('unreachable');
    expect(d.question).toBe('Which features do you want to enable?');
  });

  test('permission prompts still win over question classification', () => {
    expect(detect(PERMISSION_PROMPT, NOW).kind).toBe('permission-prompt');
  });

  test('limit menus still win over question classification', () => {
    expect(detect(LIMIT_MENU, NOW).kind).toBe('limit-menu');
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

  test('parses "resets at" with a timezone suffix matching the local zone', () => {
    const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(parseResetTime(`Your limit will reset at 11:59pm (${localTz})`, NOW)).toEqual(
      new Date(2026, 6, 30, 23, 59, 0),
    );
  });

  test('returns null for a foreign timezone suffix (local guess could be early)', () => {
    // A named zone that differs from the machine's would parse to the wrong
    // absolute instant; the 30-min fallback is safer than a wrong-early resume.
    expect(parseResetTime('resets at 6pm (Pacific/Kiritimati)', NOW)).toBeNull();
  });

  test('returns null for day-qualified resets instead of guessing today', () => {
    expect(parseResetTime('resets 3am tomorrow', NOW)).toBeNull();
    expect(parseResetTime('resets tomorrow at 3am', NOW)).toBeNull();
    expect(parseResetTime('resets Thu 3am', NOW)).toBeNull();
  });

  test('parses relative "resets in Xh Ym"', () => {
    expect(parseResetTime('resets in 2h 30m', NOW)).toEqual(new Date(2026, 6, 30, 3, 30, 0));
  });

  test('parses relative minutes only', () => {
    expect(parseResetTime('resets in 45m', NOW)).toEqual(new Date(2026, 6, 30, 1, 45, 0));
  });

  test('a bare time that just passed stays in the past (stale banner, not +24h)', () => {
    // "resets 3am" read at 03:02 is the reset we just waited out, not tomorrow.
    const justAfter = new Date(2026, 6, 30, 3, 2, 0);
    expect(parseResetTime('resets 3am', justAfter)).toEqual(new Date(2026, 6, 30, 3, 0, 0));
  });

  test('parses noon correctly', () => {
    expect(parseResetTime('resets 12pm', NOW)).toEqual(new Date(2026, 6, 30, 12, 0, 0));
  });

  test('returns null when nothing matches', () => {
    expect(parseResetTime('no reset info here', NOW)).toBeNull();
  });
});
