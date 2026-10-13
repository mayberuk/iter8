import { z } from "zod"
import { OwnerId, PairingGeneration } from "./ids"

/** Pid plus OS start time, so a recycled pid never inherits a pairing. */
export const ProcessIdentity = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string().min(1),
  label: z.string().min(1),
})
export type ProcessIdentity = z.infer<typeof ProcessIdentity>

const BackgroundCount = z.number().int().nonnegative()

/** What a session that ended its turn still has running: agents and teammates, and other tasks. */
export const BackgroundWork = z.object({ agents: BackgroundCount, tasks: BackgroundCount })
export type BackgroundWork = z.infer<typeof BackgroundWork>

export const PairingState = z.discriminatedUnion("status", [
  z.object({ status: z.literal("live") }),
  z.object({ status: z.literal("busy") }),
  BackgroundWork.extend({ status: z.literal("background") }).refine(
    (work) => work.agents + work.tasks > 0,
    "background work has at least one agent or task",
  ),
  z.object({ status: z.literal("unknown") }),
  z.object({
    status: z.literal("gone"),
    reason: z.enum(["exited", "crashed", "replaced", "ended"]),
  }),
])
export type PairingState = z.infer<typeof PairingState>

export const Pairing = z.object({
  owner: OwnerId,
  /** The agent kind, such as `claude` or `codex`, which picks the avatar. */
  agent: z.string().min(1),
  process: ProcessIdentity,
  /** Where the agent ran `hook start`. */
  cwd: z.string().startsWith("/"),
  generation: PairingGeneration,
  state: PairingState,
  relabelPending: z.boolean(),
  listener: z.enum(["armed", "none"]),
})
export type Pairing = z.infer<typeof Pairing>

/** A row of the reattach list. */
export const LiveSession = Pairing.pick({
  owner: true,
  agent: true,
  process: true,
  cwd: true,
  state: true,
})
export type LiveSession = z.infer<typeof LiveSession>
