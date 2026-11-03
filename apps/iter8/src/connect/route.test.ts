import { expect, test } from "bun:test"
import { pickRoute, resolvedHostname, TAILSCALE_MAC_APP } from "./route"

const peer = {
  ID: "node-devhost",
  PublicKey: "nodekey:devhost",
  HostName: "DevHost",
  DNSName: "devhost.tail1234.ts.net.",
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
  Peer: { "nodekey:devhost": peer },
  CurrentTailnet: { Name: "example", MagicDNSSuffix: "tail1234.ts.net", MagicDNSEnabled: true },
  Health: [],
}

test.each([
  ["user ada\nhostname devhost\nport 22\n", "devhost"],
  ["hostname devhost.tail1234.ts.net.\r\n", "devhost.tail1234.ts.net."],
  ["  hostname\t100.80.90.10  \n", "100.80.90.10"],
  ["HostName DEVHOST\n", "DEVHOST"],
  ["canonicalizehostname false\nproxycommand hostname devhost\n", null],
  ["hostname\n", null],
  ["hostname devhost other\n", null],
  ["", null],
] as const)("resolvedHostname(%j) is %j", (output, expected) => {
  expect(resolvedHostname(output)).toBe(expected)
})

test.each([
  ["devhost", null],
  ["DEVHOST.", null],
  ["devhost.tail1234.ts.net", null],
  ["DEVHOST.TAIL1234.TS.NET.", null],
  ["100.80.90.10", null],
  ["100.80.90.11", null],
  ["FD7A:115C:A1E0::10", null],
  ["work", "DevHost."],
  ["work", "DEVHOST.TAIL1234.TS.NET"],
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
  expect(
    pickRoute("devhost", null, { ...running, Peer: { "nodekey:devhost": candidate } }),
  ).toEqual(expected)
})

test("the first DNS label matches independently of HostName", () => {
  expect(
    pickRoute("devhost", null, {
      ...running,
      Peer: { "nodekey:devhost": { ...peer, HostName: "some-other-name" } },
    }),
  ).toEqual({ kind: "tailscale", address: "100.80.90.10" })
})

test.each([
  "dev",
  "devhost.tail1234",
  "evildevhost",
  "devhost.tail1234.ts.net.evil",
  "laptop",
  "nodekey:devhost",
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
  { ...running, Peer: { "nodekey:devhost": { ...peer, Online: "true" } } },
  { ...running, Peer: { "nodekey:devhost": { ...peer, TailscaleIPs: [100] } } },
  { ...running, Peer: { "nodekey:devhost": { HostName: "devhost" } } },
])("invalid, inactive or peerless status %j falls back to SSH", (status) => {
  expect(pickRoute("devhost", null, status)).toEqual({ kind: "ssh" })
})

test("an offline match does not hide another online match", () => {
  expect(
    pickRoute("devhost", null, {
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
