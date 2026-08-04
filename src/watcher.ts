import { detect, type Detection } from './detector.js';
import { localTime } from './format.js';
import type { Journal } from './journal.js';

export interface WatcherDeps {
  session: { id: string; name: string };
  /** Current screen text, or null when the session no longer exists. */
  readScreen(): Promise<string | null>;
  send(text: string, opts: { newline: boolean }): Promise<void>;
  journal: Journal;
  now(): Date;
  /** Minimum time between two keystrokes sent to the session. */
  cooldownMs: number;
  /** Safety margin added after the parsed reset time before resuming. */
  resumeMarginMs: number;
  /** Wait applied when a limit is detected but no reset time is parseable. */
  fallbackWaitMs: number;
  /** Grace period after a resume before a lingering limit counts as a failure. */
  postResumeQuietMs: number;
  /** YOLO mode: also answer question menus (recommended option / select all). */
  yolo?: boolean;
}

export interface Watcher {
  tick(): Promise<void>;
  readonly stopped: boolean;
}

/**
 * How many times the same question may be answered before we stop. A real menu
 * disappears once answered; one that keeps coming back is a misread screen or a
 * stuck UI, and either way more keystrokes only make the mess bigger.
 */
const MAX_SAME_ANSWERS = 3;

export function createWatcher(deps: WatcherDeps): Watcher {
  const { session, journal } = deps;
  let stopped = false;
  let lastSendAt = 0;
  let resumeAt: number | null = null;
  let questionOnScreen = false;
  /** Identity of the question yolo last answered, and how often in a row. */
  let lastAnswerKey: string | null = null;
  let sameAnswers = 0;
  let stuckReported = false;
  /** Reset time the pending resume was scheduled from, in ms (null = unparseable). */
  let pendingResetAt: number | null = null;
  /** Latest reset time we have already sent a "continue" for. */
  let resumedForResetAt: number | null = null;
  /** While set, a resume is awaiting its outcome; the value is its decision deadline. */
  let outcomeDeadline: number | null = null;

  const record = (event: Parameters<Journal['record']>[0]['event'], detail: string) => {
    journal.record({ event, sessionId: session.id, sessionName: session.name, detail });
  };

  const canSend = (nowMs: number) => nowMs - lastSendAt >= deps.cooldownMs;

  const sendKey = async (key: string, nowMs: number) => {
    await deps.send(key, { newline: false });
    lastSendAt = nowMs;
  };

  const sendResume = async (nowMs: number) => {
    resumeAt = null;
    await deps.send('continue', { newline: true });
    lastSendAt = nowMs;
    // Remember what we resumed for: the limit banner stays in the terminal
    // scrollback afterwards, and re-resuming for the same reset time would type
    // "continue" into a session that is already running.
    if (pendingResetAt !== null) {
      resumedForResetAt = resumedForResetAt === null
        ? pendingResetAt
        : Math.max(resumedForResetAt, pendingResetAt);
    }
    outcomeDeadline = nowMs + deps.postResumeQuietMs;
    record('resume-sent', 'sent "continue" after limit reset');
  };

  /** True when a limit banner only repeats a reset we have already resumed for. */
  const isStaleBanner = (resetAt: Date | null) =>
    resumedForResetAt !== null && resetAt !== null && resetAt.getTime() <= resumedForResetAt;

  const scheduleResume = (resetAt: Date | null, nowMs: number, reason?: string) => {
    // A reset time in the past (stale banner) means we're due now, not in ~24h.
    const base = resetAt ? Math.max(resetAt.getTime(), nowMs) : nowMs + deps.fallbackWaitMs;
    resumeAt = base + deps.resumeMarginMs;
    pendingResetAt = resetAt ? resetAt.getTime() : null;
    outcomeDeadline = null;
    record(
      'resume-scheduled',
      resetAt
        ? `${reason ?? 'reset parsed as'} ${localTime(resetAt)}; will send "continue" ${Math.round(
            deps.resumeMarginMs / 60_000,
          )}m later`
        : `no reset time found; falling back to ${Math.round(deps.fallbackWaitMs / 60_000)}m wait`,
    );
  };

  /**
   * Claude Code often prints the reset time only after the limit menu is
   * answered ("· resets 5:10pm"), so the menu itself leaves nothing to parse and
   * the wait starts as a blind guess. Keep reading the screen and trade that
   * guess for the real time as soon as it appears — a 30m guess either wastes
   * quota or types "continue" into a session that is still locked out. Only a
   * reset still in the future counts: a time already past is a banner left in
   * the scrollback by an earlier limit, which says nothing about this one.
   */
  const upgradeFallback = (resetAt: Date | null, nowMs: number) => {
    if (resumeAt === null || pendingResetAt !== null) return;
    if (resetAt === null || resetAt.getTime() <= nowMs || isStaleBanner(resetAt)) return;
    scheduleResume(resetAt, nowMs, 'reset time appeared after the fallback wait started —');
  };

  return {
    get stopped() {
      return stopped;
    },

    async tick() {
      if (stopped) return;
      const nowMs = deps.now().getTime();
      const screen = await deps.readScreen();
      if (screen === null) {
        record('session-gone', 'session no longer exists in iTerm2');
        stopped = true;
        return;
      }

      const detection = detect(screen, deps.now());
      if (detection.kind !== 'question-menu') {
        questionOnScreen = false;
        // The menu is gone, so whatever comes next is a new question.
        lastAnswerKey = null;
        sameAnswers = 0;
        stuckReported = false;
      }

      // A resume is proven by the limit leaving the screen. The banner itself
      // lingers in the scrollback for as long as nothing scrolls it away, so it
      // is never on its own evidence that the session is still stuck.
      const limitOnScreen = detection.kind === 'limit-idle' || detection.kind === 'limit-menu';
      if (outcomeDeadline !== null && !limitOnScreen) {
        outcomeDeadline = null;
        record('resume-confirmed', 'limit cleared — session is running again');
      }
      if (detection.kind === 'limit-idle' || detection.kind === 'limit-menu') {
        upgradeFallback(detection.resetAt, nowMs);
      }

      // Re-read and re-classify immediately before any keystroke: the screen
      // may have changed since the first read, and a key landing on a different
      // menu (worst case the limit menu, where option 1 spends credits) is
      // never acceptable. Returns the fresh same-kind detection, or null to abort.
      const reconfirm = async <K extends Detection['kind']>(
        kind: K,
      ): Promise<Extract<Detection, { kind: K }> | null> => {
        const fresh = await deps.readScreen();
        if (fresh === null) {
          record('session-gone', 'session no longer exists in iTerm2');
          stopped = true;
          return null;
        }
        const confirmed = detect(fresh, deps.now());
        return confirmed.kind === kind ? (confirmed as Extract<Detection, { kind: K }>) : null;
      };

      switch (detection.kind) {
        case 'limit-menu': {
          // A scheduled resume means we already chose stop-and-wait; a stale
          // menu on screen must not trigger a second selection.
          if (resumeAt === null && canSend(nowMs)) {
            const confirmed = await reconfirm('limit-menu');
            if (!confirmed) return;
            record('limit-detected', 'limit menu on screen');
            if (confirmed.waitOption === null) {
              // No option safely identifiable as stop-and-wait: never guess
              // (a wrong digit could buy credits or upgrade). Hold and wait.
              record('limit-hold', 'no safe wait option found — holding for manual action');
              return;
            }
            await sendKey(String(confirmed.waitOption), nowMs);
            record('stop-and-wait-selected', `chose option ${confirmed.waitOption}`);
            scheduleResume(confirmed.resetAt, nowMs);
          }
          return;
        }
        case 'limit-idle': {
          if (resumeAt !== null) {
            // The banner often stays on screen right up to the reset, so the
            // resume must fire from this state too, not only from 'none'.
            if (nowMs >= resumeAt) await sendResume(nowMs);
            return;
          }
          if (outcomeDeadline !== null) {
            // Give the resume time to land before reading the screen as a verdict.
            if (nowMs < outcomeDeadline) return;
            outcomeDeadline = null;
            if (isStaleBanner(detection.resetAt)) {
              record(
                'resume-confirmed',
                'banner still on screen but its reset time has passed — treating it as scrollback',
              );
              return;
            }
            record('resume-failed', 'limit still active after the resume — rescheduling');
            scheduleResume(detection.resetAt, nowMs);
            return;
          }
          if (isStaleBanner(detection.resetAt)) return;
          record('limit-detected', 'session stopped on usage limit');
          scheduleResume(detection.resetAt, nowMs);
          return;
        }
        case 'permission-prompt': {
          // Guard on resumeAt too: while waiting out a limit, send nothing.
          if (resumeAt === null && canSend(nowMs)) {
            const confirmed = await reconfirm('permission-prompt');
            if (!confirmed) return;
            await sendKey(String(confirmed.yesOption), nowMs);
            record('auto-approve', confirmed.question || 'permission prompt approved');
          }
          return;
        }
        case 'question-menu': {
          if (!deps.yolo) {
            if (!questionOnScreen) {
              questionOnScreen = true;
              record('question-detected', detection.question || 'question menu on screen');
            }
            return;
          }
          if (resumeAt === null && canSend(nowMs)) {
            const confirmed = await reconfirm('question-menu');
            if (!confirmed) return;
            const key = [
              confirmed.question,
              confirmed.selectedLabel,
              confirmed.recommendedLabel,
              ...confirmed.toggleLabels,
            ].join(' ');
            if (key === lastAnswerKey && sameAnswers >= MAX_SAME_ANSWERS) {
              if (!stuckReported) {
                stuckReported = true;
                record(
                  'question-stuck',
                  `still on screen after ${MAX_SAME_ANSWERS} answers — leaving it alone${
                    confirmed.question ? `: ${confirmed.question}` : ''
                  }`,
                );
              }
              return;
            }
            let answer: string;
            if (confirmed.multiSelect) {
              // Select everything, then submit. Digits toggle the checkboxes;
              // CR submits the list (validated on real Claude Code — no
              // arrow-key navigation to a Submit tab is needed).
              for (const option of confirmed.toggleOptions) {
                await deps.send(String(option), { newline: false });
              }
              await deps.send('', { newline: true });
              const picked = confirmed.toggleLabels
                .map((l) => l.replace(/^\[\s\]\s*/, ''))
                .join(', ');
              answer = `selected all (${picked}) and submitted`;
            } else if (confirmed.recommendedOption !== null) {
              await deps.send(String(confirmed.recommendedOption), { newline: false });
              answer = `chose "${confirmed.recommendedLabel}"`;
            } else {
              // Enter confirms the highlighted default option.
              await deps.send('', { newline: true });
              answer = confirmed.selectedLabel
                ? `confirmed default "${confirmed.selectedLabel}"`
                : 'confirmed default option';
            }
            lastSendAt = nowMs;
            sameAnswers = key === lastAnswerKey ? sameAnswers + 1 : 1;
            lastAnswerKey = key;
            record(
              'question-answered',
              confirmed.question ? `${answer} — ${confirmed.question}` : answer,
            );
          }
          return;
        }
        case 'none': {
          if (resumeAt !== null && nowMs >= resumeAt) {
            await sendResume(nowMs);
          }
          return;
        }
      }
    },
  };
}
