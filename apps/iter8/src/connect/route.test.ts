import { expect, test } from "bun:test"
import { pickRoute, resolvedHostname, TAILSCALE_MAC_APP } from "./route"

const peer = {
  ID: "node-devbox",
  PublicKey: "nodekey:devbox",
  HostName: "DevBox",
  DNSName: "devbox.tail1234.ts.net.",
  OS: "linux",
  TailscaleIPs: ["fd7a:115c:a1e0::10", "100.80.90.10", "100.80.90.11"],
  Online: true,
  Active: false,
  ExitNode: false,
}

const running = {
  Version: "1.90.0",
  BackendState: "Running",
  HaveNodeKey: true,
  Self: {
    ID: "node-laptop",
    PublicKey: "nodekey:laptop",
    HostName: "laptop",
    DNSName: "laptop.tail1234.ts.net.",
    TailscaleIPs: ["100.80.90.20", "fd7a:115c:a1e0::20"],
    Online: true,
  },
  Peer: { "nodekey:devbox": peer },
  CurrentTailnet: { Name: "example", MagicDNSSuffix: "tail1234.ts.net", MagicDNSEnabled: true },
  Health: [],
}

test.each([
  ["user biruk\nhostname devbox\nport 22\n", "devbox"],
  ["hostname devbox.tail1234.ts.net.\r\n", "devbox.tail1234.ts.net."],
  ["  hostname\t100.80.90.10  \n", "100.80.90.10"],
  ["HostName DEVBOX\n", "DEVBOX"],
  ["canonicalizehostname false\nproxycommand hostname devbox\n", null],
  ["hostname\n", null],
  ["hostname devbox other\n", null],
  ["", null],
] as const)("resolvedHostname(%j) is %j", (output, expected) => {
  expect(resolvedHostname(output)).toBe(expected)
})

test.each([
  ["devbox", null],
  ["DEVBOX.", null],
  ["devbox.tail1234.ts.net", null],
  ["DEVBOX.TAIL1234.TS.NET.", null],
  ["100.80.90.10", null],
  ["100.80.90.11", null],
  ["FD7A:115C:A1E0::10", null],
  ["work", "DevBox."],
  ["work", "DEVBOX.TAIL1234.TS.NET"],
  ["work", "100.80.90.11"],
  ["work", "FD7A:115C:A1E0::10"],
] as const)("%s resolved to %s uses the matching peer's first IPv4", (host, resolved) => {
  expect(pickRoute(host, resolved, running)).toEqual({ kind: "tailscale", address: "100.80.90.10" })
})

test.each([
  [
    "only IPv6",
    { ...peer, TailscaleIPs: ["fd7a:115c:a1e0::10", "fd7a:115c:a1e0::11"] },
    { kind: "tailscale", address: "fd7a:115c:a1e0::10" },
  ],
  ["no addresses", { ...peer, TailscaleIPs: [] }, { kind: "ssh" }],
  ["offline", { ...peer, Online: false }, { kind: "ssh" }],
] as const)("a matching peer with %s", (_name, candidate, expected) => {
  expect(pickRoute("devbox", null, { ...running, Peer: { "nodekey:devbox": candidate } })).toEqual(
    expected,
  )
})

test("the first DNS label matches independently of HostName", () => {
  expect(
    pickRoute("devbox", null, {
      ...running,
      Peer: { "nodekey:devbox": { ...peer, HostName: "some-other-name" } },
    }),
  ).toEqual({ kind: "tailscale", address: "100.80.90.10" })
})

test.each([
  "dev",
  "devbox.tail1234",
  "evildevbox",
  "devbox.tail1234.ts.net.evil",
  "laptop",
  "nodekey:devbox",
])("%s does not match a peer exactly", (host) => {
  expect(pickRoute(host, null, running)).toEqual({ kind: "ssh" })
})

test.each([
  null,
  undefined,
  "invalid JSON",
  {},
  { ...running, BackendState: "Stopped" },
  { ...running, BackendState: "NeedsLogin" },
  { ...running, BackendState: "running" },
  { ...running, Peer: null },
  { BackendState: "Running" },
  { ...running, Peer: {} },
  { ...running, Peer: [] },
  { ...running, Peer: { "nodekey:devbox": { ...peer, Online: "true" } } },
  { ...running, Peer: { "nodekey:devbox": { ...peer, TailscaleIPs: [100] } } },
  { ...running, Peer: { "nodekey:devbox": { HostName: "devbox" } } },
])("invalid, inactive or peerless status %j falls back to SSH", (status) => {
  expect(pickRoute("devbox", null, status)).toEqual({ kind: "ssh" })
})

test("an offline match does not hide another online match", () => {
  expect(
    pickRoute("devbox", null, {
      ...running,
      Peer: {
        "nodekey:old": { ...peer, Online: false },
        "nodekey:new": { ...peer, TailscaleIPs: ["100.80.90.30"] },
      },
    }),
  ).toEqual({ kind: "tailscale", address: "100.80.90.30" })
})

test("the macOS app fallback names the installed Tailscale executable", () => {
  expect(TAILSCALE_MAC_APP).toBe("/Applications/Tailscale.app/Contents/MacOS/Tailscale")
})
