/** A terminal session as seen by iTerm2. */
export interface ItermSession {
  /** iTerm2 unique session id. */
  id: string;
  /** Full tty device path, e.g. "/dev/ttys000". */
  tty: string;
  /** iTerm2 session name (often shows the Claude task title). */
  name: string;
  windowIndex: number;
  tabIndex: number;
}

/** A row of the process table. */
export interface ProcessInfo {
  pid: number;
  ppid: number;
  /** Short tty name, e.g. "ttys001", or "??" when detached. */
  tty: string;
  command: string;
}

/** An interactive Claude Code process. */
export interface ClaudeProcess extends ProcessInfo {}

/** A Claude Code session running inside an iTerm2 tab. */
export interface DiscoveredSession {
  session: ItermSession;
  process: ClaudeProcess;
  /** Working directory of the claude process, when resolvable. */
  cwd?: string | undefined;
}
