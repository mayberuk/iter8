import { z } from "zod"
import { AnchorStatus } from "./anchor"
import { Capture } from "./capture"
import { MachineId, NoteId, RoundId } from "./ids"
import { ClosedResolution, Intent, Note } from "./note"
import { HttpUrl, Page, Port } from "./page"
import { Pairing } from "./pairing"
import { Round, RoundStage, RoundSummary } from "./round"
import { ProtocolVersion } from "./version"

export const CLI_NAME = "iter8"

export const CliCommand = z.enum([
  "open",
  "connect",
  "attach",
  "rounds",
  "show",
  "done",
  "note",
  "status",
  "version",
  "serve",
  "hook",
])
export type CliCommand = z.infer<typeof CliCommand>

export const HookCommand = z.enum(["start", "prompt", "stop", "wait", "end", "tool"])
export type HookCommand = z.infer<typeof HookCommand>

export const HookSource = z.enum(["startup", "resume", "clear", "compact"])
export type HookSource = z.infer<typeof HookSource>

export const HookEndReason = z.enum(["clear", "resume", "logout", "prompt_input_exit", "other"])
export type HookEndReason = z.infer<typeof HookEndReason>

/**
 * Refused covers a stale generation, a gone pairing, a wrong owner and a page not owned. Wake is
 * only ever returned by `hook wait`.
 */
export const ExitCode = {
  ok: 0,
  failure: 1,
  wake: 2,
  notFound: 3,
  refused: 4,
  serviceUnavailable: 5,
  usage: 64,
} as const

export const ENV = {
  /** The state directory; `~/.iter8` when unset. */
  home: "ITER8_HOME",
  /** A `first-last` port range that overrides the config file's pool. */
  pool: "ITER8_POOL",
  overlayDir: "ITER8_OVERLAY_DIR",
} as const

export const OpenResult = z.object({
  page: Page,
  url: HttpUrl,
  landingUrl: HttpUrl,
  poolPorts: z.array(Port),
})
export type OpenResult = z.infer<typeof OpenResult>

export const PairResult = z.object({ pairing: Pairing })
export type PairResult = z.infer<typeof PairResult>

export const RoundsResult = z.object({ rounds: z.array(RoundSummary) })
export type RoundsResult = z.infer<typeof RoundsResult>

/** Running `show` claims the round. Captured page data stays under its own untrusted key. */
export const ShowResult = z.object({
  round: Round.pick({ id: true, pageId: true }).extend({ stage: RoundStage, url: HttpUrl }),
  notes: z.array(
    z.object({
      authored: Note.pick({
        id: true,
        author: true,
        intent: true,
        body: true,
        target: true,
        anchorStatus: true,
        resolution: true,
      }),
      untrustedCapture: Capture.nullable(),
    }),
  ),
})
export type ShowResult = z.infer<typeof ShowResult>

export const DoneResult = z.object({
  roundId: RoundId,
  noteId: NoteId,
  resolution: ClosedResolution,
})
export type DoneResult = z.infer<typeof DoneResult>

export const AgentNoteResult = z.object({ note: Note, anchorStatus: AnchorStatus })
export type AgentNoteResult = z.infer<typeof AgentNoteResult>

export const ServiceStatus = z.object({
  state: z.enum(["starting", "ready", "draining"]),
  version: z.string().min(1),
  build: z.string().min(1),
  protocolVersion: ProtocolVersion,
  schemaVersion: z.number().int().nonnegative(),
  machineId: MachineId,
  machineName: z.string().min(1),
  pid: z.number().int().positive(),
  home: z.string().startsWith("/"),
  pool: z.array(Port),
  overlay: z.enum(["present", "missing"]),
  /** The pairing the caller resolved to, or null when none resolved. */
  owner: Pairing.nullable(),
})
export type ServiceStatus = z.infer<typeof ServiceStatus>

export const VersionReport = z.object({
  version: z.string().min(1),
  protocolVersion: ProtocolVersion,
})
export type VersionReport = z.infer<typeof VersionReport>

type CliFlag = {
  name: string
  /** A list names the only values the flag accepts. */
  value: "text" | "integer" | readonly string[]
  repeatable: boolean
  required: boolean
}

type CliCommandSpec = {
  summary: string
  positionals: readonly string[]
  flags: readonly CliFlag[]
  /** What `--json` prints, or null when the command prints no JSON. */
  output: z.ZodType | null
  owner: string
}

const ownerFlag = { name: "owner", value: "text", repeatable: false, required: false } as const
const pidFlag = { name: "pid", value: "integer", repeatable: false, required: true } as const
const labelFlag = { name: "label", value: "text", repeatable: false, required: true } as const

const AGENT_OWNER = "--owner, else the nearest ancestor process registered as a paired owner"
const HOOK_OWNER = "the process named by --pid, identified by its pid and start time"

/**
 * Every command and hook subcommand. Every command accepts `--json`, so it is not listed per
 * command; the root `--version` prints `iter8 <version>` and exits 0.
 */
export const CLI_SURFACE = {
  open: {
    summary: "Open a dev server URL or an HTML folder behind its own *.localhost page",
    positionals: ["TARGET"],
    flags: [{ name: "upstream", value: "text", repeatable: true, required: false }, ownerFlag],
    output: OpenResult,
    owner: AGENT_OWNER,
  },
  connect: {
    summary: "Keep an SSH tunnel to a devbox's iter8 pool up and open its pages here",
    positionals: ["HOST"],
    flags: [],
    output: null,
    owner: "none",
  },
  attach: {
    summary: "Pair a page with the resolved owner",
    positionals: ["PAGE"],
    flags: [ownerFlag],
    output: PairResult,
    owner: AGENT_OWNER,
  },
  rounds: {
    summary: "List the rounds sent to the resolved owner",
    positionals: [],
    flags: [ownerFlag],
    output: RoundsResult,
    owner: AGENT_OWNER,
  },
  show: {
    summary: "Print a round's notes, with captured page data fenced as untrusted, and claim it",
    positionals: ["ROUND"],
    flags: [ownerFlag],
    output: ShowResult,
    owner: AGENT_OWNER,
  },
  done: {
    summary: "Mark a note done, or answered when --reply gives the text",
    positionals: ["NOTE"],
    flags: [{ name: "reply", value: "text", repeatable: false, required: false }, ownerFlag],
    output: DoneResult,
    owner: AGENT_OWNER,
  },
  note: {
    summary: "Pin an agent's note on a page; repeated --at gives one selector per shadow-root hop",
    positionals: ["PAGE"],
    flags: [
      { name: "intent", value: Intent.options, repeatable: false, required: true },
      { name: "body", value: "text", repeatable: false, required: true },
      { name: "at", value: "text", repeatable: true, required: true },
      { name: "role", value: "text", repeatable: false, required: false },
      { name: "name", value: "text", repeatable: false, required: false },
      { name: "text", value: "text", repeatable: false, required: false },
      ownerFlag,
    ],
    output: AgentNoteResult,
    owner: AGENT_OWNER,
  },
  status: {
    summary: "Report the service's state, version, pool and the resolved owner's pairing",
    positionals: [],
    flags: [ownerFlag],
    output: ServiceStatus,
    owner: AGENT_OWNER,
  },
  version: {
    summary: "Print the CLI and protocol versions",
    positionals: [],
    flags: [],
    output: VersionReport,
    owner: "none",
  },
  serve: {
    summary: "Run the service in the foreground",
    positionals: [],
    flags: [],
    output: null,
    owner: "none",
  },
  "hook start": {
    summary: "Pair the process, or relabel it when already paired; print pointer lines on stdout",
    positionals: [],
    flags: [
      pidFlag,
      labelFlag,
      { name: "source", value: HookSource.options, repeatable: false, required: true },
      { name: "agent", value: "text", repeatable: false, required: false },
    ],
    output: PairResult,
    owner: HOOK_OWNER,
  },
  "hook prompt": {
    summary: "Mark the process busy and print pointer lines for its next turn on stdout",
    positionals: [],
    flags: [pidFlag],
    output: null,
    owner: HOOK_OWNER,
  },
  "hook tool": {
    summary: "Print pointer lines for rounds sent now, for a session between tool calls",
    positionals: [],
    flags: [pidFlag],
    output: null,
    owner: HOOK_OWNER,
  },
  "hook stop": {
    summary: "Mark the process idle",
    positionals: [],
    flags: [pidFlag],
    output: null,
    owner: HOOK_OWNER,
  },
  "hook wait": {
    summary:
      "Block until a round arrives (exit 2, pointer lines on stderr), the timeout passes or a newer waiter replaces this one (exit 0)",
    positionals: [],
    flags: [
      pidFlag,
      { name: "timeout-seconds", value: "integer", repeatable: false, required: true },
    ],
    output: null,
    owner: HOOK_OWNER,
  },
  "hook end": {
    summary: "Mark clear and resume as relabel pending, and every other reason as gone",
    positionals: [],
    flags: [
      pidFlag,
      labelFlag,
      { name: "reason", value: HookEndReason.options, repeatable: false, required: true },
    ],
    output: null,
    owner: HOOK_OWNER,
  },
} as const satisfies Record<Exclude<CliCommand, "hook"> | `hook ${HookCommand}`, CliCommandSpec>
