const KILL_ON_PIPE_CLOSE = 'read -r _; kill -9 -- "$1" 2>/dev/null'

/**
 * Kills `child` (its whole process group when `group`) once this process is gone for any reason,
 * with no teardown: `bun test` workers emit no `exit` event, so a hook there never runs.
 * A detached shell blocks on a pipe this process holds; the kernel closes it when we die.
 */
export function reapWithParent(child: Bun.Subprocess, options: { group?: boolean } = {}): void {
  const target = options.group ? -child.pid : child.pid
  const watchdog = Bun.spawn(["sh", "-c", KILL_ON_PIPE_CLOSE, "sh", String(target)], {
    detached: true,
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  })
  watchdog.unref()
  // The closure also keeps watchdog.stdin reachable: a collected sink would close the pipe.
  void child.exited.then(() => watchdog.kill())
}
