import { join } from "node:path"
import {
  AGENT_ROUTES,
  AGENT_WAIT_MAX_SECONDS,
  type AgentDelivery,
  AgentState,
  AgentWaitResult,
  Ok,
  type OwnerId,
  ServiceStatus,
  TranscriptResult,
  type TranscriptRow,
} from "@iter8/protocol"
import type { AgentSession } from "../rig/agent"
import { waitFor } from "../rig/wait"

const PAIRED_TIMEOUT_MS = 15_000

/** A stand-in for the Claude Code mod: it long-polls the control socket as the real one does. */
export type StubMod = {
  owner: OwnerId
  pid: number
  /** Every delivery the wait loop has received, oldest first. */
  deliveries: AgentDelivery[]
  forward(rows: TranscriptRow[]): Promise<TranscriptResult>
  turn(state: "busy" | "idle"): Promise<void>
  state(): Promise<AgentState>
  /** Aborts the pending wait and resolves once the loop has ended; rejects with its failure. */
  stop(): Promise<void>
}

/** Bootstraps the way the real mod does: `status --json` run as the session's child. */
export async function startStubMod(session: AgentSession): Promise<StubMod> {
  const status = await waitFor(
    "status --json to resolve the session's owner",
    async () => {
      const parsed = (await session.run(["status", "--json"])).json(ServiceStatus)
      return parsed.owner === null ? null : parsed
    },
    { timeoutMs: PAIRED_TIMEOUT_MS, everyMs: 100 },
  )
  if (status.owner === null) throw new Error("status resolved no owner for the session")
  const owner = status.owner.owner
  const unix = join(status.home, "control.sock")

  const send = (method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal) =>
    fetch(`http://iter8${path}`, {
      method,
      unix,
      ...(signal === undefined ? {} : { signal }),
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    })

  const parsed = async <T>(response: Response, schema: { parse(value: unknown): T }) => {
    if (!response.ok) {
      throw new Error(`${response.url} answered ${response.status}: ${await response.text()}`)
    }
    return schema.parse(await response.json())
  }

  const deliveries: AgentDelivery[] = []
  const stopping = new AbortController()
  const waitPath = `${AGENT_ROUTES.wait.path}?${new URLSearchParams({
    owner,
    timeoutSeconds: String(AGENT_WAIT_MAX_SECONDS),
  })}`
  let failure: unknown = null
  const loop = (async () => {
    try {
      while (!stopping.signal.aborted) {
        const response = await send("GET", waitPath, undefined, stopping.signal)
        if (response.status === 404 || response.status === 409) return
        const answer = await parsed(response, AgentWaitResult)
        if (answer.outcome === "deliver") deliveries.push(...answer.deliveries)
      }
    } catch (error) {
      if (!stopping.signal.aborted) failure = error
    }
  })()

  return {
    owner,
    pid: status.owner.process.pid,
    deliveries,
    forward: async (rows) =>
      parsed(await send("POST", AGENT_ROUTES.transcript.path, { owner, rows }), TranscriptResult),
    turn: async (state) => {
      await parsed(await send("POST", AGENT_ROUTES.turn.path, { owner, state }), Ok)
    },
    state: async () =>
      parsed(
        await send("GET", `${AGENT_ROUTES.state.path}?${new URLSearchParams({ owner })}`),
        AgentState,
      ),
    stop: async () => {
      stopping.abort()
      await loop
      if (failure !== null) throw failure
    },
  }
}
