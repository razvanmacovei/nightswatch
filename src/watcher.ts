import { detect } from './detector.js';
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
    const base = resetAt ? resetAt.getTime() : nowMs + deps.fallbackWaitMs;
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

      switch (detection.kind) {
        case 'limit-menu': {
          // A scheduled resume means we already chose stop-and-wait; a stale
          // menu on screen must not trigger a second selection.
          if (resumeAt === null && canSend(nowMs)) {
            record('limit-detected', 'limit menu on screen');
            await sendKey(String(detection.waitOption), nowMs);
            record('stop-and-wait-selected', `chose option ${detection.waitOption}`);
            scheduleResume(detection.resetAt, nowMs);
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
          if (canSend(nowMs)) {
            await sendKey(String(detection.yesOption), nowMs);
            record('auto-approve', detection.question || 'permission prompt approved');
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
          if (canSend(nowMs)) {
            if (detection.multiSelect) {
              // The user's call: select everything, then submit. Digits toggle
              // the checkboxes; right-arrow reaches the Submit tab; CR confirms.
              for (const option of detection.toggleOptions) {
                await deps.send(String(option), { newline: false });
              }
              await deps.send('[C', { newline: false });
              await deps.send('', { newline: true });
            } else if (detection.recommendedOption !== null) {
              await deps.send(String(detection.recommendedOption), { newline: false });
            } else {
              // Enter confirms the highlighted default option.
              await deps.send('', { newline: true });
            }
            lastSendAt = nowMs;
            record('question-answered', detection.question || 'question menu answered');
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
