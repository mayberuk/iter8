import { z } from "zod"

/** Read from under `ITER8_HOME`. */
export const CONFIG_FILE = "config.json"

/** `first-last`, both valid ports, first not above last. */
export const PortRange = z
  .string()
  .regex(/^[0-9]{1,5}-[0-9]{1,5}$/)
  .refine((range) => {
    const [first, last] = range.split("-").map(Number)
    return first !== undefined && last !== undefined && first >= 1 && last <= 65535 && first <= last
  })
export type PortRange = z.infer<typeof PortRange>

export const ServiceConfig = z.object({ pool: PortRange })
export type ServiceConfig = z.infer<typeof ServiceConfig>

/** The macOS range keeps a laptop's own service off the ports an SSH forward from the remote machine uses. */
export const DEFAULT_POOL = {
  linux: "3990-3993",
  darwin: "3980-3983",
} as const satisfies Record<"linux" | "darwin", PortRange>
