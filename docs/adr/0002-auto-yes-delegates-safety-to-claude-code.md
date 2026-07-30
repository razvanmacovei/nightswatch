# Auto-yes answers every prompt; safety is delegated to Claude Code's permission system

Nightswatch approves every permission prompt on a watched session and deliberately ships no allow/deny list of its own. Claude Code already has a native, user-configured permission system (allow/deny rules in settings, hooks): actions the user has denied there are blocked before a prompt ever appears, so Nightswatch only ever approves what the user left on "ask". Re-implementing a second permission layer would duplicate that system, drift from it, and give a false sense of safety.

## Consequences

Watching a session is functionally equivalent to running it with `--dangerously-skip-permissions` for anything not covered by the user's deny rules. The README must state this plainly and direct users to harden their Claude Code deny list before leaving sessions unattended.
