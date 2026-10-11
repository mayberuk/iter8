import { isIP } from "node:net"
import { z } from "zod"

export type Route = { kind: "tailscale"; address: string } | { kind: "ssh" }

export const TAILSCALE_MAC_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"

const TailscaleStatus = z.object({
  BackendState: z.string(),
  Peer: z
    .record(
      z.string(),
      z.object({
        HostName: z.string(),
        DNSName: z.string(),
        TailscaleIPs: z.array(z.string()),
        Online: z.boolean(),
      }),
    )
    .nullable()
    .optional(),
})

export function resolvedHostname(sshConfigOutput: string): string | null {
  for (const line of sshConfigOutput.split(/\r?\n/)) {
    const match = /^hostname[ \t]+(\S+)$/i.exec(line.trim())
    if (match?.[1] !== undefined) return match[1]
  }
  return null
}

function normalizedName(name: string): string {
  return name.toLowerCase().replace(/\.$/, "")
}

export function pickRoute(
  host: string,
  resolvedHost: string | null,
  tailscaleStatus: unknown,
): Route {
  const status = TailscaleStatus.safeParse(tailscaleStatus)
  if (!status.success || status.data.BackendState !== "Running") return { kind: "ssh" }

  const targets = [host, ...(resolvedHost === null ? [] : [resolvedHost])].map(normalizedName)
  for (const peer of Object.values(status.data.Peer ?? {})) {
    if (!peer.Online) continue
    const names = [
      peer.HostName,
      peer.DNSName,
      peer.DNSName.split(".")[0] ?? "",
      ...peer.TailscaleIPs,
    ].map(normalizedName)
    if (!targets.some((target) => names.includes(target))) continue

    const address = peer.TailscaleIPs.find((ip) => isIP(ip) === 4) ?? peer.TailscaleIPs[0]
    if (address !== undefined) return { kind: "tailscale", address }
  }
  return { kind: "ssh" }
}
