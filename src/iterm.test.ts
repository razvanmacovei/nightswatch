import { describe, expect, test } from 'vitest';
import { createItermAdapter } from './iterm.js';

function fakeRunner(result: string) {
  const calls: string[] = [];
  const run = async (script: string) => {
    calls.push(script);
    return result;
  };
  return { calls, run };
}

describe('listSessions', () => {
  test('parses the JSON session list returned by JXA', async () => {
    const { run } = fakeRunner(
      JSON.stringify([
        { id: 'ABC-123', tty: '/dev/ttys000', name: 'claude', windowIndex: 0, tabIndex: 0 },
      ]),
    );
    const iterm = createItermAdapter(run);
    const sessions = await iterm.listSessions();
    expect(sessions).toEqual([
      { id: 'ABC-123', tty: '/dev/ttys000', name: 'claude', windowIndex: 0, tabIndex: 0 },
    ]);
  });
});

describe('readScreen', () => {
  test('embeds the session id and returns screen text', async () => {
    const { calls, run } = fakeRunner(JSON.stringify('screen text here'));
    const iterm = createItermAdapter(run);
    const text = await iterm.readScreen('574E3F72-5E19-4282-9E89-F7AEB7B8F021');
    expect(text).toBe('screen text here');
    expect(calls[0]).toContain('574E3F72-5E19-4282-9E89-F7AEB7B8F021');
  });

  test('rejects session ids that could break out of the script', async () => {
    const { run } = fakeRunner('""');
    const iterm = createItermAdapter(run);
    await expect(iterm.readScreen('abc"; doEvil(); "')).rejects.toThrow(/session id/i);
  });
});

describe('sendText', () => {
  test('JSON-escapes the text payload', async () => {
    const { calls, run } = fakeRunner('null');
    const iterm = createItermAdapter(run);
    await iterm.sendText('ABC-123', 'echo "hi"\\n', { newline: true });
    expect(calls[0]).toContain(JSON.stringify('echo "hi"\\n'));
  });

  test('passes newline: false for bare keypresses', async () => {
    const { calls, run } = fakeRunner('null');
    const iterm = createItermAdapter(run);
    await iterm.sendText('ABC-123', '1', { newline: false });
    expect(calls[0]).toContain('newline: false');
  });
});
