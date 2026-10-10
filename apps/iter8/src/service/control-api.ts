import { zValidator } from "@hono/zod-validator"
import {
  AgentNoteResult,
  DoneResult,
  ElementAnchor,
  HookEndReason,
  HookSource,
  HttpUrl,
  Intent,
  LANDING_PATH,
  LandingFragment,
  type MachineId,
  Note,
  NoteId,
  Ok,
  OpenResult,
  OwnerId,
  Page,
  PageId,
  Pairing,
  PairingGeneration,
  PairResult,
  ProcessIdentity,
  type Round,
  RoundId,
  RoundPointer,
  RoundsResult,
  ScreenshotRef,
  ServiceStatus,
  ShowResult,
} from "@iter8/protocol"
import { Hono } from "hono"
import { z } from "zod"
import type { AgentNotes } from "../pages/agent-notes"
import type { PageRecord, Pages } from "../pages/pages"
import type { Screenshots } from "../pages/screenshots"
import type { Owners } from "../pairing/owners"
import type { Inbox } from "../rounds/inbox"
import type { LiveHub } from "./live"
import type { Waiters } from "./waiters"

export type ControlApiDeps = {
  pages: Pages
  owners: Owners
  inbox: Inbox
  agentNotes: AgentNotes
  screenshots: Screenshots
  live: LiveHub
  waiters: Waiters
  status: (owner: OwnerId | null) => ServiceStatus
  drain: () => void
  onPageOpened: (record: PageRecord) => void
  poolPorts: () => number[]
  machineId: MachineId
}

const Caller = z.object({
  identities: z.array(ProcessIdentity.pick({ pid: true, startedAt: true })),
  owner: OwnerId.nullable(),
})
type Caller = z.infer<typeof Caller>

const HookPid = z.object({ pid: ProcessIdentity.shape.pid })

const HookStart = z.object({
  pid: ProcessIdentity.shape.pid,
  label: ProcessIdentity.shape.label,
  source: HookSource,
  agent: Pairing.shape.agent,
  cwd: Pairing.shape.cwd,
})

const HookEnd = z.object({
  pid: ProcessIdentity.shape.pid,
  label: ProcessIdentity.shape.label,
  reason: HookEndReason,
})

const HookWaitQuery = z.object({
  pid: z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .transform(Number),
  // setTimeout fires at once for a delay past a signed 32-bit millisecond count.
  timeoutSeconds: z
    .string()
    .regex(/^[0-9]{1,7}$/)
    .transform(Number)
    .pipe(z.number().max(2_147_483)),
})

const HookStartResult = PairResult.extend({ pointers: z.array(RoundPointer) })
const Pointers = z.object({ pointers: z.array(RoundPointer) })
const HookWaitResult = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("woken"), pointers: z.array(RoundPointer).min(1) }),
  z.object({ outcome: z.enum(["replaced", "timeout", "cancelled"]) }),
])

const [ServerTarget, FolderTarget] = Page.shape.target.options
const OpenBody = Caller.extend({
  target: z.discriminatedUnion("kind", [
    ServerTarget.pick({ kind: true, upstream: true }),
    FolderTarget.extend({
      file: z
        .string()
        .regex(/^[^/]+$/)
        .nullable(),
    }),
  ]),
  upstreams: z.array(HttpUrl),
  cwd: Pairing.shape.cwd,
})

const AttachBody = Caller.extend({ page: PageId })
const ShowBody = Caller.extend({ round: RoundId })
const DoneBody = Caller.extend({ note: NoteId, reply: z.string().min(1).nullable() })
const NoteBody = Caller.extend({
  page: PageId,
  intent: Intent,
  body: Note.shape.body,
  at: ElementAnchor.shape.selector,
  role: ElementAnchor.shape.role,
  name: ElementAnchor.shape.name,
  text: ElementAnchor.shape.text,
})

const noOwner = "No paired owner resolved; run this from the agent session or pass --owner"

export function createControlApi(deps: ControlApiDeps) {
  const listenerOf = (ownerId: OwnerId) => (deps.waiters.isArmed(ownerId) ? "armed" : "none")

  // An explicit --owner naming no known owner refuses rather than acting as an ownerless person.
  function resolveCaller(caller: Caller): { owner: OwnerId | null } | null {
    const owner = deps.owners.resolve(caller.identities, caller.owner)
    return caller.owner !== null && owner === null ? null : { owner }
  }

  function labelOf(ownerId: OwnerId): string {
    return deps.owners.pairing(ownerId, PairingGeneration.parse(0), "none").process.label
  }

  function pagePairing(record: PageRecord): Pairing | null {
    const link = record.page.pairing
    return link && deps.owners.pairing(link.owner, link.generation, listenerOf(link.owner))
  }

  function requirePage(pageId: PageId): PageRecord {
    const record = deps.pages.get(pageId)
    if (!record) throw new Error(`Unknown page ${pageId}`)
    return record
  }

  function pushRound(round: Round): void {
    deps.live.push(round.pageId, { type: "round", round })
  }

  function pushPairing(ownerId: OwnerId): void {
    for (const pageId of deps.owners.pagesOf(ownerId)) {
      const record = deps.pages.get(pageId)
      if (record) deps.live.push(pageId, { type: "pairing", pairing: pagePairing(record) })
    }
  }

  function deliver(ownerId: OwnerId, label: string): RoundPointer[] {
    const pointers = deps.inbox.pending(ownerId, label)
    deps.inbox.announce(
      ownerId,
      label,
      pointers.map((pointer) => pointer.roundId),
    )
    for (const pointer of pointers) {
      const round = deps.inbox.round(pointer.roundId)
      if (round) pushRound(round)
    }
    return pointers
  }

  function pair(pageId: PageId, ownerId: OwnerId): PageRecord {
    deps.owners.pairPage(pageId, ownerId)
    const requeued = deps.inbox.requeuePage(pageId, ownerId)
    const record = requirePage(pageId)
    deps.live.push(pageId, { type: "pairing", pairing: pagePairing(record) })
    for (const round of requeued) pushRound(round)
    if (requeued.length) deps.waiters.wake(ownerId)
    return record
  }

  function roundOfNote(noteId: NoteId): Round | null {
    for (const summary of deps.inbox.summaries({})) {
      const round = deps.inbox.round(summary.id)
      if (round?.notes.some((note) => note.id === noteId)) return round
    }
    return null
  }

  return new Hono()
    .post("/hook/start", zValidator("json", HookStart), (c) => {
      const registered = deps.owners.register(c.req.valid("json"))
      const ownerId = registered.owner
      const pointers = deliver(ownerId, registered.process.label)
      pushPairing(ownerId)
      const pairing = deps.owners.pairing(ownerId, registered.generation, listenerOf(ownerId))
      return c.json(HookStartResult.parse({ pairing, pointers }), 200)
    })
    .post("/hook/prompt", zValidator("json", HookPid), (c) => {
      const { pid } = c.req.valid("json")
      const ownerId = deps.owners.byPid(pid)
      if (!ownerId) return c.text(`No owner registered for pid ${pid}`, 404)
      deps.owners.setBusy(ownerId, true)
      const pointers = deliver(ownerId, labelOf(ownerId))
      pushPairing(ownerId)
      return c.json(Pointers.parse({ pointers }), 200)
    })
    .post("/hook/stop", zValidator("json", HookPid), (c) => {
      const { pid } = c.req.valid("json")
      const ownerId = deps.owners.byPid(pid)
      if (!ownerId) return c.text(`No owner registered for pid ${pid}`, 404)
      deps.owners.setBusy(ownerId, false)
      pushPairing(ownerId)
      return c.json(Ok.parse({ ok: true }), 200)
    })
    .get("/hook/wait", zValidator("query", HookWaitQuery), async (c) => {
      const { pid, timeoutSeconds } = c.req.valid("query")
      const ownerId = deps.owners.byPid(pid)
      if (!ownerId) return c.text(`No owner registered for pid ${pid}`, 404)
      const ready = deliver(ownerId, labelOf(ownerId))
      if (ready.length) {
        return c.json(HookWaitResult.parse({ outcome: "woken", pointers: ready }), 200)
      }
      const deadline = Date.now() + timeoutSeconds * 1000
      // A wake whose rounds another hook already announced under this label leaves nothing to
      // deliver; the wait re-arms rather than waking the session with no pointer.
      for (;;) {
        const armed = deps.waiters.arm(ownerId, Math.max(0, deadline - Date.now()))
        pushPairing(ownerId)
        const outcome = await armed
        pushPairing(ownerId)
        if (outcome !== "woken") return c.json(HookWaitResult.parse({ outcome }), 200)
        const pointers = deliver(ownerId, labelOf(ownerId))
        if (pointers.length) return c.json(HookWaitResult.parse({ outcome, pointers }), 200)
      }
    })
    .post("/hook/end", zValidator("json", HookEnd), (c) => {
      const { pid, label, reason } = c.req.valid("json")
      const pairing = deps.owners.end(pid, label, reason)
      if (!pairing) return c.text(`No owner registered for pid ${pid}`, 404)
      if (pairing.state.status === "gone") {
        for (const round of deps.inbox.orphanFor(pairing.owner)) pushRound(round)
      }
      pushPairing(pairing.owner)
      return c.json(Ok.parse({ ok: true }), 200)
    })
    .post("/open", zValidator("json", OpenBody), (c) => {
      const body = c.req.valid("json")
      const caller = resolveCaller(body)
      if (!caller) return c.text(`Unknown owner ${body.owner}`, 409)
      if (caller.owner && deps.owners.state(caller.owner).status === "gone") {
        return c.text(`Owner ${caller.owner} is gone`, 409)
      }
      if (body.target.kind === "folder" && body.upstreams.length) {
        return c.text("--upstream applies only to a dev server target", 400)
      }
      const poolPorts = deps.poolPorts()
      let record: PageRecord
      try {
        record = deps.pages.open({
          target:
            body.target.kind === "server"
              ? { kind: "server", upstream: body.target.upstream, extras: body.upstreams }
              : { kind: "folder", root: body.target.root },
          projectRoot: body.cwd,
          poolPorts,
        })
      } catch (error) {
        if (error instanceof Error) {
          const code = "code" in error ? error.code : null
          if (code === "ENOENT" || code === "ENOTDIR") return c.text(error.message, 404)
          if (error.message.startsWith("Not enough ports")) return c.text(error.message, 409)
        }
        throw error
      }
      if (caller.owner && record.page.pairing?.owner !== caller.owner) {
        record = pair(record.page.id, caller.owner)
      }
      deps.onPageOpened(record)
      const { page, token } = record
      const fragment = new URLSearchParams(
        LandingFragment.parse({ m: deps.machineId, p: page.id, t: token }),
      )
      const file =
        body.target.kind === "folder" && body.target.file !== null
          ? encodeURIComponent(body.target.file)
          : ""
      return c.json(
        OpenResult.parse({
          page,
          url: `${page.origin}/${file}`,
          landingUrl: `${page.origin}${LANDING_PATH}#${fragment}`,
          poolPorts,
        }),
        200,
      )
    })
    .post("/attach", zValidator("json", AttachBody), (c) => {
      const body = c.req.valid("json")
      const owner = resolveCaller(body)?.owner
      if (!owner) return c.text(noOwner, 409)
      if (!deps.pages.get(body.page)) return c.text(`Unknown page ${body.page}`, 404)
      if (deps.owners.state(owner).status === "gone") return c.text(`Owner ${owner} is gone`, 409)
      return c.json(PairResult.parse({ pairing: pagePairing(pair(body.page, owner)) }), 200)
    })
    .post("/rounds", zValidator("json", Caller), (c) => {
      const body = c.req.valid("json")
      const caller = resolveCaller(body)
      if (!caller) return c.text(`Unknown owner ${body.owner}`, 409)
      const filter = caller.owner ? { ownerId: caller.owner } : {}
      return c.json(RoundsResult.parse({ rounds: deps.inbox.summaries(filter) }), 200)
    })
    .post("/show", zValidator("json", ShowBody), (c) => {
      const body = c.req.valid("json")
      const caller = resolveCaller(body)
      if (!caller) return c.text(`Unknown owner ${body.owner}`, 409)
      const round = deps.inbox.round(body.round)
      if (!round) return c.text(`Unknown round ${body.round}`, 404)
      if (caller.owner && round.owner !== caller.owner) {
        return c.text(`Round ${round.id} belongs to another owner`, 409)
      }
      const claimed = deps.inbox.claim(round.id) ?? round
      pushRound(claimed)
      return c.json(
        ShowResult.parse({
          round: {
            id: claimed.id,
            pageId: claimed.pageId,
            stage: claimed.state.stage,
            url: `${requirePage(claimed.pageId).page.origin}/`,
          },
          notes: claimed.notes.map(({ capture = null, ...authored }) => ({
            authored,
            untrustedCapture: capture,
          })),
        }),
        200,
      )
    })
    .get("/screenshots/:ref", zValidator("param", z.object({ ref: ScreenshotRef })), (c) => {
      const { ref } = c.req.valid("param")
      const png = deps.screenshots.read(null, ref)
      if (!png) return c.text(`Unknown screenshot ${ref}`, 404)
      return c.body(new Uint8Array(png), 200, { "content-type": "image/png" })
    })
    .post("/done", zValidator("json", DoneBody), (c) => {
      const body = c.req.valid("json")
      const caller = resolveCaller(body)
      if (!caller) return c.text(`Unknown owner ${body.owner}`, 409)
      const round = roundOfNote(body.note)
      if (!round) return c.text(`Unknown note ${body.note}`, 404)
      if (caller.owner && round.owner !== caller.owner) {
        return c.text(`Note ${body.note} belongs to another owner's round`, 409)
      }
      const resolved = deps.inbox.resolveNote(body.note, body.reply)
      if (!resolved) return c.text(`Unknown note ${body.note}`, 404)
      pushRound(resolved.round)
      return c.json(
        DoneResult.parse({
          roundId: resolved.round.id,
          noteId: body.note,
          resolution: resolved.resolution,
        }),
        200,
      )
    })
    .post("/note", zValidator("json", NoteBody), (c) => {
      const body = c.req.valid("json")
      const owner = resolveCaller(body)?.owner
      if (!owner) return c.text(noOwner, 409)
      const record = deps.pages.get(body.page)
      if (!record) return c.text(`Unknown page ${body.page}`, 404)
      const pairing = pagePairing(record)
      if (pairing?.owner !== owner) return c.text(`Page ${body.page} is not paired with you`, 409)
      if (pairing.state.status === "gone") return c.text(`Owner ${owner} is gone`, 409)
      const note = deps.agentNotes.add(record.page.id, {
        author: {
          kind: "agent",
          owner: pairing.owner,
          name: pairing.process.label,
          agent: pairing.agent,
        },
        intent: body.intent,
        body: body.body,
        at: body.at,
        ...(body.role === undefined ? {} : { role: body.role }),
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.text === undefined ? {} : { text: body.text }),
      })
      deps.live.push(record.page.id, { type: "agent-note", note })
      return c.json(AgentNoteResult.parse({ note, anchorStatus: note.anchorStatus }), 200)
    })
    .post("/status", zValidator("json", Caller), (c) => {
      const body = c.req.valid("json")
      const caller = resolveCaller(body)
      if (!caller) return c.text(`Unknown owner ${body.owner}`, 409)
      return c.json(ServiceStatus.parse(deps.status(caller.owner)), 200)
    })
    .post("/drain", (c) => {
      setTimeout(deps.drain, 0)
      return c.body(null, 202)
    })
}

export type ControlApp = ReturnType<typeof createControlApi>
