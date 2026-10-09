import { z } from "zod"

/** A change to a field's meaning or requirement bumps the protocol version. */
export const PROTOCOL_VERSION = 1 as const

/** Any version, not only this one: a peer must read a mismatched version to refuse it by name. */
export const ProtocolVersion = z.number().int().positive()
export type ProtocolVersion = z.infer<typeof ProtocolVersion>
