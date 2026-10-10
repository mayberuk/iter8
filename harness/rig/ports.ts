import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

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

const claimsDir = process.env.ITER8_PORT_CLAIMS_DIR ?? join(tmpdir(), "iter8-port-claims")

const errnoCode = (error: unknown) => (error as NodeJS.ErrnoException).code

const ownerIsDead = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return errnoCode(error) === "ESRCH"
  }
}

const removeClaimFile = (path: string) => {
  try {
    unlinkSync(path)
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error
  }
}

// Two processes can both probe a port free before either binds it, so a port is only
// handed out after this process wins an exclusive claim file naming its pid.
// The scan has no await, so concurrent callers never receive the same candidate.
const allocate = (() => {
  const block = portBlock(WORKER)
  const blockSize = block.last - block.first + 1
  const claimed = new Set<number>()
  let cursor = 0

  // `bun test` never emits "exit"; claims it leaves behind are reclaimed through the dead-pid check.
  process.on("exit", () => {
    for (const port of claimed) {
      try {
        removeClaimFile(join(claimsDir, String(port)))
      } catch {}
    }
  })

  const claim = (port: number): "own" | "fresh" | "held" => {
    if (claimed.has(port)) return "own"
    const path = join(claimsDir, String(port))
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(path, "wx")
        try {
          writeSync(fd, String(process.pid))
        } finally {
          closeSync(fd)
        }
        claimed.add(port)
        return "fresh"
      } catch (error) {
        if (errnoCode(error) !== "EEXIST") throw error
      }
      let owner: number
      try {
        owner = Number(readFileSync(path, "utf8"))
      } catch (error) {
        if (errnoCode(error) === "ENOENT") continue
        throw error
      }
      if (!Number.isInteger(owner) || owner < 1 || !ownerIsDead(owner)) return "held"
      removeClaimFile(path)
    }
    return "held"
  }

  const release = (ports: number[]) => {
    for (const port of ports) {
      claimed.delete(port)
      removeClaimFile(join(claimsDir, String(port)))
    }
  }

  return async (size: number) => {
    if (!Number.isSafeInteger(size) || size < 1) {
      throw new Error(`Port pool size must be a positive integer; received ${size}`)
    }
    mkdirSync(claimsDir, { recursive: true })
    for (let step = 0; step < blockSize; step++) {
      const offset = (cursor + step) % blockSize
      if (offset + size > blockSize) continue
      const first = block.first + offset
      const fresh: number[] = []
      let usable = true
      for (let port = first; usable && port < first + size; port++) {
        const state = claim(port)
        if (state === "fresh") fresh.push(port)
        usable = state !== "held" && isFree(port)
      }
      if (!usable) {
        release(fresh)
        continue
      }
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
