# Changelog

## 0.4.0 — 2026-11-03

- The plugin now lives in the iter8 repository (`plugins/iter8/`, listed by `.claude-plugin/marketplace.json`) and installs over HTTPS with no `gh` login: `/plugin marketplace add mayberuk/iter8`, then `/plugin install iter8@iter8`. The pinned iter8 release is unchanged (v0.4.6). Test data and docs no longer carry personal names or hostnames.

## 0.3.8 — 2026-10-29

- Hooks run on macOS's built-in bash 3.2: the launcher's version compare no longer joins BASH_REMATCH into one word under IFS=., which made every hook exit 1 before running a release. A failed hook now logs the first line the CLI wrote to stderr, so the reason is in hooks.log.

## 0.3.7 — 2026-10-19

- The rounds skill reads a round's authored notes only by default (through iter8 show --json and jq), pulls a note's untrusted capture only when it needs the target, and closes a note held for a later build with a reply naming where it is recorded.

## 0.3.6 — 2026-10-14

- Pin iter8 v0.4.6: the dock can sit as a full-width bar along the bottom of the page ("Dock to" in the more menu), and the collapse button gets a clearer icon.

## 0.3.5 — 2026-10-13

- Pin iter8 v0.4.5: notes can point at iter8 itself (hold Alt while picking); a session with background agents or tasks still running shows as working in the background instead of idle; the Stop hook passes its input to iter8 so it can count that work; the status ring frames Claude's bare mark and chat round dividers are chips again.

## 0.3.4 — 2026-10-13

- Pin iter8 v0.4.4. A screenshot whose image would pass 2 MiB is kept at a lower resolution instead of being refused as too big.

## 0.3.3 — 2026-10-13

- Pin the iter8 binary to release v0.4.3: chat reads as open prose with your messages as bubbles, a busy session shows a forming draft, session status is a ring around Claude's mark instead of a dot, region notes carry a screenshot, and the Screenshot tool captures ordinary drags instead of refusing them as too heavy.

## 0.3.2 — 2026-10-12

- Pin the iter8 binary to release v0.4.2: iter8 help lists the commands, and iter8 help <command>, or --help or -h on any command, shows its usage and flags.

## 0.3.1 — 2026-10-12

- Pin the iter8 binary to release v0.4.1: the prompt, stop and end hooks no longer start or replace the service, and an older iter8 never stops a newer one, so sessions on different plugin versions stop replacing each other's service and timing out the prompt hook. Restart or /reload-plugins any session still on an older plugin.
- hook.sh logs a hook that takes 2 s or more, or fails with anything other than service unavailable, to the plugin's log.

## 0.3.0 — 2026-10-12

- The launcher runs the newest installed iter8 release at or above the pin instead of exactly the pin, and exports ITER8_PINNED_VERSION. Installing a release repoints current at the newest installed release and never moves it back. The rounds skill tells the agent to start a site with iter8 run as a background task.
- Pin the iter8 binary to release v0.4.0: iter8 run starts a project's dev server and opens it through the proxy, iter8 setup installs the terminal command (and with a host, iter8 connect at login), the laptop's connect follows the remote machine's newer releases, and notes survive a service restart.

## 0.2.3 — 2026-10-12

- Print-mode runs (claude -p) no longer stall: the wake hook exits at once when Claude Code reports a print-mode entrypoint, and the three wake hooks are declared async, so a print run neither waits for them at start nor stays open for them after its answer.

## 0.2.2 — 2026-10-11

- Pin the iter8 binary to release v0.3.0: markdown and a redesigned Conversation tab, a text shimmer on the dock, notes while a page modal is open, a lost-notes panel that gets out of the way, and a working arc on sent pins.

## 0.2.1 — 2026-10-11

- Pin the iter8 binary to release v0.2.0 (linux-x64 and darwin-arm64 checksums), so a fresh session installs the page conversation and Send now.

## 0.2.0 — 2026-10-10

- Add a Claude Code mod (2.1.296 and later, interactive sessions): it attaches when a session starts, starts a turn for each round and page message, and shows the round pane. Send now reaches a busy session through a PostToolUse hook that prints a round pointer between tool calls. The rounds skill trusts a page message only in the turn the iter8 plugin starts. With an iter8 release older than protocol 2 the mod stays off and the hooks keep working.

## 0.1.2 — 2026-10-10

- A wake listener that starts before its session registers now registers it and waits again, so the first session after install pairs and its first round wakes it.

## 0.1.1 — 2026-10-10

- Pin the iter8 binary to release v0.1.0 (linux-x64 and darwin-arm64 checksums), so a fresh session installs it instead of finding no release.

## 0.1.0 — 2026-10-10

Add the pinned release installer, launcher, and marketplace registration. Pair each session with
iter8 through SessionStart, UserPromptSubmit, Stop and SessionEnd hooks; wake an idle session with
round pointers only, never note text; teach the agent iter8 open, attach, rounds and status through
the rounds skill.
