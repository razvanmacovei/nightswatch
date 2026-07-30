# Adopt sessions via iTerm2 scripting (JXA), not tmux or a PTY wrapper

The core promise is rescuing a Claude Code session the user already started in a plain terminal tab. An external process cannot write to another tab's stdin (TIOCSTI is restricted on modern OSes), so the only way in is the terminal application's scripting API. We adopt sessions through iTerm2 via osascript/JXA: enumerate tabs, poll screen contents, send keystrokes. Claude Code's JSONL transcripts under `~/.claude/projects/` assist discovery and state detection.

## Considered Options

- **tmux substrate** (what claude-squad and claude-auto-retry use) — reliable and cross-platform, but only works for sessions started inside tmux, which fails the core use case of adopting a forgotten plain tab.
- **Own PTY wrapper** — clean control but cannot adopt existing sessions, and sessions die with the supervisor.
- **iTerm2 official Python API** — richer (event-driven, websocket) than JXA, but requires the user to enable it in iTerm2 settings and forces a Python runtime; v1 stays TypeScript + JXA polling. Revisit if polling proves too fragile.

## Consequences

v1 is macOS + iTerm2 only. Support for other terminals (tmux, Terminal.app, Kitty) means writing additional adapters behind the same interface, not a rewrite.
