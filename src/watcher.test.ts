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
  const screenQueue: Array<string | null> = [];
  let now = new Date(2026, 6, 30, 1, 0, 0);
  const watcher = createWatcher({
    session: { id: 'S-1', name: 'pentx' },
    readScreen: async () => (screenQueue.length > 0 ? screenQueue.shift()! : screen),
    send: async (text, opts) => {
      sent.push({ text, newline: opts.newline });
    },
    journal: { record: (e) => events.push(e) },
    now: () => now,
    cooldownMs: 5_000,
    resumeMarginMs: 60_000,
    fallbackWaitMs: 30 * 60_000,
    postResumeQuietMs: 3 * 60_000,
    yolo: opts.yolo ?? false,
  });
  return {
    watcher,
    sent,
    events,
    setScreen: (s: string | null) => (screen = s),
    queueScreens: (...screens: Array<string | null>) => screenQueue.push(...screens),
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
  const LIMIT_NO_WAIT = `
You've reached your usage limit · resets 3am

❯ 1. Continue with usage credits
  2. Upgrade your plan
`;

  test('holds without pressing a key when the wait option cannot be identified', async () => {
    const h = harness(LIMIT_NO_WAIT);
    await h.watcher.tick();
    expect(h.sent).toHaveLength(0);
    expect(h.events.map((e) => e.event)).toContain('limit-hold');
  });

  test('aborts stop-and-wait when the screen changes between read and send', async () => {
    // First read is the limit menu; the confirming re-read is a working screen.
    const h = harness(LIMIT_MENU);
    h.queueScreens(LIMIT_MENU, WORKING);
    await h.watcher.tick();
    expect(h.sent).toHaveLength(0);
  });

  test('clamps a stale-banner reset to now so continue fires within minutes', async () => {
    const h = harness(LIMIT_MENU);
    await h.watcher.tick(); // selects wait; banner says "resets 3am"
    h.setScreen('✗ 5-hour limit reached ∙ resets 3am\n\n❯');
    h.advance(2 * 3600_000 + 2 * 60_000); // 03:02 — reset already passed
    await h.watcher.tick();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toEqual({ text: 'continue', newline: true });
  });

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
    h.setScreen('✗ 5-hour limit reached ∙ resets 4am\n\n❯');
    h.advance(4 * 60_000); // past the post-resume quiet window
    await h.watcher.tick(); // still limited — must reschedule, not spam
    await h.watcher.tick();
    expect(h.sent).toHaveLength(2);
    expect(h.events.filter((e) => e.event === 'resume-scheduled').length).toBeGreaterThanOrEqual(2);
  });
});

describe('resume outcome', () => {
  const BANNER_3AM = '✗ 5-hour limit reached ∙ resets 3am\n\n❯';

  /** Runs a limit cycle up to and including the resume keystroke at 03:02. */
  async function resumed() {
    const h = harness(LIMIT_MENU); // 01:00, banner says "resets 3am"
    await h.watcher.tick(); // selects stop-and-wait, schedules 3am + margin
    h.setScreen('❯');
    h.advance(2 * 3600_000 + 2 * 60_000); // 03:02
    await h.watcher.tick(); // resume sent
    expect(h.sent).toHaveLength(2);
    return h;
  }

  test('never resumes twice for a reset time it already resumed for', async () => {
    const h = await resumed();
    // The banner stays in the scrollback long after the session is running again.
    h.setScreen(BANNER_3AM);
    for (let i = 0; i < 10; i++) {
      h.advance(60_000);
      await h.watcher.tick();
    }
    expect(h.sent).toHaveLength(2);
  });

  test('journals the stale banner as a confirmed resume, once', async () => {
    const h = await resumed();
    h.setScreen(BANNER_3AM);
    for (let i = 0; i < 10; i++) {
      h.advance(60_000);
      await h.watcher.tick();
    }
    expect(h.events.filter((e) => e.event === 'resume-confirmed')).toHaveLength(1);
  });

  test('journals resume-confirmed once the limit clears', async () => {
    const h = await resumed();
    h.setScreen(WORKING);
    h.advance(5_000);
    await h.watcher.tick();
    h.advance(5_000);
    await h.watcher.tick();
    expect(h.events.filter((e) => e.event === 'resume-confirmed')).toHaveLength(1);
  });

  test('holds fire while the quiet window runs, even with no parseable reset', async () => {
    const h = await resumed();
    h.setScreen('✗ 5-hour limit reached\n\n❯');
    h.advance(60_000); // inside the 3m quiet window
    const before = h.events.length;
    await h.watcher.tick();
    expect(h.sent).toHaveLength(2);
    expect(h.events.slice(before)).toEqual([]); // nothing decided yet
  });

  test('journals resume-failed and reschedules when the limit outlives the quiet window', async () => {
    const h = await resumed();
    h.setScreen('✗ 5-hour limit reached ∙ resets 4am\n\n❯'); // a genuinely new limit
    h.advance(4 * 60_000);
    await h.watcher.tick();
    expect(h.events.filter((e) => e.event === 'resume-failed')).toHaveLength(1);
    expect(h.events.filter((e) => e.event === 'resume-scheduled')).toHaveLength(2);
    expect(h.sent).toHaveLength(2);
  });

  test('resumes again for a later reset time after a failed resume', async () => {
    const h = await resumed();
    h.setScreen('✗ 5-hour limit reached ∙ resets 4am\n\n❯');
    h.advance(4 * 60_000); // 03:06 — resume-failed, reschedules for 4am
    await h.watcher.tick();
    h.advance(55 * 60_000); // 04:01, past the margin
    await h.watcher.tick();
    expect(h.sent).toHaveLength(3);
    expect(h.sent[2]).toEqual({ text: 'continue', newline: true });
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

  test('the journal detail says which answer was chosen', async () => {
    const h = harness(QUESTION_RECOMMENDED, { yolo: true });
    await h.watcher.tick();
    const detail = h.events.find((e) => e.event === 'question-answered')?.detail ?? '';
    expect(detail).toContain('English (Recommended)');
    expect(detail).toContain('Which language should the landing page use?');
  });

  test('the multi-select journal detail lists the selected options', async () => {
    const h = harness(QUESTION_MULTISELECT, { yolo: true });
    await h.watcher.tick();
    const detail = h.events.find((e) => e.event === 'question-answered')?.detail ?? '';
    expect(detail).toContain('Alpha');
    expect(detail).toContain('Beta');
  });

  test('yolo confirms the highlighted default when nothing is recommended', async () => {
    const h = harness(QUESTION_PLAIN, { yolo: true });
    await h.watcher.tick();
    expect(h.sent).toEqual([{ text: '', newline: true }]);
  });

  test('yolo toggles every unchecked option then submits with CR', async () => {
    // Validated on real Claude Code: CR submits the checkbox list directly.
    const h = harness(QUESTION_MULTISELECT, { yolo: true });
    await h.watcher.tick();
    expect(h.sent).toEqual([
      { text: '1', newline: false },
      { text: '2', newline: false },
      { text: '', newline: true },
    ]);
  });

  test('aborts the answer when the screen changes between read and send', async () => {
    // Classify a question, but the confirming re-read finds a limit menu —
    // keys must NOT land blindly (option 1 there spends credits).
    const h = harness(QUESTION_RECOMMENDED, { yolo: true });
    h.queueScreens(QUESTION_RECOMMENDED, LIMIT_MENU);
    await h.watcher.tick();
    expect(h.sent).toHaveLength(0);
  });

  test('does not answer questions while waiting out a limit reset', async () => {
    const h = harness(LIMIT_MENU, { yolo: true });
    await h.watcher.tick(); // wait selected, resume scheduled
    h.setScreen(QUESTION_RECOMMENDED);
    h.advance(10_000);
    await h.watcher.tick();
    expect(h.sent).toHaveLength(1); // only the wait digit; no answer keys
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
