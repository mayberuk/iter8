import { z } from "zod"
import { MachineId, PageId, PageToken } from "./ids"
import { OVERLAY_PREFIX, OVERLAY_SCRIPT_PATH, SOURCE_BUNDLE_PATH } from "./overlay-api"
import { ProtocolVersion } from "./version"

export const OverlayBoot = z.object({
  protocolVersion: ProtocolVersion,
  pageId: PageId,
  machineId: MachineId,
  /** The service host's name, shown as where the session lives. */
  machineName: z.string().min(1),
  token: PageToken,
  apiBase: z.literal(OVERLAY_PREFIX),
  sourceBundleUrl: z.literal(SOURCE_BUNDLE_PATH),
})
export type OverlayBoot = z.infer<typeof OverlayBoot>

/**
 * The body of the `<script type="module">` the proxy injects; the caller wraps it, so it can hash
 * the exact text for the page's CSP. Every `<` in the JSON is escaped, so no value can close the
 * script element.
 */
export function renderBootScript(boot: OverlayBoot): string {
  const json = JSON.stringify(boot).replaceAll("<", "\\u003c")
  return `import { mount } from ${JSON.stringify(OVERLAY_SCRIPT_PATH)}\nmount(${json})\n`
}
