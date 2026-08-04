# Caffeine: hold the Mac awake for the length of a watch

Date: 2026-08-04
Status: approved

## Problem

Nightswatch exists to keep sessions moving while nobody is at the keyboard. If
the Mac goes to sleep, every watched session stalls and the tool silently fails
at its one job — the journal shows a quiet night that never happened.

The workaround today is a second terminal running `caffeinate -dimsu` next to
`nightswatch watch --all --yolo`. Two windows, and the half that actually keeps
the machine awake is the easy one to forget.

## Goal

One command:

```
nightswatch watch --all --yolo --caffeine
```

Nightswatch holds the machine and the display awake for exactly as long as it
is watching, and releases them when it stops.

## Non-goals

- `--no-caffeine`, or caffeine on by default. Opt-in only.
- Battery vs. AC detection. `caffeinate -s` already applies only on AC power;
  we do not second-guess it.
- Caffeinating automatically when a resume is scheduled.
- Any effect on `ls` or `log`.

## Design

### Mechanism

Spawn the macOS `caffeinate` binary as a child process:

```
caffeinate -dimsu -w <nightswatch pid>
```

The flags are the ones already in daily use: `-d` display, `-i` idle system,
`-m` disk, `-s` system on AC, `-u` declare the user active so the display comes
on rather than merely staying on.

`-w <pid>` makes caffeinate watch nightswatch's own process and exit the moment
it is gone. This covers the failure that actually bites: nightswatch is
SIGKILLed or its tab is closed, and an ordinary `caffeinate` would sit there
holding the display on indefinitely with nothing on screen to explain why.
Nightswatch also kills the child explicitly on Ctrl-C, so `-w` is the net, not
the primary path.

Shelling out to a system binary is the existing architecture, not a shortcut:
nightswatch already drives iTerm2 through `osascript` and discovers sessions
through `ps`. Native IOKit power assertions would mean a native module in a
codebase whose only dependencies are TypeScript and vitest.

### Components

**`src/caffeine.ts`** — the whole testable unit, in the injection style already
used by `createItermAdapter(run)`:

```ts
createCaffeine({ spawn, pid, warn }) -> { start(), stop() }
```

- `start()` spawns the command with `stdio: 'ignore'` and `unref()`s the child,
  so caffeinate can never hold the node event loop open. Calling it twice is a
  no-op.
- A spawn failure (missing binary, sandbox) calls `warn` and leaves the object
  in the stopped state. Losing sleep prevention is not a reason to abandon the
  sessions, so the watch continues.
- `stop()` kills the child and is idempotent, including before any `start()`.

**`src/cli.ts`** — `--caffeine` on `watch` only. Started after session selection
succeeds, so an invalid selector never leaves a caffeinate behind. Stopped in
the SIGINT handler and when the watch loop returns on its own.

### Flag parsing

The current parse (`rest.includes('--yolo')` plus
`rest.filter(a => a !== '--yolo')[0]`) does not extend to a second flag and
silently treats a mistyped option as a selector. It becomes a generic
flag/positional split that **rejects unknown options**.

That rejection matters specifically for this feature: `--caffiene` would
otherwise fail silently and the Mac would sleep all night — the exact bug the
feature exists to prevent.

### Output

A single console line next to the existing `journal:` line:

```
caffeine ON — holding off display and system sleep (caffeinate -dimsu)
```

No journal event. Journal events are session-scoped — every one carries a
`sessionId` and `sessionName` — while caffeine is global to the process.
Recording it would mean a placeholder session id plus changes to the event
union and `summarizeJournal`, for no morning-review value that the console line
does not already give.

## Testing

`src/caffeine.test.ts`, against a fake spawn:

- spawns `caffeinate` with `-dimsu -w <pid>`, passing the real pid through
- `start()` twice spawns once
- `stop()` kills the child
- `stop()` before `start()` does nothing
- a throwing spawn warns instead of propagating

`cli.ts` has no test file in this repo, so the wiring is verified by running the
command and confirming `pmset -g assertions` shows the assertions held while it
runs and released after it exits.
