import { z } from "zod"
import { ChatSetting, ConversationMessage, MessageText } from "./conversation"
import { MessageId, OwnerId } from "./ids"
import { Ok } from "./overlay-api"
import { Page } from "./page"
import { LiveSession, ProcessIdentity } from "./pairing"
import { RoundPointer } from "./pointer"
import { Round } from "./round"

/** A mod's fetch gives up at 30 s, so the service must finish its wait earlier. */
export const AGENT_WAIT_MAX_SECONDS = 25

export const AgentWaitQuery = z.object({
  owner: OwnerId,
  timeoutSeconds: z.string().regex(/^(?:[1-9]|1[0-9]|2[0-5])$/),
})
export type AgentWaitQuery = z.infer<typeof AgentWaitQuery>

export const AgentDelivery = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("round"), pointer: RoundPointer, text: z.string().min(1) }),
  z.object({
    kind: z.literal("page-message"),
    messageId: MessageId,
    pageId: ConversationMessage.shape.pageId,
    text: z.string().min(1),
  }),
])
export type AgentDelivery = z.infer<typeof AgentDelivery>

export const AgentWaitResult = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("deliver"), deliveries: z.array(AgentDelivery).min(1) }),
  z.object({ outcome: z.literal("timeout") }),
  z.object({ outcome: z.literal("replaced") }),
  z.object({ outcome: z.literal("cancelled") }),
])
export type AgentWaitResult = z.infer<typeof AgentWaitResult>

export const AgentStateQuery = AgentWaitQuery.pick({ owner: true })
export type AgentStateQuery = z.infer<typeof AgentStateQuery>

export const AgentState = z.object({
  session: LiveSession,
  focus: ConversationMessage.pick({ pageId: true, roundId: true }).nullable(),
  pages: z.array(z.object({ pageId: Page.shape.id, origin: Page.shape.origin, chat: ChatSetting })),
  rounds: z.array(Round),
})
export type AgentState = z.infer<typeof AgentState>

export const TranscriptRow = z.object({
  key: z.string().min(1).max(200),
  role: z.enum(["assistant", "user"]),
  text: MessageText,
  at: ConversationMessage.shape.at,
})
export type TranscriptRow = z.infer<typeof TranscriptRow>

export const TranscriptRequest = z.object({
  owner: OwnerId,
  rows: z.array(TranscriptRow).min(1).max(50),
})
export type TranscriptRequest = z.infer<typeof TranscriptRequest>

export const TranscriptResult = z.object({
  pageId: ConversationMessage.shape.pageId.nullable(),
  stored: z.array(MessageId),
})
export type TranscriptResult = z.infer<typeof TranscriptResult>

export const TurnRequest = z.object({ owner: OwnerId, state: z.enum(["busy", "idle"]) })
export type TurnRequest = z.infer<typeof TurnRequest>

export const HookToolRequest = ProcessIdentity.pick({ pid: true })
export type HookToolRequest = z.infer<typeof HookToolRequest>

export const HookPointers = z.object({ pointers: z.array(RoundPointer) })
export type HookPointers = z.infer<typeof HookPointers>

type Route = {
  method: "GET" | "POST"
  path: string
  request: z.ZodType
  response: z.ZodType
}

/** Control-socket routes; on a GET, request describes query parameters rather than a JSON body. */
export const AGENT_ROUTES = {
  wait: { method: "GET", path: "/agent/wait", request: AgentWaitQuery, response: AgentWaitResult },
  state: { method: "GET", path: "/agent/state", request: AgentStateQuery, response: AgentState },
  transcript: {
    method: "POST",
    path: "/agent/transcript",
    request: TranscriptRequest,
    response: TranscriptResult,
  },
  turn: { method: "POST", path: "/agent/turn", request: TurnRequest, response: Ok },
  hookTool: {
    method: "POST",
    path: "/hook/tool",
    request: HookToolRequest,
    response: HookPointers,
  },
} as const satisfies Record<string, Route>
