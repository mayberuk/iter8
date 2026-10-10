const workerId = process.env.BUN_TEST_WORKER_ID ?? "1"

if (!/^\d+$/.test(workerId) || !Number.isSafeInteger(Number(workerId)) || Number(workerId) < 1) {
  throw new Error(`BUN_TEST_WORKER_ID must be a positive integer; received ${workerId}`)
}

export const WORKER = Number(workerId)

export function portBlock(worker: number): { first: number; last: number } {
  if (!Number.isSafeInteger(worker) || worker < 1) {
    throw new Error(`BUN_TEST_WORKER_ID must be a positive integer; received ${worker}`)
  }
  const first = 21000 + 100 * (worker - 1)
  const last = first + 99
  if (last >= 32768) {
    throw new Error(`BUN_TEST_WORKER_ID ${worker} has no 100-port block below 32768`)
  }
  return { first, last }
}

const isFree = (port: number): boolean => {
  try {
    Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: {
        data(socket) {
          socket.end()
        },
      },
    }).stop(true)
    return true
  } catch {
    return false
  }
}

// The scan has no await, so concurrent callers never receive the same candidate.
const allocate = (() => {
  const block = portBlock(WORKER)
  const blockSize = block.last - block.first + 1
  let cursor = 0

  return async (size: number) => {
    if (!Number.isSafeInteger(size) || size < 1) {
      throw new Error(`Port pool size must be a positive integer; received ${size}`)
    }
    for (let step = 0; step < blockSize; step++) {
      const offset = (cursor + step) % blockSize
      if (offset + size > blockSize) continue
      const first = block.first + offset
      let free = true
      for (let port = first; free && port < first + size; port++) free = isFree(port)
      if (!free) continue
      cursor = (offset + size) % blockSize
      return { first, last: first + size - 1 }
    }
    throw new Error(`Port block ${block.first}-${block.last} exhausted for worker ${WORKER}`)
  }
})()

export async function nextPort(): Promise<number> {
  return (await allocate(1)).first
}

export async function poolRange(size: number): Promise<string> {
  const { first, last } = await allocate(size)
  return `${first}-${last}`
}
