import { existsSync, linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { hostname } from "node:os"
import { join, resolve } from "node:path"
import {
  type OwnerId,
  PairingGeneration,
  PROTOCOL_VERSION,
  ProcessIdentity,
  ServiceStatus,
} from "@iter8/protocol"
import pino from "pino"
import pkg from "../../../../package.json"
import { poolPorts, readServiceConfig, resolvePaths } from "../home"
import { createAgentNotes } from "../pages/agent-notes"
import { createPages, randomPageToken } from "../pages/pages"
import { createPrefs } from "../pages/prefs"
import { createScreenshots } from "../pages/screenshots"
import { createOwners } from "../pairing/owners"
import { readProcessStart } from "../pairing/process-identity"
import { createInbox } from "../rounds/inbox"
import { LATEST_MIGRATION_VERSION, openStore, readOrCreateMachineId } from "../store/db"
import { createSymbolicator } from "../symbolicate/symbolicate"
import { resolveOverlayDir } from "./assets"
import { createControlApi } from "./control-api"
import { createLiveHub } from "./live"
import { createOverlayApi, type OverlayApiDeps, pagePairing } from "./overlay-api"
import { type RunningServer, startServer } from "./server"
import { createWaiters } from "./waiters"

export const VERSION: string = pkg.version
export const BUILD: "compiled" | "source" = Bun.isStandaloneExecutable ? "compiled" : "source"

const SWEEP_MS = 2_000
const REPO_OVERLAY_DIR = resolve(import.meta.dir, "../../../../dist/overlay")

const LockHolder = ProcessIdentity.pick({ pid: true, startedAt: true })

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined
}

/** The process a lock file names, when the file parses and that exact process is still running. */
export function liveLockHolder(lock: string): { pid: number; startedAt: string } | null {
  let holder: { pid: number; startedAt: string }
  try {
    holder = LockHolder.parse(JSON.parse(readFileSync(lock, "utf8")))
  } catch {
    return null
  }
  return readProcessStart(holder.pid) === holder.startedAt ? holder : null
}

// link(2) creates the lock with its content in one step; open "wx" then write leaves a window in
// which a concurrent starter reads an empty lock and takes it over as stale.
function acquireLock(lock: string): "acquired" | "held" {
  const startedAt = readProcessStart(process.pid)
  if (startedAt === null) throw new Error("Cannot read this process's start time")
  const staging = `${lock}.${process.pid}`
  writeFileSync(staging, JSON.stringify(LockHolder.parse({ pid: process.pid, startedAt })), {
    mode: 0o600,
  })
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(staging, lock)
        return "acquired"
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error
      }
      if (attempt > 0 || liveLockHolder(lock)) return "held"
      const aside = `${lock}.stale.${process.pid}`
      try {
        renameSync(lock, aside)
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error
        continue
      }
      // Another starter may have replaced the stale lock between the check and the rename.
      if (liveLockHolder(aside)) {
        try {
          linkSync(aside, lock)
        } catch {}
        unlinkSync(aside)
        return "held"
      }
      unlinkSync(aside)
    }
    return "held"
  } finally {
    unlinkSync(staging)
  }
}

export type RunServiceOptions = {
  env: Record<string, string | undefined>
  embeddedOverlayDir: string
  idleMs: number
  exit: (code: number) => void
}

/** Resolves once the service is ready, or has exited because another one holds the lock. */
export async function runService(options: RunServiceOptions): Promise<void> {
  const { env, idleMs, exit } = options
  const paths = resolvePaths(env)

  let interrupted = false
  let shutdown: (() => Promise<void>) | null = null
  const onSignal = () => {
    if (shutdown) void shutdown()
    else interrupted = true
  }
  process.on("SIGTERM", onSignal)
  process.on("SIGINT", onSignal)

  const logger = pino(
    { base: { pid: process.pid } },
    pino.destination({ dest: paths.log, mode: 0o600, mkdir: true, sync: true }),
  )
  const stopListening = () => {
    process.off("SIGTERM", onSignal)
    process.off("SIGINT", onSignal)
  }

  if (acquireLock(paths.lock) === "held") {
    logger.info({ holder: liveLockHolder(paths.lock) }, "already running")
    stopListening()
    exit(0)
    return
  }

  let db: ReturnType<typeof openStore> | null = null
  let server: RunningServer | null = null
  try {
    const store = openStore(paths.db)
    db = store
    const machineId = readOrCreateMachineId(store)
    const config = await readServiceConfig(paths, process.platform)
    const ports = poolPorts(env, config)
    const machineName = hostname()
    const overlayDir = resolveOverlayDir(env, options.embeddedOverlayDir, REPO_OVERLAY_DIR)

    const now = () => new Date()
    const owners = createOwners(store, { processStart: readProcessStart, now })
    const pages = createPages(store, { randomToken: randomPageToken })
    const waiters = createWaiters()
    const live = createLiveHub()
    const screenshots = createScreenshots(store, { now })
    const agentNotes = createAgentNotes(store, { now })
    const overlay: OverlayApiDeps = {
      pages,
      owners,
      inbox: createInbox(store, {
        now,
        ownerState: (ownerId) => owners.state(ownerId),
        pairing: (pageId) => {
          const record = pages.get(pageId)
          return record && pagePairing(overlay, record)
        },
      }),
      agentNotes,
      screenshots,
      prefs: createPrefs(store),
      live,
      waiters,
      symbolicator: createSymbolicator({
        fetch,
        readFile: (path) => readFile(path, "utf8").catch(() => null),
      }),
      overlayDir,
      machineId,
      machineName,
      serviceVersion: VERSION,
    }
    const { inbox } = overlay

    let state: ServiceStatus["state"] = "starting"

    const ownerGeneration = (ownerId: OwnerId) =>
      PairingGeneration.parse(
        Math.max(
          0,
          ...owners
            .pagesOf(ownerId)
            .map((pageId) => pages.get(pageId)?.page.pairing?.generation ?? 0),
        ),
      )

    const pushPairing = (ownerId: OwnerId) => {
      for (const pageId of owners.pagesOf(ownerId)) {
        const record = pages.get(pageId)
        if (record) live.push(pageId, { type: "pairing", pairing: pagePairing(overlay, record) })
      }
    }

    const orphanRoundsOf = (ownerId: OwnerId) => {
      for (const round of inbox.orphanFor(ownerId)) {
        live.push(round.pageId, { type: "round", round })
      }
    }

    const sweep = () => {
      try {
        for (const { ownerId, state: ownerState } of owners.sweep()) {
          pushPairing(ownerId)
          if (ownerState.status === "gone") orphanRoundsOf(ownerId)
        }
      } catch (error) {
        logger.error({ err: error }, "liveness sweep failed")
      }
    }

    let idleSince: number | null = null
    const checkIdle = () => {
      try {
        const idle =
          owners.liveSessions().length === 0 && live.size() === 0 && inbox.unclaimedCount() === 0
        if (!idle) {
          idleSince = null
          return
        }
        idleSince ??= Date.now()
        if (Date.now() - idleSince >= idleMs) {
          logger.info({ idleMs }, "idle")
          void drain()
        }
      } catch (error) {
        logger.error({ err: error }, "idle check failed")
      }
    }

    let timers: ReturnType<typeof setInterval>[] = []
    let draining: Promise<void> | null = null
    const drain = () => {
      draining ??= (async () => {
        state = "draining"
        logger.info("draining")
        live.broadcast({ type: "draining" })
        for (const timer of timers) clearInterval(timer)
        waiters.cancelAll()
        live.closeAll(1012, "service restarting")
        // RunningServer.stop closes open connections, so the cancelled waits get one macrotask
        // to write their responses before the control socket goes.
        await new Promise((settle) => setImmediate(settle))
        try {
          await server?.stop()
        } catch (error) {
          logger.error({ err: error }, "stopping the listeners failed")
        }
        store.close()
        removeLock(paths.lock)
        logger.info("stopped")
        stopListening()
        exit(0)
      })()
      return draining
    }

    const controlApp = createControlApi({
      pages,
      owners,
      inbox,
      agentNotes,
      screenshots,
      live,
      waiters,
      status: (owner) =>
        ServiceStatus.parse({
          state,
          version: VERSION,
          build: BUILD,
          protocolVersion: PROTOCOL_VERSION,
          schemaVersion: LATEST_MIGRATION_VERSION,
          machineId,
          machineName,
          pid: process.pid,
          home: paths.home,
          pool: server?.ports ?? [],
          overlay: existsSync(join(overlayDir, "overlay.js")) ? "present" : "missing",
          owner:
            owner &&
            owners.pairing(
              owner,
              ownerGeneration(owner),
              waiters.isArmed(owner) ? "armed" : "none",
            ),
        }),
      drain: () => void drain(),
      onPageOpened: (record) => server?.watchFolder(record),
      poolPorts: () => server?.ports ?? [],
      machineId,
    })

    server = await startServer({
      overlayApp: createOverlayApi(overlay),
      controlApp,
      overlay,
      poolPorts: ports,
      controlSocket: paths.controlSocket,
      fetch,
    })
    pages.reassignPorts(server.ports)
    for (const record of pages.list()) server.watchFolder(record)

    // The sweep never reports an owner stored as gone, so a service killed between marking an
    // owner gone and orphaning its rounds would leave them queued forever.
    const stranded = inbox
      .summaries({})
      .filter((round) => round.stage === "queued" || round.stage === "announced")
    for (const ownerId of new Set(stranded.flatMap((round) => round.owner ?? []))) {
      if (owners.state(ownerId).status === "gone") orphanRoundsOf(ownerId)
    }

    timers = [setInterval(sweep, SWEEP_MS), setInterval(checkIdle, Math.min(30_000, idleMs / 4))]
    state = "ready"
    shutdown = drain
    logger.info({ version: VERSION, build: BUILD, pool: server.ports }, "ready")
    if (interrupted) void drain()
  } catch (error) {
    logger.error({ err: error }, "start failed")
    await server?.stop().catch(() => {})
    db?.close()
    removeLock(paths.lock)
    stopListening()
    throw error
  }
}

function removeLock(lock: string): void {
  try {
    unlinkSync(lock)
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error
  }
}
