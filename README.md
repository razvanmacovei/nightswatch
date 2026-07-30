# nightswatch

[![CI](https://github.com/razvanmacovei/nightswatch/actions/workflows/ci.yml/badge.svg)](https://github.com/razvanmacovei/nightswatch/actions/workflows/ci.yml)

**Keep your Claude Code sessions moving overnight.**

You leave Claude Code working on a long task, go to bed, and at 2 AM it hits
your subscription usage limit — or stops to ask "Do you want to proceed?". The
session then sits there for hours, waiting for a keypress you can't give it. You
wake up, type `continue`, and mourn the lost night.

nightswatch babysits those sessions for you. It finds Claude Code sessions
already running in your iTerm2 tabs — you don't have to start them any special
way — and keeps them moving:

- **Auto-approves permission prompts** (always the plain "Yes" option)
- **Handles usage limits**: selects *Stop and wait for limit to reset*, parses
  the reset time from the screen, and sends `continue` the moment the window
  reopens
- **Keeps a journal** of everything it did while you slept

```
$ nightswatch ls
  #  WIN/TAB  DIRECTORY                STATE
  1  0/0      ~/Repositories/work      waiting on permission prompt
  2  1/0      ~/Repositories/side      working / idle

$ nightswatch watch --all
23:41:02 watching ~/Repositories/work (window 0, tab 0) — auto-yes ON
23:41:02 watching ~/Repositories/side (window 1, tab 0) — auto-yes ON
23:41:02 journal: /Users/you/.nightswatch
23:58:11 [~/Repositories/work] auto-approve — Do you want to proceed?
02:14:03 [~/Repositories/work] limit-detected — limit menu on screen
02:14:03 [~/Repositories/work] stop-and-wait-selected — chose option 2
02:14:03 [~/Repositories/work] resume-scheduled — reset parsed as 2026-07-30T03:00:00
03:01:00 [~/Repositories/work] resume-sent — sent "continue" after limit reset

$ nightswatch log
… everything that happened overnight, plus a summary.
```

## Install

```
npm install -g nightswatch
```

Requirements: **macOS**, **iTerm2**, Node.js ≥ 20. The first run will ask for
macOS Automation permission to control iTerm2 — allow it.

Release candidates are published on the `rc` dist-tag:

```
npm install -g nightswatch@rc
```

## Usage

```
nightswatch ls                 List Claude Code sessions running in iTerm2
nightswatch watch <n>          Watch session <n> from `nightswatch ls`
nightswatch watch --all        Watch every discovered session
nightswatch log [YYYY-MM-DD]   Show the journal for a day (default: today)
```

Leave `nightswatch watch` running in its own terminal tab overnight. Stop it
any time with `Ctrl+C` — the watched sessions themselves are untouched; they
just stop being babysat.

## ⚠️ Safety

**Watching a session auto-approves every permission prompt it raises.** That is
functionally the same as running Claude Code with
`--dangerously-skip-permissions` for anything you left on "ask".

nightswatch deliberately ships no allow/deny list of its own. Claude Code
already has a native, user-configured permission system — deny rules in
`settings.json` and hooks — and actions denied there are blocked before a
prompt ever appears, so nightswatch can only approve what you left askable.
Harden your Claude Code deny list (force pushes, deploys, `rm` outside the
repo, …) before leaving sessions unattended. See
[ADR-0002](docs/adr/0002-auto-yes-delegates-safety-to-claude-code.md).

## How it works

An external process cannot type into another terminal tab's stdin — modern
OSes restrict TTY input injection. nightswatch goes through iTerm2's scripting
API instead (via JXA/osascript): it enumerates tabs, matches them to running
`claude` processes through the process tree (including nested-PTY shell
wrappers), polls the visible screen every few seconds, classifies it
(permission prompt / limit menu / limit banner / working), and sends the right
keystrokes. See
[ADR-0001](docs/adr/0001-adopt-sessions-via-iterm2-scripting.md).

That's also why v1 is macOS + iTerm2 only: other terminals don't expose the
needed scripting surface. tmux and Terminal.app adapters are candidates for v2.

## Development

```
npm ci
npm test          # vitest, no iTerm2 needed
npm run build
node dist/cli.js ls
```

Releases: tag `vX.Y.Z` on `main` publishes to npm as `latest`; tag
`vX.Y.Z-rc.N` on any branch publishes a pre-release on the `rc` dist-tag.

## License

MIT
