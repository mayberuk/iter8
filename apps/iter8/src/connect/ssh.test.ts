import { expect, test } from "bun:test"
import fc from "fast-check"
import type { Route } from "./route"
import {
  assertHost,
  classifyFailure,
  configArgs,
  type Forward,
  remoteCommandArgs,
  SSH_OPTIONS,
  type SshFailure,
  tunnelArgs,
} from "./ssh"

const options = [
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
const command = ["iter8", "status", "--json"] as const
const ssh: Route = { kind: "ssh" }
const tailscale: Route = { kind: "tailscale", address: "100.80.90.10" }
const forward: Forward = {
  ports: [3990, 3991],
  bindAddress: null,
  remoteSocket: null,
  localSocket: null,
}

test("SSH options keep reconnects non-interactive and forwards owned by this child", () => {
  expect(SSH_OPTIONS).toEqual(options)
})

test.each([
  "devbox",
  "biruk@devbox",
  "100.80.90.10",
  "fd7a:115c:a1e0::10",
  "dev-box.",
  "dev;box",
  "$(hostname)",
  "BatchMode=yes",
])("assertHost accepts %j unchanged", (host) => {
  expect(assertHost(host)).toBe(host)
})

test.each([
  "",
  "-devbox",
  "-oProxyCommand=evil",
  "dev box",
  " devbox",
  "devbox ",
  "dev\tbox",
  "dev\nbox",
  "dev\rbox",
  "dev\u0000box",
  "dev\u001bbox",
  "dev\u007fbox",
  "dev\u0085box",
  "dev\u00a0box",
  "dev\u2028box",
])("assertHost refuses %j with usage exit code", (host) => {
  expect(() => assertHost(host)).toThrow()
  try {
    assertHost(host)
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).cause).toBe(64)
  }
})

test("ssh config resolution keeps the host after the option terminator", () => {
  expect(configArgs("work")).toEqual(["-G", "--", "work"])
})

test.each([
  [ssh, [...options, "--", "work", "iter8", "status", "--json"]],
  [
    tailscale,
    [...options, "-o", "HostName=100.80.90.10", "--", "work", "iter8", "status", "--json"],
  ],
] satisfies [Route, string[]][])(
  "remote command over %j preserves the SSH alias",
  (route, expected) => {
    expect(remoteCommandArgs("work", route, command)).toEqual(expected)
  },
)

test.each([
  [
    ssh,
    forward,
    ["-N", ...options, "-L", "3990:127.0.0.1:3990", "-L", "3991:127.0.0.1:3991", "--", "work"],
  ],
  [
    tailscale,
    {
      ...forward,
      bindAddress: "127.0.0.2",
      remoteSocket: "/home/biruk/.iter8/laptop-mac-ab12cd34.sock",
      localSocket: "/Users/biruk/.iter8/connect-123.sock",
    },
    [
      "-N",
      ...options,
      "-o",
      "HostName=100.80.90.10",
      "-L",
      "127.0.0.2:3990:127.0.0.1:3990",
      "-L",
      "127.0.0.2:3991:127.0.0.1:3991",
      "-R",
      "/home/biruk/.iter8/laptop-mac-ab12cd34.sock:/Users/biruk/.iter8/connect-123.sock",
      "--",
      "work",
    ],
  ],
  [
    ssh,
    { ...forward, ports: [], remoteSocket: "/remote.sock", localSocket: "/local.sock" },
    ["-N", ...options, "-R", "/remote.sock:/local.sock", "--", "work"],
  ],
  [ssh, { ...forward, ports: [], remoteSocket: "/remote.sock" }, ["-N", ...options, "--", "work"]],
  [ssh, { ...forward, ports: [], localSocket: "/local.sock" }, ["-N", ...options, "--", "work"]],
] satisfies [Route, Forward, string[]][])(
  "tunnel over %j with %j has the specified forwards",
  (route, forwards, expected) => {
    expect(tunnelArgs("work", route, forwards)).toEqual(expected)
  },
)

test("every argv builder refuses invalid hosts", () => {
  for (const host of ["", "-oProxyCommand=evil", "dev box", "dev\u0000box"]) {
    expect(() => configArgs(host)).toThrow()
    expect(() => remoteCommandArgs(host, tailscale, command)).toThrow()
    expect(() => tunnelArgs(host, ssh, forward)).toThrow()
  }
})

const acceptedHost = fc
  .oneof(
    fc.string({ unit: "binary" }),
    fc.constantFrom("BatchMode=yes", "HostName=100.80.90.10", "3990:127.0.0.1:3990", "iter8"),
  )
  .filter((input) => {
    try {
      assertHost(input)
      return true
    } catch {
      return false
    }
  })

const socketForward: Forward = {
  ports: [3990],
  bindAddress: "127.0.0.2",
  remoteSocket: "/remote.sock",
  localSocket: "/local.sock",
}

function argvsFor(host: string, route: Route): string[][] {
  return [
    remoteCommandArgs(host, route, command),
    tunnelArgs(host, route, forward),
    tunnelArgs(host, route, socketForward),
  ]
}

test("the host never shapes an option: one -- right before it, and a prefix independent of it", () => {
  fc.assert(
    fc.property(acceptedHost, acceptedHost, (first, second) => {
      for (const route of [ssh, tailscale]) {
        const firstArgvs = argvsFor(first, route)
        const secondArgvs = argvsFor(second, route)
        firstArgvs.forEach((args, index) => {
          const separators = args.filter((arg) => arg === "--")
          const separator = args.indexOf("--")
          expect(separators).toHaveLength(1)
          expect(args[separator + 1]).toBe(first)
          const other = secondArgvs[index] as string[]
          expect(other.slice(0, other.indexOf("--"))).toEqual(args.slice(0, separator))
        })
      }
    }),
  )
})

test.each([
  [
    255,
    "channel_setup_fwd_listener_tcpip: cannot listen to port: 3990\nCould not request local forwarding.\n",
    { kind: "port-taken", port: 3990 },
  ],
  [255, "bind [127.0.0.1]:3991: Address already in use\n", { kind: "port-taken", port: 3991 }],
  [255, "bind [::1]:3992: Address already in use\n", { kind: "port-taken", port: 3992 }],
  [255, "biruk@devbox: Permission denied (publickey,password).\n", { kind: "auth" }],
  [255, "Host key verification failed.\n", { kind: "host-key" }],
  [255, "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\n", { kind: "host-key" }],
  [
    255,
    "Error: remote port forwarding failed for listen path /home/biruk/.iter8/laptop-mac-ab12cd34.sock\n",
    { kind: "socket-forward-refused" },
  ],
  [127, "sh: iter8: command not found\n", { kind: "no-iter8" }],
  [5, "iter8 service is unavailable\n", { kind: "service-down" }],
  [
    255,
    "warning: old message\nssh: connect to host devbox port 22: Connection timed out\n\n",
    { kind: "transient", detail: "ssh: connect to host devbox port 22: Connection timed out" },
  ],
  [
    null,
    "first\r\n  Connection reset by peer  \r\n \r\n",
    { kind: "transient", detail: "Connection reset by peer" },
  ],
  [1, "", { kind: "transient", detail: "" }],
  [null, " \n\t\n", { kind: "transient", detail: "" }],
  [127, "Permission denied (publickey).\n", { kind: "auth" }],
  [5, "Host key verification failed.\n", { kind: "host-key" }],
  [255, "bind [127.0.0.1]:3993: Permission denied\n", { kind: "auth" }],
] satisfies [number | null, string, SshFailure][])(
  "exit %j with %j is %j",
  (exitCode, stderr, expected) => {
    expect(classifyFailure(exitCode, stderr)).toEqual(expected)
  },
)
