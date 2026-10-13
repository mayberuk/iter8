/** Reads a stream to its end or until the deadline, whichever comes first; a failed stream reads as empty. */
export async function readBounded(
  stream: ReadableStream<Uint8Array>,
  timeoutMs: number,
): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const timer = setTimeout(() => void reader.cancel().catch(() => {}), timeoutMs)
  let text = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } catch {
    return ""
  } finally {
    clearTimeout(timer)
  }
}
