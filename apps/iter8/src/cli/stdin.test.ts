import { expect, test } from "bun:test"
import { readBounded } from "./stdin"

const encoder = new TextEncoder()

test("reads every chunk of a stream that ends", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('{"a":'))
      controller.enqueue(encoder.encode("1}"))
      controller.close()
    },
  })
  expect(await readBounded(stream, 1_000)).toBe('{"a":1}')
})

test("keeps a character split across two chunks whole", async () => {
  const bytes = encoder.encode("é")
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 1))
      controller.enqueue(bytes.slice(1))
      controller.close()
    },
  })
  expect(await readBounded(stream, 1_000)).toBe("é")
})

test("gives up on a stream that never ends once the deadline passes", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("partial"))
    },
  })
  const started = performance.now()
  expect(await readBounded(stream, 50)).toBe("partial")
  expect(performance.now() - started).toBeLessThan(1_000)
})

test("reads a stream that fails as empty", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("closed"))
    },
  })
  expect(await readBounded(stream, 1_000)).toBe("")
})
