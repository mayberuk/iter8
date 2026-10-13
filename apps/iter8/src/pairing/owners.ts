import type { Database } from "bun:sqlite"
import { randomBytes } from "node:crypto"
import {
  type BackgroundWork,
  type HookEndReason,
  type HookSource,
  type LiveSession,
  OwnerId,
  PageId,
  Pairing,
  PairingGeneration,
  PairingState,
} from "@iter8/protocol"
import type { ProcessKey } from "./process-identity"

export type RegisterOwner = {
  pid: number
  label: string
  source: HookSource
  agent: string
  cwd: string
}

export type OwnerEvent =
  | { kind: "relabelled" }
  | { kind: "ended"; reason: HookEndReason }
  | { kind: "busy" }
  | { kind: "idle" }
  | { kind: "stopped"; work: BackgroundWork }
  | { kind: "checked"; process: "alive" | "dead" | "restarted" | "unreadable" }

export function nextPairingState(
  state: PairingState,
  relabelPending: boolean,
  event: OwnerEvent,
): PairingState {
  if (state.status === "gone") return state
  switch (event.kind) {
    case "relabelled":
      return state
    case "ended":
      return event.reason === "clear" || event.reason === "resume"
        ? state
        : { status: "gone", reason: "ended" }
    case "busy":
      return { status: "busy" }
    case "idle":
      return state.status === "background" ? state : { status: "live" }
    case "stopped":
      return event.work.agents + event.work.tasks > 0
        ? { status: "background", ...event.work }
        : { status: "live" }
    case "checked":
      switch (event.process) {
        case "alive":
          return state.status === "unknown" ? { status: "live" } : state
        case "dead":
          return { status: "gone", reason: relabelPending ? "exited" : "crashed" }
        case "restarted":
          return { status: "gone", reason: "replaced" }
        case "unreadable":
          return { status: "unknown" }
      }
  }
}

export type OwnersDeps = {
  processStart: (pid: number) => string | null
  now: () => Date
}

export type Owners = {
  register(input: RegisterOwner): Pairing
  end(pid: number, label: string, reason: HookEndReason): Pairing | null
  byPid(pid: number): OwnerId | null
  resolve(identities: ProcessKey[], explicit: OwnerId | null): OwnerId | null
  setBusy(ownerId: OwnerId, busy: boolean): void
  setStopped(ownerId: OwnerId, work: BackgroundWork): void
  state(ownerId: OwnerId): PairingState
  pairing(ownerId: OwnerId, generation: PairingGeneration, listener: "armed" | "none"): Pairing
  liveSessions(): LiveSession[]
  sweep(): Array<{ ownerId: OwnerId; state: PairingState }>
  pairPage(pageId: PageId, ownerId: OwnerId): PairingGeneration
  checkGeneration(pageId: PageId, generation: PairingGeneration): boolean
  pagesOf(ownerId: OwnerId): PageId[]
}

type OwnerRow = {
  id: string
  agent: string
  pid: number
  started_at: string
  label: string
  cwd: string
  relabel_pending: number
  busy: number
  gone_reason: string | null
}

/**
 * Stored when the OS gave no start time ("unreadable", then "unreadable-2", … because
 * (pid, started_at) is unique). It never equals a real start, so such an owner is never judged
 * dead or replaced, only unknown.
 */
const UNREADABLE_START = "unreadable"
const isUnreadable = (startedAt: string) => /^unreadable(-\d+)?$/.test(startedAt)

export function createOwners(db: Database, deps: OwnersDeps): Owners {
  const selectById = db.query<OwnerRow, [string]>("SELECT * FROM owners WHERE id = ?")
  const selectByIdentity = db.query<OwnerRow, [number, string]>(
    "SELECT * FROM owners WHERE pid = ? AND started_at = ?",
  )
  const selectLiveUnreadable = db.query<OwnerRow, [number]>(
    `SELECT * FROM owners
     WHERE pid = ? AND (started_at = 'unreadable' OR started_at GLOB 'unreadable-[0-9]*')
       AND gone_reason IS NULL
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  )
  const countUnreadable = db.query<{ n: number }, [number]>(
    `SELECT COUNT(*) AS n FROM owners
     WHERE pid = ? AND (started_at = 'unreadable' OR started_at GLOB 'unreadable-[0-9]*')`,
  )
  const selectLatestByPid = db.query<OwnerRow, [number]>(
    "SELECT * FROM owners WHERE pid = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
  )
  const selectAll = db.query<OwnerRow, []>("SELECT * FROM owners ORDER BY created_at, rowid")
  const selectOwnerGeneration = db.query<{ generation: number | null }, [string]>(
    "SELECT MAX(generation) AS generation FROM pages WHERE owner_id = ?",
  )
  const markGone = db.query<null, [string, string]>(
    "UPDATE owners SET gone_reason = ? WHERE id = ? AND gone_reason IS NULL",
  )

  // Not persisted: every Stop hook restates it, and a stored column would make the schema
  // version incompatible with the CLIs of sessions still on older plugins.
  const background = new Map<OwnerId, BackgroundWork>()
  const lastSwept = new Map<OwnerId, PairingState>()
  for (const row of selectAll.all()) {
    if (row.gone_reason !== null) lastSwept.set(OwnerId.parse(row.id), storedState(row))
  }

  function storedState(row: OwnerRow): PairingState {
    if (row.gone_reason !== null) {
      return PairingState.parse({ status: "gone", reason: row.gone_reason })
    }
    const work = background.get(OwnerId.parse(row.id))
    if (work) return { status: "background", ...work }
    return { status: row.busy ? "busy" : "live" }
  }

  function checkedState(row: OwnerRow): PairingState {
    const stored = storedState(row)
    if (stored.status === "gone") return stored
    const unreadable = isUnreadable(row.started_at)
    const current = unreadable ? null : deps.processStart(row.pid)
    const process = unreadable
      ? "unreadable"
      : current === null
        ? "dead"
        : current === row.started_at
          ? "alive"
          : "restarted"
    const next = nextPairingState(stored, row.relabel_pending === 1, { kind: "checked", process })
    if (next.status === "gone") markGone.run(next.reason, row.id)
    return next
  }

  function requireRow(ownerId: OwnerId): OwnerRow {
    const row = selectById.get(ownerId)
    if (!row) throw new Error(`Unknown owner ${ownerId}`)
    return row
  }

  function ownerGeneration(ownerId: OwnerId): PairingGeneration {
    return PairingGeneration.parse(selectOwnerGeneration.get(ownerId)?.generation ?? 0)
  }

  function toPairing(
    row: OwnerRow,
    generation: PairingGeneration,
    listener: "armed" | "none",
  ): Pairing {
    return Pairing.parse({
      owner: row.id,
      agent: row.agent,
      process: { pid: row.pid, startedAt: row.started_at, label: row.label },
      cwd: row.cwd,
      generation,
      state: checkedState(row),
      relabelPending: row.relabel_pending === 1,
      listener,
    })
  }

  function ownerPairing(ownerId: OwnerId): Pairing {
    return toPairing(requireRow(ownerId), ownerGeneration(ownerId), "none")
  }

  function apply(ownerId: OwnerId, event: OwnerEvent) {
    const row = requireRow(ownerId)
    const next = nextPairingState(storedState(row), row.relabel_pending === 1, event)
    if (next.status === "gone") return
    db.query("UPDATE owners SET busy = ? WHERE id = ?").run(next.status === "busy" ? 1 : 0, ownerId)
    if (next.status === "background")
      background.set(ownerId, { agents: next.agents, tasks: next.tasks })
    else background.delete(ownerId)
  }

  function byPid(pid: number): OwnerId | null {
    const startedAt = deps.processStart(pid)
    const row =
      startedAt === null ? selectLatestByPid.get(pid) : selectByIdentity.get(pid, startedAt)
    return row ? OwnerId.parse(row.id) : null
  }

  function unreadableStart(pid: number): string {
    const taken = countUnreadable.get(pid)?.n ?? 0
    return taken === 0 ? UNREADABLE_START : `${UNREADABLE_START}-${taken + 1}`
  }

  return {
    register(input) {
      const readable = deps.processStart(input.pid)
      return db.transaction(() => {
        // With no start time, a pid alone must never revive a gone owner: a recycled pid shows up
        // after the old owner went gone, while /clear keeps the process and its live owner.
        const existing =
          readable === null
            ? selectLiveUnreadable.get(input.pid)
            : selectByIdentity.get(input.pid, readable)
        if (existing) {
          db.query(
            "UPDATE owners SET label = ?, relabel_pending = 0, gone_reason = NULL WHERE id = ?",
          ).run(input.label, existing.id)
          const ownerId = OwnerId.parse(existing.id)
          background.delete(ownerId)
          if (lastSwept.get(ownerId)?.status === "gone") lastSwept.delete(ownerId)
          return ownerPairing(ownerId)
        }
        const ownerId = OwnerId.parse(`o_${randomBytes(12).toString("base64url")}`)
        db.query(
          `INSERT INTO owners (id, agent, pid, started_at, label, cwd, created_at, relabel_pending, busy, gone_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, NULL)`,
        ).run(
          ownerId,
          input.agent,
          input.pid,
          readable ?? unreadableStart(input.pid),
          input.label,
          input.cwd,
          deps.now().toISOString(),
        )
        return ownerPairing(ownerId)
      })()
    },

    end(pid, label, reason) {
      const ownerId = byPid(pid)
      if (!ownerId) return null
      const row = requireRow(ownerId)
      // A /clear can deliver the new session's start before the old session's end; that late end
      // names the old label and must not mark the fresh context pending or gone.
      if (row.label !== label) return ownerPairing(ownerId)
      const stored = storedState(row)
      if (stored.status === "gone") return ownerPairing(ownerId)
      const next = nextPairingState(stored, row.relabel_pending === 1, { kind: "ended", reason })
      if (next.status === "gone") markGone.run(next.reason, ownerId)
      else db.query("UPDATE owners SET relabel_pending = 1 WHERE id = ?").run(ownerId)
      return ownerPairing(ownerId)
    },

    byPid,

    resolve(identities, explicit) {
      if (explicit !== null) return selectById.get(explicit) ? explicit : null
      for (const identity of identities) {
        const row = selectByIdentity.get(identity.pid, identity.startedAt)
        if (row) return OwnerId.parse(row.id)
      }
      return null
    },

    setBusy(ownerId, busy) {
      apply(ownerId, { kind: busy ? "busy" : "idle" })
    },

    setStopped(ownerId, work) {
      apply(ownerId, { kind: "stopped", work })
    },

    state(ownerId) {
      return checkedState(requireRow(ownerId))
    },

    pairing(ownerId, generation, listener) {
      return toPairing(requireRow(ownerId), generation, listener)
    },

    liveSessions() {
      const sessions: LiveSession[] = []
      for (const row of selectAll.all()) {
        const state = checkedState(row)
        if (state.status === "gone") continue
        sessions.push({
          owner: OwnerId.parse(row.id),
          agent: row.agent,
          process: { pid: row.pid, startedAt: row.started_at, label: row.label },
          cwd: row.cwd,
          state,
        })
      }
      return sessions
    },

    sweep() {
      const changed: Array<{ ownerId: OwnerId; state: PairingState }> = []
      for (const row of selectAll.all()) {
        const ownerId = OwnerId.parse(row.id)
        const previous = lastSwept.get(ownerId)
        if (previous?.status === "gone") continue
        const state = checkedState(row)
        // An owner never swept counts as changed, so one that went gone before its first sweep
        // is still reported and its rounds orphaned.
        if (!previous || JSON.stringify(previous) !== JSON.stringify(state)) {
          changed.push({ ownerId, state })
        }
        lastSwept.set(ownerId, state)
      }
      return changed
    },

    pairPage(pageId, ownerId) {
      return db.transaction(() => {
        const row = db
          .query<{ generation: number }, [string, string]>(
            "UPDATE pages SET owner_id = ?, generation = generation + 1 WHERE id = ? RETURNING generation",
          )
          .get(ownerId, pageId)
        if (!row) throw new Error(`Unknown page ${pageId}`)
        return PairingGeneration.parse(row.generation)
      })()
    },

    checkGeneration(pageId, generation) {
      const row = db
        .query<{ generation: number }, [string]>("SELECT generation FROM pages WHERE id = ?")
        .get(pageId)
      return row?.generation === generation
    },

    pagesOf(ownerId) {
      return db
        .query<{ id: string }, [string]>("SELECT id FROM pages WHERE owner_id = ? ORDER BY id")
        .all(ownerId)
        .map((row) => PageId.parse(row.id))
    },
  }
}
