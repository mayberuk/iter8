import { z } from "zod"
import { OwnerId, PageId, PairingGeneration } from "./ids"

export const Port = z.number().int().min(1).max(65535)
export type Port = z.infer<typeof Port>

export const HttpUrl = z.url({ protocol: /^https?$/ })
export type HttpUrl = z.infer<typeof HttpUrl>

export const Page = z.object({
  id: PageId,
  origin: z.url({ protocol: /^http$/, hostname: /\.localhost$/ }),
  target: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("server"),
      upstream: HttpUrl,
      extraUpstreams: z.array(z.object({ upstream: HttpUrl, port: Port })),
    }),
    z.object({ kind: z.literal("folder"), root: z.string().startsWith("/") }),
  ]),
  pairing: z.object({ owner: OwnerId, generation: PairingGeneration }).nullable(),
})
export type Page = z.infer<typeof Page>
