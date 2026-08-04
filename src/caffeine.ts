/** The bits of a spawned child nightswatch needs; a real ChildProcess fits. */
export interface CaffeineProcess {
  kill(): void;
  unref(): void;
}

export type SpawnFn = (command: string, args: string[]) => CaffeineProcess;

export interface CaffeineDeps {
  spawn: SpawnFn;
  /** Nightswatch's own pid — caffeinate exits when this process is gone. */
  pid: number;
  warn(message: string): void;
}

export interface Caffeine {
  start(): void;
  stop(): void;
}

// -d display, -i idle system, -m disk, -s system on AC, -u wake the display now.
export const CAFFEINATE_FLAGS = '-dimsu';

/**
 * Holds macOS awake for as long as nightswatch is watching. A sleeping Mac
 * stalls every watched session, so this is the difference between a quiet
 * night and a night that never happened.
 */
export function createCaffeine(deps: CaffeineDeps): Caffeine {
  let child: CaffeineProcess | null = null;

  return {
    start() {
      if (child) return;
      try {
        // `-w <pid>` ties caffeinate's life to ours: killed outright, or with
        // its tab closed, nightswatch still releases the assertion instead of
        // leaving the display lit for days with nothing to explain why.
        child = deps.spawn('caffeinate', [CAFFEINATE_FLAGS, '-w', String(deps.pid)]);
        // Never let caffeinate be the reason node stays alive.
        child.unref();
      } catch (error) {
        // Losing sleep prevention is no reason to abandon the sessions.
        child = null;
        deps.warn(error instanceof Error ? error.message : String(error));
      }
    },

    stop() {
      if (!child) return;
      child.kill();
      child = null;
    },
  };
}
