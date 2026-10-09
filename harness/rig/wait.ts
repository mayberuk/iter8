export async function waitFor<T>(
  label: string,
  read: () => Promise<T | null>,
  { timeoutMs = 5000, everyMs = 25 }: { timeoutMs?: number; everyMs?: number } = {},
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(everyMs) || everyMs <= 0) {
    throw new Error("waitFor requires a non-negative timeout and a positive polling interval")
  }
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== null) return value
    const remaining = deadline - performance.now()
    if (remaining <= 0) {
      throw new Error(
        `Timed out waiting for ${label} after ${timeoutMs} ms; last value: ${Bun.inspect(value)}`,
      )
    }
    await Bun.sleep(Math.min(everyMs, remaining))
  }
}
