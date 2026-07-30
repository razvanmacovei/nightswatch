import type { ItermSession } from './types.js';

export type JxaRunner = (script: string) => Promise<string>;

export interface ItermAdapter {
  listSessions(): Promise<ItermSession[]>;
  readScreen(sessionId: string): Promise<string>;
  sendText(sessionId: string, text: string, opts: { newline: boolean }): Promise<void>;
}

// iTerm2 session ids look like "574E3F72-5E19-4282-9E89-F7AEB7B8F021".
const SESSION_ID = /^[A-Za-z0-9:-]+$/;

function assertSessionId(id: string): void {
  if (!SESSION_ID.test(id)) {
    throw new Error(`Invalid iTerm2 session id: ${JSON.stringify(id)}`);
  }
}

const LIST_SESSIONS_SCRIPT = `
function run() {
  const iterm = Application('iTerm2');
  if (!iterm.running()) return JSON.stringify([]);
  const out = [];
  iterm.windows().forEach((w, wi) => {
    w.tabs().forEach((t, ti) => {
      t.sessions().forEach((s) => {
        out.push({ id: s.id(), tty: s.tty(), name: s.name(), windowIndex: wi, tabIndex: ti });
      });
    });
  });
  return JSON.stringify(out);
}`;

function findSessionSnippet(id: string): string {
  return `
  const iterm = Application('iTerm2');
  let found = null;
  iterm.windows().forEach((w) => {
    w.tabs().forEach((t) => {
      t.sessions().forEach((s) => {
        if (!found && s.id() === ${JSON.stringify(id)}) found = s;
      });
    });
  });
  if (!found) throw new Error('session not found: ' + ${JSON.stringify(id)});`;
}

export function createItermAdapter(run: JxaRunner): ItermAdapter {
  return {
    async listSessions() {
      const raw = await run(LIST_SESSIONS_SCRIPT);
      return JSON.parse(raw) as ItermSession[];
    },

    async readScreen(sessionId) {
      assertSessionId(sessionId);
      const script = `
function run() {${findSessionSnippet(sessionId)}
  return JSON.stringify(found.contents());
}`;
      return JSON.parse(await run(script)) as string;
    },

    async sendText(sessionId, text, opts) {
      assertSessionId(sessionId);
      const script = `
function run() {${findSessionSnippet(sessionId)}
  found.write({ text: ${JSON.stringify(text)}, newline: ${opts.newline ? 'true' : 'false'} });
  return 'null';
}`;
      await run(script);
    },
  };
}
