import { detect, type Detection } from './detector.js';
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
  /** YOLO mode: also answer question menus (recommended option / select all). */
  yolo?: boolean;
}

export interface Watcher {
  tick(): Promise<void>;
  readonly stopped: boolean;
}

export function createWatcher(deps: WatcherDeps): Watcher {
  const { session, journal } = deps;
  let stopped = false;
  let lastSendAt = 0;
  let resumeAt: number | null = null;
  let questionOnScreen = false;

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
    record('resume-sent', 'sent "continue" after limit reset');
  };

  const scheduleResume = (resetAt: Date | null, nowMs: number) => {
    // A reset time in the past (stale banner) means we're due now, not in ~24h.
    const base = resetAt ? Math.max(resetAt.getTime(), nowMs) : nowMs + deps.fallbackWaitMs;
    resumeAt = base + deps.resumeMarginMs;
    record(
      'resume-scheduled',
      resetAt
        ? `reset parsed as ${resetAt.toISOString()}; will send "continue" after margin`
        : `no reset time found; falling back to ${Math.round(deps.fallbackWaitMs / 60_000)}m wait`,
    );
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
      if (detection.kind !== 'question-menu') questionOnScreen = false;

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
          if (resumeAt === null) {
            record('limit-detected', 'session stopped on usage limit');
            scheduleResume(detection.resetAt, nowMs);
          } else if (nowMs >= resumeAt) {
            // The banner often stays on screen right up to the reset, so the
            // resume must fire from this state too, not only from 'none'.
            await sendResume(nowMs);
          }
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
