export type Detection =
  | { kind: 'permission-prompt'; yesOption: number; question: string }
  | { kind: 'limit-menu'; waitOption: number; resetAt: Date | null }
  | { kind: 'limit-idle'; resetAt: Date | null }
  | {
      kind: 'question-menu';
      multiSelect: boolean;
      recommendedOption: number | null;
      /** Numbers of unchecked checkbox options worth toggling (multi-select). */
      toggleOptions: number[];
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

/**
 * Extract a select-menu from the screen: two or more numbered options on
 * adjacent lines, one of them carrying the ❯ selection caret. Plain numbered
 * lists in chat output have no caret and are ignored.
 */
function parseMenu(screen: string): MenuOption[] | null {
  const lines = screen.split('\n');
  let best: MenuOption[] | null = null;
  let current: MenuOption[] = [];
  const flush = () => {
    if (current.length >= 2 && current.some((o) => o.selected)) best = current;
    current = [];
  };
  for (const line of lines) {
    const match = line.match(OPTION_LINE);
    if (match) {
      current.push({ number: Number(match[2]), label: match[3]!, selected: Boolean(match[1]) });
    } else if (line.trim() !== '' && !/^\s/.test(line)) {
      // Indented non-option lines are option descriptions (real AskUserQuestion
      // rendering puts one under each option); they don't break the menu.
      // Only flush on flush-left content like a question or separator line.
      flush();
    }
  }
  flush();
  return best;
}

export function detect(screen: string, now: Date): Detection {
  const menu = parseMenu(screen);
  if (menu) {
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
    // Any other caret menu is a question (AskUserQuestion or similar picker).
    const recommended = menu.find((o) => RECOMMENDED.test(o.label));
    const answerOptions = menu.filter((o) => !NON_ANSWER_OPTION.test(o.label));
    const multiSelect =
      MULTISELECT_HINT.test(screen) || answerOptions.some((o) => CHECKBOX.test(o.label));
    const lines = screen.split('\n').map((l) => l.trim());
    const question =
      lines.filter((l) => l.endsWith('?') && !OPTION_LINE.test(l)).pop() ??
      lines
        .filter((l) => l.length > 0 && !OPTION_LINE.test(l) && !KEY_HINT.test(l))
        .pop() ??
      '';
    return {
      kind: 'question-menu',
      multiSelect,
      recommendedOption: recommended ? recommended.number : null,
      toggleOptions: answerOptions
        .filter((o) => UNCHECKED_BOX.test(o.label))
        .map((o) => o.number),
      question,
    };
  }
  if (LIMIT_TEXT.test(screen)) {
    return { kind: 'limit-idle', resetAt: parseResetTime(screen, now) };
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

  const absolute = text.match(/resets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (absolute) {
    let hour = Number(absolute[1]) % 12;
    if (absolute[3]!.toLowerCase() === 'pm') hour += 12;
    const minute = Number(absolute[2] ?? 0);
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0);
    if (candidate.getTime() <= now.getTime()) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate;
  }

  return null;
}
