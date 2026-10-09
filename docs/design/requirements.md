# Requirements briefing: point at a running web page, mark it up, hand the round to its Claude Code session

## Objective
Mark up a running web page (an agent's mock, or an app built with an agent) by clicking elements and sections, then hand the round of notes to the Claude Code session that owns that page, so iteration happens by pointing instead of describing.

## Why (what the outcome enables)
Two loops share one tool: the mock loop (agent makes a mock, Biruk uses and marks it up, agent revises, repeat until right, then it gets built) and the live-site loop (same markup on a real app, instead of describing bugs in words). Also covers walking through design-system proposals and "how could this look" pages. reviewdesk's version proved the value but is locked to that one app.

## Hard constraints
- Works when Claude Code runs on the devbox over SSH and the browser is on the machine Biruk sits at, across the LAN — that is how he works most of the time; a same-machine-only design is unusable.
- Each page is tied to one session; several session+page pairs run at once on one machine (e.g. one on :3999, another on :4000) — otherwise rounds go to the wrong agent.
- A page whose session has gone (closed, crashed, cleared) must say so; a round never silently reports to nothing — the reviewdesk "didn't reach the agent" failure.
- A submitted round is retrievable by its session with no digging; Biruk telling the agent "I've left comments" is enough. It arrives labelled as a review round. A busy session gets it queued, never interrupted.
- Annotating never makes the page lag or blocks typing — reviewdesk froze the first keystroke for 12.6 s; that is the precedent to beat.
- Connects to Claude Code through its stable surfaces (hooks, skills, commands), not early-access ones — an early-access dependency adds a version floor and churn.
- The agent can act on a note without coming back to ask which thing was meant — the whole point of pointing instead of describing.
- Day one page kinds: agent-written HTML files and local framework dev servers.
- Single user: only Biruk.

## Soft preferences
- A Send button on the page that delivers the round without typing anything in the terminal — giving it up means a "I've left comments" message each round.
- Both entry points: a session opens the page, or Biruk opens a page himself and attaches it to a session — giving up the second means always asking an agent first.
- A tool-spawned window that opens with the page and closes when the round is done; his everyday browser is fine too.
- Screenshot on demand.
- The agent can leave its own notes on the page for context (optional; flagged as possibly complicated).
- Agent responses go to the terminal; nothing has to render back on the page.

## Dealbreakers
- Buggy.
- Laggy or unresponsive.
- Fighting Claude Code's agent primitives (hooks, skills, etc.) instead of fitting them.

## Success conditions
- In a mock loop over SSH, Biruk clicks a few elements and sections, leaves notes, sends, and the owning session picks the round up and acts on every note without a "which one did you mean?" follow-up.
- Two session+page pairs on one machine each receive only their own rounds.
- Iterating on a mock, changes show up in the next round with no extra steps.

## Failure conditions
- A round sent from a page whose session is gone is accepted with no warning.
- A keystroke in the note composer is visibly delayed on a heavy page.
- A note the agent cannot locate without asking.
- Rounds have to be dug out by hand (reviewdesk read drafts straight from the database).

## Explicitly out of scope
- Other people's sites — not needed now.
- Deployed and staging URLs — deferred past v1, so v1 may assume it controls the pages it shows.
- Teammates, sharing, accounts — single user.

## Open questions
- Does reviewdesk move onto this, keep its own annotate system, or not matter? — Biruk.
- Must it run on both the macOS laptop and the Linux devbox (the SSH constraint implies browser on one, session on the other)? — Biruk.
- What happens to an open page when its session goes away: reattach to a new session, or just refuse? — brainstorm.
- Plugin, standalone tool, or both — brainstorm.
- What a note carries, judged against "acts without a follow-up" — brainstorm.

## Constraints challenged and upheld
- Deployed/staging day one — challenged with unlock "v1 controls every page it shows, no foreign logins or content rules"; relaxed to later.
- Session launches the page — challenged with unlock "mark up something already in use, pick a session at send"; relaxed to both entry points, with the hard rule that a page never goes stale and reports to nothing.
- Everyday browser — challenged with unlock "no per-browser install, full control, open/close per round"; relaxed to spawned window OK, but kept hard that it must work over SSH on the LAN.
- Instant delivery even when idle — challenged with unlock "next-prompt delivery is simpler and sturdier"; relaxed: "I've left comments" pull is acceptable, a Send button that pushes is better.
- Fits agent primitives — challenged with unlock "stable hooks/skills avoid an early-access version floor"; agreed, stable surfaces only.
