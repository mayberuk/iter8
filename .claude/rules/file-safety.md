# Deleting files

Never run a recursive force delete (`rm -rf`, `rm -fr`, `git clean -fdx`) — they are denied in
`.claude/settings.json`, and a blocked delete stalls an unattended run for hours.

- Remove a file you created with `rm <path>`, naming each file.
- Put throwaway directories under `.claude/work/tmp/` (gitignored) or `mktemp -d`, and leave them.
- Remove a worktree with `git worktree remove <path>` or `dp worktree remove`, never by deleting it.
- A test that needs a clean directory creates a fresh one rather than emptying an old one.
