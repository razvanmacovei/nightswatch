export type Detection =
  | { kind: 'permission-prompt'; yesOption: number; question: string }
  | { kind: 'limit-menu'; waitOption: number | null; resetAt: Date | null }
  | { kind: 'limit-idle'; resetAt: Date | null }
  | {
      kind: 'question-menu';
      multiSelect: boolean;
      recommendedOption: number | null;
      recommendedLabel: string | null;
      /** Label of the option the caret currently highlights. */
      selectedLabel: string | null;
      /** Numbers of unchecked checkbox options worth toggling (multi-select). */
      toggleOptions: number[];
      toggleLabels: string[];
      question: string;
    }
  | { kind: 'none' };

interface MenuOption {
  number: number;
  label: string;
  selected: boolean;
}

// Exact option labels come from the Claude Code bundle (v2.1.220):
//   "Stop and wait for limit to reset" / "Wait for limit to reset"
//   "No, and tell Claude what to do differently" / "Deny, and tell Claude what to do differently"
const WAIT_OPTION = /^(stop and )?wait for limit to reset\b/i;
const REJECT_OPTION = /\b(no|deny), and tell claude what to do (differently|next)\b/i;
const LIMIT_TEXT =
  /(limit reached|(reached|hit) your\b.{0,40}\blimit|out of usage credits|usage limit\b)/i;
// On a limit screen the safe option contains stop/wait and never spends money.
const SAFE_WAIT = /\b(stop|wait)\b/i;
const COSTLY_OPTION = /continue|credit|upgrade|\bpay\b|\bplan\b/i;
// Corroboration that a bare limit phrase is a real banner, not chat about limits:
// an error/status glyph near "limit" (NOT the chat bullet ●, which prefixes
// ordinary assistant messages), or a parseable reset time on screen.
const LIMIT_BANNER = /[✗✳⏳⚠✻✘].{0,60}\blimit\b/;

// Single digit only: real Claude Code menus have at most a handful of options,
// and a tighter match shrinks the spoofable surface. Multi-select questions
// prefix options with a checkbox glyph.
const OPTION_LINE = /^\s*(❯\s*)?(?:[◻◼☐☑▢■]\s*)?([1-9])\.\s+(.+?)\s*$/;
const MULTISELECT_HINT = /space to toggle/i;
const RECOMMENDED = /\(recommended\)/i;
// Real multi-select rendering puts a checkbox in the label: "1. [ ] Alpha".
const UNCHECKED_BOX = /^\[\s\]/;
const CHECKBOX = /^\[[\sxX✔]\]/;
// Options that are not real answers: free-text input and side-channel chat.
const NON_ANSWER_OPTION = /type something|chat about this/i;
const KEY_HINT = /enter to select|to navigate|esc to cancel|space to toggle/i;
// Every interactive select in Claude Code prints a key-hint footer right under
// its options ("Enter to select · ↑/↓ to navigate · Esc to cancel" and its
// variants). Nothing else on screen does — the input box footer says "esc to
// interrupt"/"esc to clear" — which makes it the one signal that separates a
// real menu from Claude Code's own prompt line, which starts with the same ❯.
const MENU_FOOTER =
  /enter to (select|confirm)|to navigate|to switch|esc to (cancel|close)|space to toggle/i;
// Descriptions and a separator can sit between the last option and the footer.
const FOOTER_LOOKAHEAD = 5;
// The last step of a multi-question AskUserQuestion is a plain confirm dialog:
// a tab bar, the answers so far, and "Submit answers / Cancel". Claude Code
// renders it with no key-hint footer at all, so the footer voucher can never
// see it and a yolo run stalls with every question answered but nothing sent.
// Its own prompt line, which sits directly above the options, vouches for it
// instead — narrowly, so no other footer-less confirm dialog is swept in.
const REVIEW_PROMPT = /ready to submit your answers\?/i;
const SUBMIT_OPTION = /^submit answers?\b/i;
const PROMPT_LOOKBACK = 3;

interface ParsedMenu {
  options: MenuOption[];
  /** Index of the first option line, so the prompt can be looked for above it. */
  firstLine: number;
  /** Index of the last option line, so the footer can be looked for below it. */
  lastLine: number;
}

/**
 * Extract a select-menu from the screen: two or more numbered options on
 * adjacent lines, one of them carrying the ❯ selection caret. Plain numbered
 * lists in chat output have no caret and are ignored.
 */
function parseMenu(lines: string[]): ParsedMenu | null {
  let best: ParsedMenu | null = null;
  let current: MenuOption[] = [];
  let firstLine = -1;
  let lastLine = -1;
  const flush = () => {
    if (current.length >= 2 && current.some((o) => o.selected)) {
      best = { options: current, firstLine, lastLine };
    }
    current = [];
  };
  lines.forEach((line, index) => {
    const match = line.match(OPTION_LINE);
    if (match) {
      if (current.length === 0) firstLine = index;
      current.push({ number: Number(match[2]), label: match[3]!, selected: Boolean(match[1]) });
      lastLine = index;
    } else if (line.trim() !== '' && !/^\s/.test(line)) {
      // Indented non-option lines are option descriptions (real AskUserQuestion
      // rendering puts one under each option); they don't break the menu.
      // Only flush on flush-left content like a question or separator line.
      flush();
    }
  });
  flush();
  return best;
}

/** True when a key-hint footer sits just below the menu's last option. */
function hasMenuFooter(lines: string[], lastOptionLine: number): boolean {
  return lines
    .slice(lastOptionLine + 1, lastOptionLine + 1 + FOOTER_LOOKAHEAD)
    .some((line) => MENU_FOOTER.test(line));
}

/**
 * The "Submit answers" option of a question dialog's review step, or null when
 * this menu is not that step. Both signals are required: the prompt has to sit
 * right above the options, and the menu has to offer the submit option — so a
 * numbered list typed into the input box can never pose as one.
 */
function findSubmitOption(
  lines: string[],
  menu: MenuOption[],
  firstOptionLine: number,
): MenuOption | null {
  const above = lines.slice(Math.max(0, firstOptionLine - PROMPT_LOOKBACK), firstOptionLine);
  if (!above.some((line) => REVIEW_PROMPT.test(line))) return null;
  return menu.find((o) => SUBMIT_OPTION.test(o.label)) ?? null;
}

export function detect(screen: string, now: Date): Detection {
  const screenLines = screen.split('\n');
  const parsed = parseMenu(screenLines);
  if (parsed) {
    const menu = parsed.options;
    // A caret menu on a limit screen is ALWAYS a limit menu, even if the wait
    // label drifted ("Stop", localized, reordered). Never let it reach the
    // question path, where yolo would confirm the caret default — which is
    // "Continue with usage credits" (spends money).
    if (LIMIT_TEXT.test(screen)) {
      const wait = menu.find((o) => SAFE_WAIT.test(o.label) && !COSTLY_OPTION.test(o.label));
      return {
        kind: 'limit-menu',
        waitOption: wait ? wait.number : null,
        resetAt: parseResetTime(screen, now),
      };
    }
    const wait = menu.find((o) => WAIT_OPTION.test(o.label));
    if (wait) {
      return { kind: 'limit-menu', waitOption: wait.number, resetAt: parseResetTime(screen, now) };
    }
    if (menu.some((o) => REJECT_OPTION.test(o.label))) {
      const yes = menu.find((o) => /^yes\b/i.test(o.label) && !/^yes,/i.test(o.label));
      if (yes) {
        const question =
          screen
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => /\bdo you want\b/i.test(l))
            .pop() ?? '';
        return { kind: 'permission-prompt', yesOption: yes.number, question };
      }
    }
    // Any other caret menu is a question (AskUserQuestion or similar picker) —
    // but only if the key-hint footer vouches for it. Without one, the caret is
    // Claude Code's prompt echoing the user's own text, and a numbered list
    // typed there would otherwise be "answered" with a stray Enter.
    const submit = findSubmitOption(screenLines, menu, parsed.firstLine);
    if (hasMenuFooter(screenLines, parsed.lastLine) || submit) {
      // On the review step the option to press is Submit — never the caret,
      // which a stray arrow key could have left sitting on Cancel.
      const recommended = submit ?? menu.find((o) => RECOMMENDED.test(o.label));
      const answerOptions = menu.filter((o) => !NON_ANSWER_OPTION.test(o.label));
      const multiSelect =
        MULTISELECT_HINT.test(screen) || answerOptions.some((o) => CHECKBOX.test(o.label));
      const lines = screenLines.map((l) => l.trim());
      const question =
        lines.filter((l) => l.endsWith('?') && !OPTION_LINE.test(l)).pop() ??
        lines
          .filter((l) => l.length > 0 && !OPTION_LINE.test(l) && !KEY_HINT.test(l))
          .pop() ??
        '';
      const toggles = answerOptions.filter((o) => UNCHECKED_BOX.test(o.label));
      return {
        kind: 'question-menu',
        multiSelect,
        recommendedOption: recommended ? recommended.number : null,
        recommendedLabel: recommended ? recommended.label : null,
        selectedLabel: menu.find((o) => o.selected)?.label ?? null,
        toggleOptions: toggles.map((o) => o.number),
        toggleLabels: toggles.map((o) => o.label),
        question,
      };
    }
  }
  // Menu-less limit state: require corroboration (banner glyph or a parseable
  // reset time) so ordinary chat mentioning "usage limit" doesn't schedule a
  // spurious resume that types "continue" into a working session.
  if (LIMIT_TEXT.test(screen)) {
    const resetAt = parseResetTime(screen, now);
    if (LIMIT_BANNER.test(screen) || resetAt !== null) {
      return { kind: 'limit-idle', resetAt };
    }
  }
  return { kind: 'none' };
}

export function parseResetTime(text: string, now: Date): Date | null {
  const relative = text.match(
    /resets? in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i,
  );
  if (relative && (relative[1] || relative[2])) {
    const hours = Number(relative[1] ?? 0);
    const minutes = Number(relative[2] ?? 0);
    return new Date(now.getTime() + (hours * 60 + minutes) * 60_000);
  }

  // Day-qualified ("3am tomorrow", "Thu 3am") — we can't place these on a
  // same-day clock without guessing; the 30-min fallback is safer than a
  // wrong-early resume.
  if (/\b(tomorrow|today|mon|tue|wed|thu|fri|sat|sun)\b/i.test(text)) return null;

  // Timezone suffix naming a zone other than the machine's — a local reading
  // would resolve to the wrong absolute instant. Same-zone suffix is fine.
  const tz = text.match(/\(([A-Za-z]+\/[A-Za-z_]+)\)/);
  if (tz && tz[1] !== Intl.DateTimeFormat().resolvedOptions().timeZone) return null;

  const absolute = text.match(/resets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (absolute) {
    let hour = Number(absolute[1]) % 12;
    if (absolute[3]!.toLowerCase() === 'pm') hour += 12;
    const minute = Number(absolute[2] ?? 0);
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0);
    // Roll to tomorrow only when the time is comfortably in the past. A time
    // that just passed is a stale banner from the reset we already waited out —
    // keep it in the past so the caller retries now, not ~24h later.
    if (now.getTime() - candidate.getTime() > 2 * 3600_000) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate;
  }

  return null;
}
