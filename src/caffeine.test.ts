import { describe, expect, test } from 'vitest';
import { createCaffeine, type SpawnFn } from './caffeine.js';

interface FakeChild {
  killed: boolean;
  unrefs: number;
  kill(): void;
  unref(): void;
}

function fake() {
  const calls: Array<{ command: string; args: string[] }> = [];
  const children: FakeChild[] = [];
  const warnings: string[] = [];
  const spawn: SpawnFn = (command, args) => {
    calls.push({ command, args });
    const child: FakeChild = {
      killed: false,
      unrefs: 0,
      kill() {
        this.killed = true;
      },
      unref() {
        this.unrefs += 1;
      },
    };
    children.push(child);
    return child;
  };
  return { calls, children, warnings, spawn, warn: (m: string) => warnings.push(m) };
}

describe('caffeine', () => {
  test('holds off display and system sleep for as long as nightswatch lives', () => {
    const f = fake();
    createCaffeine({ spawn: f.spawn, pid: 4242, warn: f.warn }).start();
    // -w ties caffeinate's life to ours: if nightswatch is killed outright, the
    // assertion is released instead of holding the display on forever.
    expect(f.calls).toEqual([{ command: 'caffeinate', args: ['-dimsu', '-w', '4242'] }]);
  });

  test('does not keep node alive on its own', () => {
    const f = fake();
    createCaffeine({ spawn: f.spawn, pid: 1, warn: f.warn }).start();
    expect(f.children[0]?.unrefs).toBe(1);
  });

  test('starting twice spawns one caffeinate', () => {
    const f = fake();
    const caffeine = createCaffeine({ spawn: f.spawn, pid: 1, warn: f.warn });
    caffeine.start();
    caffeine.start();
    expect(f.calls).toHaveLength(1);
  });

  test('stop releases the assertion', () => {
    const f = fake();
    const caffeine = createCaffeine({ spawn: f.spawn, pid: 1, warn: f.warn });
    caffeine.start();
    caffeine.stop();
    expect(f.children[0]?.killed).toBe(true);
  });

  test('stop without start does nothing', () => {
    const f = fake();
    expect(() => createCaffeine({ spawn: f.spawn, pid: 1, warn: f.warn }).stop()).not.toThrow();
  });

  test('stopping twice kills once', () => {
    const f = fake();
    const caffeine = createCaffeine({ spawn: f.spawn, pid: 1, warn: f.warn });
    caffeine.start();
    caffeine.stop();
    f.children[0]!.killed = false;
    caffeine.stop();
    expect(f.children[0]?.killed).toBe(false);
  });

  test('start after stop caffeinates again', () => {
    const f = fake();
    const caffeine = createCaffeine({ spawn: f.spawn, pid: 1, warn: f.warn });
    caffeine.start();
    caffeine.stop();
    caffeine.start();
    expect(f.calls).toHaveLength(2);
  });

  test('a failed spawn warns and leaves the watch running', () => {
    const f = fake();
    const caffeine = createCaffeine({
      spawn: () => {
        throw new Error('spawn caffeinate ENOENT');
      },
      pid: 1,
      warn: f.warn,
    });
    expect(() => caffeine.start()).not.toThrow();
    expect(f.warnings[0]).toContain('ENOENT');
  });

  test('stop after a failed spawn does nothing', () => {
    const f = fake();
    const caffeine = createCaffeine({
      spawn: () => {
        throw new Error('nope');
      },
      pid: 1,
      warn: f.warn,
    });
    caffeine.start();
    expect(() => caffeine.stop()).not.toThrow();
  });
});
