import { ExitCode } from "@iter8/protocol"
import type { Route } from "./route"

export const SSH_OPTIONS: readonly string[] = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ExitOnForwardFailure=yes",
  "-o",
  "ServerAliveInterval=10",
  "-o",
  "ServerAliveCountMax=3",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ControlPath=none",
]

/**
 * Where the devbox's iter8 is tried, in order. A non-interactive ssh shell's PATH leaves out
 * ~/.local/bin, and ssh resolves a relative command against the login directory.
 */
export const REMOTE_ITER8 = ["iter8", ".local/bin/iter8"] as const

export type Forward = {
  ports: number[]
  bindAddress: string | null
  remoteSocket: string | null
  localSocket: string | null
}

export function assertHost(host: string): string {
  if (host === "" || host.startsWith("-") || /[\s\p{Cc}]/u.test(host)) {
    throw new Error(
      "SSH host must be non-empty, not start with '-', and contain no whitespace or control characters",
      {
        cause: ExitCode.usage,
      },
    )
  }
  return host
}

export function configArgs(host: string): string[] {
  return ["-G", "--", assertHost(host)]
}

export function remoteCommandArgs(
  host: string,
  route: Route,
  command: readonly string[],
): string[] {
  assertHost(host)
  return [
    ...SSH_OPTIONS,
    ...(route.kind === "tailscale" ? ["-o", `HostName=${route.address}`] : []),
    "--",
    host,
    ...command,
  ]
}

export function tunnelArgs(host: string, route: Route, forward: Forward): string[] {
  assertHost(host)
  const args = [
    "-N",
    ...SSH_OPTIONS,
    ...(route.kind === "tailscale" ? ["-o", `HostName=${route.address}`] : []),
  ]
  for (const port of forward.ports) {
    const bind = forward.bindAddress === null ? "" : `${forward.bindAddress}:`
    args.push("-L", `${bind}${port}:127.0.0.1:${port}`)
  }
  if (forward.remoteSocket !== null && forward.localSocket !== null) {
    args.push("-R", `${forward.remoteSocket}:${forward.localSocket}`)
  }
  args.push("--", host)
  return args
}

export type SshFailure =
  | { kind: "port-taken"; port: number }
  | { kind: "auth" }
  | { kind: "host-key" }
  | { kind: "socket-forward-refused" }
  | { kind: "no-iter8" }
  | { kind: "service-down" }
  | { kind: "transient"; detail: string }

export function classifyFailure(exitCode: number | null, stderr: string): SshFailure {
  const bind = /cannot listen to port: (\d+)|bind [^\r\n]*:(\d+): Address already in use/.exec(
    stderr,
  )
  const port = bind?.[1] ?? bind?.[2]
  if (port !== undefined) return { kind: "port-taken", port: Number(port) }
  if (stderr.includes("Permission denied")) return { kind: "auth" }
  if (
    stderr.includes("Host key verification failed") ||
    stderr.includes("REMOTE HOST IDENTIFICATION HAS CHANGED")
  ) {
    return { kind: "host-key" }
  }
  if (stderr.includes("remote port forwarding failed for listen path")) {
    return { kind: "socket-forward-refused" }
  }
  if (exitCode === 127) return { kind: "no-iter8" }
  if (exitCode === ExitCode.serviceUnavailable) return { kind: "service-down" }
  const detail =
    stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? ""
  return { kind: "transient", detail }
}
