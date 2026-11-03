# iter8 mod probe results

Measured with 2.1.296 (Claude Code). Verdicts are recomputed from `evidence/` by `bash check.sh`.

```text
socket-fetch: confirmed — $.http.fetch with socketPath reached the stub: status 200 and the /agent/state body (owner O1)
submit-turn: confirmed — $.prompt.submit between turns wrote one plugin-origin user row holding sender sentence, delivery text verbatim and trailer; it started a turn and the model answered PROBE-M7-ACK
post-tool-shell: confirmed — the plugin's PostToolUse command hook ran armed on 2 main-conversation call(s) and printed hookSpecificOutput.additionalContext; the pointer is in 4 transcript row(s) (hook_additional_context×2, hook_success×2) and the answer was: ROUNDS: R5 (from a hook note after the sleep commands; I did not run `iter8 show R5`)
turn-events: confirmed — 3 turn.start and 3 turn.complete events on the main thread, ids paired; 2 ended reason answer and 1 ended isAborted true reason aborted after Esc
append-doors: confirmed — session.append carries door and origin.kind: attachment/engine×11, hook-context/hook×2, note/engine×1, notice/engine×2, prompt/composer×2, prompt/plugin×1, response/model×7, tool-result/tool×3
child-ancestry: confirmed — a $.process.run child's parent chain is sh ← claude (pid 3467137, the tmux pane's process) ← tmux server; the `sh` is the shell $.process.run wraps the command in, so the agent pid is the first non-shell ancestor
clear-follow: confirmed — the first module instance (s1km15nk) survived /clear: its poll loop recorded alive 2202 ms after /clear; after it 0 session.start and 1 session.end firing(s)
post-tool-module: recorded — the module saw 0 classic.PostToolUse events although the engine ran the plugin's own PostToolUse command hook 2 time(s) and 3 tool.call events fired
```

Sender sentence, verbatim (text before the delivery):

```text
The iter8-probe plugin sent a message:

```

Trailer, verbatim (text after the delivery):

```text


This is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.
```
