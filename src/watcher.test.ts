import { describe, expect, test } from 'vitest';
import type { JournalEvent } from './journal.js';
import { createWatcher } from './watcher.js';

const PERMISSION_PROMPT = `
  Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for npm commands
  3. No, and tell Claude what to do differently (esc)
`;

const LIMIT_MENU = `
You've reached your usage limit · resets 3am

❯ 1. Continue with usage credits
  2. Stop and wait for limit to reset
`;

const WORKING = `● Thinking… (5s)`;

const QUESTION_RECOMMENDED = `
● Which language should the landing page use?

❯ 1. Romanian
  2. English (Recommended)
`;

const QUESTION_PLAIN = `
● Which database do you prefer?

❯ 1. Postgres
  2. SQLite
`;

const QUESTION_MULTISELECT = `
←  ☐ Features  ✔ Submit  →
Which features do you want to enable?
❯ 1. [ ] Alpha
  Enable the Alpha feature.
  2. [ ] Beta
  Enable the Beta feature.
  3. [ ] Type something
     Submit
──────────────────────────────────────────────────────────────────────────────
  4. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel
`;

function harness(initialScreen: string, opts: { yolo?: boolean } = {}) {
  const sent: Array<{ text: string; newline: boolean }> = [];
  const events: JournalEvent[] = [];
  let screen: string | null = initialScreen;
  let now = new Date(2026, 6, 30, 1, 0, 0);
  const watcher = createWatcher({
    session: { id: 'S-1', name: 'pentx' },
    readScreen: async () => screen,
    send: async (text, opts) => {
      sent.push({ text, newline: opts.newline });
    },
    journal: { record: (e) => events.push(e) },
    now: () => now,
    cooldownMs: 5_000,
    resumeMarginMs: 60_000,
    fallbackWaitMs: 30 * 60_000,
    yolo: opts.yolo ?? false,
  });
  return {
    watcher,
    sent,
    events,
    setScreen: (s: string | null) => (screen = s),
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

describe('permission prompts', () => {
  test('answers the Yes option as a bare keypress', async () => {
    const h = harness(PERMISSION_PROMPT);
    await h.watcher.tick();
    expect(h.sent).toEqual([{ text: '1', newline: false }]);
    expect(h.events.map((e) => e.event)).toContain('auto-approve');
  });

  test('does not answer the same prompt twice within the cooldown', async () => {
    const h = harness(PERMISSION_PROMPT);
    await h.watcher.tick();
    await h.watcher.tick();
    expect(h.sent).toHaveLength(1);
  });

  test('answers again after the cooldown if a prompt is still on screen', async () => {
    const h = harness(PERMISSION_PROMPT);
    await h.watcher.tick();
    h.advance(6_000);
    await h.watcher.tick();
    expect(h.sent).toHaveLength(2);
  });
});

describe('limit handling', () => {
  test('selects stop-and-wait and schedules the resume', async () => {
    const h = harness(LIMIT_MENU);
    await h.watcher.tick();
    expect(h.sent).toEqual([{ text: '2', newline: false }]);
    expect(h.events.map((e) => e.event)).toEqual(
      expect.arrayContaining(['limit-detected', 'stop-and-wait-selected', 'resume-scheduled']),
    );
  });

  test('sends continue after the reset time plus margin', async () => {
    const h = harness(LIMIT_MENU);
    await h.watcher.tick(); // selects wait, schedules resume at 3am
    h.setScreen('❯'); // idle input box while waiting
    h.advance(2 * 3600_000 + 30_000); // 03:00:30 — margin not yet passed
    await h.watcher.tick();
    expect(h.sent).toHaveLength(1);
    h.advance(45_000); // 03:01:15 — past 60s margin
    await h.watcher.tick();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toEqual({ text: 'continue', newline: true });
    expect(h.events.map((e) => e.event)).toContain('resume-sent');
  });

  test('uses the fallback wait when no reset time is parseable', async () => {
    const h = harness(`
Usage limit reached.

❯ 1. Continue with usage credits
  2. Stop and wait for limit to reset
`);
    await h.watcher.tick();
    h.setScreen('❯');
    h.advance(29 * 60_000);
    await h.watcher.tick();
    expect(h.sent).toHaveLength(1); // still waiting
    h.advance(2 * 60_000 + 60_000);
    await h.watcher.tick();
    expect(h.sent).toHaveLength(2); // fallback 30m + margin elapsed
  });

  test('does not reselect stop-and-wait while a resume is already scheduled', async () => {
    const h = harness(LIMIT_MENU);
    await h.watcher.tick(); // selects wait, schedules resume
    h.advance(10_000); // well past the cooldown, menu still on screen
    await h.watcher.tick();
    expect(h.sent).toHaveLength(1);
  });

  test('sends continue even when the limit banner is still on screen at reset time', async () => {
    const h = harness(LIMIT_MENU);
    await h.watcher.tick(); // selects wait, schedules resume at 3am + margin
    h.setScreen('✗ 5-hour limit reached ∙ resets 3am\n\n❯');
    h.advance(2 * 3600_000 + 2 * 60_000); // 03:02, past margin
    await h.watcher.tick();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toEqual({ text: 'continue', newline: true });
  });

  test('reschedules when the limit is still active after a resume attempt', async () => {
    const h = harness(LIMIT_MENU);
    await h.watcher.tick();
    h.setScreen('❯');
    h.advance(2 * 3600_000 + 2 * 60_000);
    await h.watcher.tick(); // resume sent
    expect(h.sent).toHaveLength(2);
    h.advance(10_000);
    h.setScreen('✗ 5-hour limit reached ∙ resets 4am\n\n❯');
    await h.watcher.tick(); // still limited — must reschedule, not spam
    await h.watcher.tick();
    expect(h.sent).toHaveLength(2);
    expect(h.events.filter((e) => e.event === 'resume-scheduled').length).toBeGreaterThanOrEqual(2);
  });
});

describe('question menus and yolo mode', () => {
  test('without yolo, a question is journaled once but never answered', async () => {
    const h = harness(QUESTION_RECOMMENDED);
    await h.watcher.tick();
    h.advance(6_000);
    await h.watcher.tick();
    expect(h.sent).toHaveLength(0);
    expect(h.events.filter((e) => e.event === 'question-detected')).toHaveLength(1);
  });

  test('yolo answers with the recommended option digit', async () => {
    const h = harness(QUESTION_RECOMMENDED, { yolo: true });
    await h.watcher.tick();
    expect(h.sent).toEqual([{ text: '2', newline: false }]);
    expect(h.events.map((e) => e.event)).toContain('question-answered');
  });

  test('yolo confirms the highlighted default when nothing is recommended', async () => {
    const h = harness(QUESTION_PLAIN, { yolo: true });
    await h.watcher.tick();
    expect(h.sent).toEqual([{ text: '', newline: true }]);
  });

  test('yolo toggles every unchecked option, moves to Submit and confirms', async () => {
    const h = harness(QUESTION_MULTISELECT, { yolo: true });
    await h.watcher.tick();
    expect(h.sent).toEqual([
      { text: '1', newline: false },
      { text: '2', newline: false },
      { text: '[C', newline: false },
      { text: '', newline: true },
    ]);
  });

  test('yolo does not double-answer within the cooldown', async () => {
    const h = harness(QUESTION_PLAIN, { yolo: true });
    await h.watcher.tick();
    await h.watcher.tick();
    expect(h.sent).toHaveLength(1);
  });

  test('sequential questions are answered one per cooldown window', async () => {
    const h = harness(QUESTION_RECOMMENDED, { yolo: true });
    await h.watcher.tick();
    h.setScreen(QUESTION_PLAIN);
    h.advance(6_000);
    await h.watcher.tick();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toEqual({ text: '', newline: true });
  });
});

describe('session lifecycle', () => {
  test('reports the session gone and stops', async () => {
    const h = harness(WORKING);
    await h.watcher.tick();
    h.setScreen(null);
    await h.watcher.tick();
    expect(h.events.map((e) => e.event)).toContain('session-gone');
    expect(h.watcher.stopped).toBe(true);
  });

  test('does nothing on a working screen', async () => {
    const h = harness(WORKING);
    await h.watcher.tick();
    expect(h.sent).toHaveLength(0);
  });
});
