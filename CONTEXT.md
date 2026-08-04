# Nightswatch

An open-source CLI that keeps unattended Claude Code sessions moving overnight: it discovers running sessions, auto-approves permission prompts, and resumes work when a usage-limit window resets.

## Language

**Session**:
A running interactive Claude Code process in an iTerm2 tab, identified by its working directory and tab.
_Avoid_: Agent, instance, process

**Discovery**:
Finding all active Sessions on the machine, whether or not Nightswatch started them.
_Avoid_: Scan, detect

**Adopt**:
Taking over supervision of a Session that was started outside Nightswatch, without restarting it.
_Avoid_: Attach, hijack

**Watch**:
Supervising a Session: auto-approving prompts and handling the limit-resume cycle until the user stops it.
_Avoid_: Babysit (docs may use it informally), monitor

**Auto-yes**:
Blanket approval of every permission prompt a watched Session raises. Safety is intentionally delegated to Claude Code's own permission system (allow/deny lists, hooks), never re-implemented in Nightswatch.
_Avoid_: Auto-approve list, guardrails

**Limit prompt**:
The Claude Code UI shown when the subscription usage limit is hit, offering to stop and wait for the reset.
_Avoid_: Rate limit error

**Reset time**:
The timestamp at which the usage window reopens, read off the screen in the user's own clock time. Claude Code often prints it only after the Limit prompt is answered, so Nightswatch starts on a fallback wait and swaps in the real time as soon as it appears.

**Resume**:
Sending "continue" to a Session at its Reset time so it picks up where it stopped.
_Avoid_: Restart, retry

**Journal**:
The persistent per-night log of every action Nightswatch took (approvals, limits detected, Resumes), reviewable in the morning.
_Avoid_: History, audit log
