# iter8 for Claude Code

iter8 connects Claude Code to browser review rounds. The plugin installs a pinned
iter8 release, calls its lifecycle hooks, and on Claude Code 2.1.296 or later runs
a mod alongside them. Pairing, process liveness, owner resolution, round state and
announcements belong to the iter8 CLI and service.

Requirements: `gh` logged in with access to `mayberuk/iter8`, `jq`, and either
Linux x86_64 or macOS arm64.

Install in Claude Code:

```text
/plugin install iter8 --marketplace mayberuk/cc-plugins
```

The release must be pinned before installation can succeed. The SessionStart
wake listener installs it in the background using `gh release download`, checks
its SHA-256 against both the release checksums and the plugin pin, and verifies
its version. Synchronous hooks never install.

| Event | What happens |
| --- | --- |
| SessionStart | Pairs or relabels the Claude process, then arms a wake listener. A fork resumes the pairing. |
| UserPromptSubmit | Marks the process busy, pulls round pointers, and arms a fresh listener. |
| PostToolUse | Send now only: relays pointers for rounds marked Send now into a busy session between tool calls. Main conversation only. |
| Stop | Marks the process idle and arms a fresh listener. |
| SessionEnd | Sends an end hint in the background so teardown returns immediately. |

Hooks only ever hand the agent a pointer, for example:

```text
Review round R12 from larkspur · 7 notes — run `iter8 show R12`
```

The plugin validates every pointer. SessionStart and UserPromptSubmit pass at most
five lines per hook. Send now passes every pointer `iter8 hook tool` prints,
because a dropped line would never be announced again. Note text and captured
page content never enter context through these hooks. Use `/iter8:rounds` to read
and resolve rounds, attach pages, or leave your own pins. The wake listener relays
pointers from stderr only on the CLI's wake exit code; it does not retry. The next
prompt or turn end re-arms it.

## Claude Code mod

The mod is a TypeScript module that the plugin loads beside its hooks. In a session
it runs in, it takes over the wake path:

- It starts a turn for each round pointer or page message the service hands out,
  instead of the shell wake listener.
- It reports busy and idle turns to the service, so rounds wait while Claude works.
- It shows the session's rounds in an `iter8` pane, and `/iter8` opens it.
- It forwards the session's transcript to the service, so the page can show it.

It runs only in interactive sessions with a drawing surface, such as a terminal or
Desktop, on Claude Code 2.1.296 or later and an iter8 release that speaks protocol
2. Anywhere else the mod stays off, and the shell hooks in the table still wake the
session.

While the mod is connected, the shell wake listeners exit at once. If the mod stops
polling, its grace window lapses after 5 seconds and the shell listeners wake the
session again. Page chat needs the mod connected.

What the mod sends to the local iter8 service: the prompts you type and Claude's
text replies. The service stores them only on the page the session is working for,
and nothing when the session has no focus page. It never sends tool output,
thinking, attachments or subagent rows. The traffic stays on the machine's control
socket. A page message reaches Claude as a prompt the mod submits, byte for byte as
the service formatted it. Hook output never carries page message or note text.

To turn the mod off, disable the plugin's mod in `/plugin`, or set
`disableAllHooks` in your settings.

## Install and updates

Set `ITER8_BIN` to an executable to use a locally built CLI instead of the pinned
release. Both hooks and agent commands use the same `bin/iter8` launcher.

The pin is a floor. The launcher runs the newest installed release at or above it,
so the release `iter8 connect` installs on a laptop is the one the hooks use, and
two iter8 versions never run on one machine. It installs the pinned release only
when no release at or above the pin exists, and exports `ITER8_PINNED_VERSION` so
`iter8 setup` can warn when `current` is newer than the pin. After an install,
`current` in the data directory points at the newest installed release and is
never moved to an older one.

To update the pin from the marketplace checkout:

```bash
plugins/iter8/scripts/pin-release.sh <version>
scripts/release.sh iter8 patch
```

Install data lives at
`${ITER8_PLUGIN_DATA:-${XDG_DATA_HOME:-$HOME/.local/share}/iter8-claude-plugin}`.
The executable is `releases/v<version>/iter8` beneath that directory.
`hooks.log` records hook failures and the byte lengths of dropped lines, never
their content; it is emptied before an append once it exceeds 1 MiB.
Read `install-error` in that directory for the last one-line installation failure.
Successful installation clears it. If present when iter8 is unavailable, the
next synchronous SessionStart prints that reason.

One limitation: with `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` on Linux, Bash-tool
commands run in an isolated PID namespace and cannot find their owner by
ancestry. Agent commands then need `--owner <id>`. Obtain the id from
`.owner.owner` in `iter8 status --json` run from a hook-side shell; plain
`iter8 status` prints the session label, not the id. The plugin has no code to
handle this in v1.

## Maintainer notes

Run the mod's tests with `bash plugins/iter8/mod/run-tests.sh`.

Never commit `.claude-plugin/types/`. Claude Code writes it next to the mod when it
loads the plugin from a directory; the test runner keeps it in its temporary copy.
