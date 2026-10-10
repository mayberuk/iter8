import { closeSync, existsSync, mkdirSync, openSync } from "node:fs"
import { PROTOCOL_VERSION, ServiceStatus } from "@iter8/protocol"
import type { Iter8Paths } from "../home"
import { BUILD, liveLockHolder, VERSION } from "../service/lifecycle"
import { LATEST_MIGRATION_VERSION } from "../store/db"
import { type ControlClient, controlClientFor } from "./client"

const POLL_MS = 100
const DRAIN_DEADLINE_MS = 10_000
const READY_DEADLINE_MS = 30_000

export type EnsureDeps = {
  spawn: typeof Bun.spawn
  env: Record<string, string | undefined>
  /** The argv prefix that runs this same executable; `serve` is appended. */
  command: string[]
}

type Probe = "unreachable" | "current" | "pending" | "mismatched"

async function probe(client: ControlClient): Promise<Probe> {
  let body: unknown
  try {
    const response = await client.status.$post({ json: { identities: [], owner: null } })
    body = response.ok ? await response.json() : null
  } catch {
    return "unreachable"
  }
  const status = ServiceStatus.safeParse(body)
  if (
    !status.success ||
    status.data.protocolVersion !== PROTOCOL_VERSION ||
    status.data.schemaVersion !== LATEST_MIGRATION_VERSION ||
    status.data.version !== VERSION ||
    status.data.build !== BUILD
  ) {
    return "mismatched"
  }
  return status.data.state === "ready" ? "current" : "pending"
}

async function drainOld(client: ControlClient, paths: Iter8Paths): Promise<void> {
  try {
    await client.drain.$post()
  } catch {}
  const deadline = Date.now() + DRAIN_DEADLINE_MS
  while (existsSync(paths.lock)) {
    if (Date.now() > deadline) {
      throw new Error(
        `The running iter8 service is another version and did not stop within ${DRAIN_DEADLINE_MS / 1000} s`,
      )
    }
    await Bun.sleep(POLL_MS)
  }
}

function spawnService(paths: Iter8Paths, deps: EnsureDeps): void {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 })
  const log = openSync(paths.log, "a", 0o600)
  try {
    const child = deps.spawn([...deps.command, "serve"], {
      cwd: paths.home,
      env: deps.env,
      detached: true,
      stdio: ["ignore", log, log],
    })
    child.unref()
  } finally {
    closeSync(log)
  }
}

/**
 * Returns a client for a ready service of this exact build, draining one of another version and
 * starting this executable when needed. Null only when none is reachable and `start` is false.
 */
export async function ensureService(
  paths: Iter8Paths,
  deps: EnsureDeps,
  options: { start: boolean },
): Promise<ControlClient | null> {
  const client = controlClientFor(paths.controlSocket)
  let state = await probe(client)
  const deadline = Date.now() + READY_DEADLINE_MS
  let spawned = false
  for (;;) {
    if (state === "current") return client
    if (!options.start) {
      if (state === "unreachable") return null
      if (state === "mismatched") return client
    }
    if (state === "mismatched") {
      await drainOld(client, paths)
    } else if (state === "unreachable" && !spawned && !liveLockHolder(paths.lock)) {
      spawnService(paths, deps)
      spawned = true
    }
    if (Date.now() > deadline) {
      throw new Error(
        `The iter8 service did not become ready within ${READY_DEADLINE_MS / 1000} s; see ${paths.log}`,
      )
    }
    if (state !== "mismatched") await Bun.sleep(POLL_MS)
    state = await probe(client)
  }
}
