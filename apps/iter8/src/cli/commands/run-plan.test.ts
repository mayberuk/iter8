import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { ZodError } from "zod"
import { planRun, printedPorts, stablePort } from "./run-plan"

const ROOT = "/home/dev/shop"
const PORT = 4321

function plan(overrides: Partial<Parameters<typeof planRun>[0]> = {}) {
  return planRun({
    root: ROOT,
    packageJson: null,
    lockfiles: [],
    hasHtml: false,
    command: null,
    port: PORT,
    ...overrides,
  })
}

describe("stablePort", () => {
  // FNV-1a 32-bit reference values: "" → 0x811c9dc5, "a" → 0xe40c292c, "foobar" → 0xbf9cf968.
  test.each([
    ["", 4100 + (0x811c9dc5 % 800)],
    ["a", 4100 + (0xe40c292c % 800)],
    ["foobar", 4100 + (0xbf9cf968 % 800)],
  ])("%j hashes to %d", (root, port) => {
    expect(stablePort(root)).toBe(port)
  })

  test("stablePort is deterministic and always within 4100–4899", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), (root) => {
        const port = stablePort(root)
        expect(stablePort(root)).toBe(port)
        expect(Number.isInteger(port)).toBe(true)
        expect(port).toBeGreaterThanOrEqual(4100)
        expect(port).toBeLessThanOrEqual(4899)
      }),
    )
  })
})

describe("planRun", () => {
  test.each([
    [["bun.lock"], ["bun", "run", "dev", "--port", "4321", "--strictPort"]],
    [["bun.lockb"], ["bun", "run", "dev", "--port", "4321", "--strictPort"]],
    [["pnpm-lock.yaml"], ["pnpm", "run", "dev", "--port", "4321", "--strictPort"]],
    [["yarn.lock"], ["yarn", "run", "dev", "--port", "4321", "--strictPort"]],
    [[], ["npm", "run", "dev", "--", "--port", "4321", "--strictPort"]],
    [["package-lock.json"], ["npm", "run", "dev", "--", "--port", "4321", "--strictPort"]],
    [
      ["yarn.lock", "bun.lock"],
      ["bun", "run", "dev", "--port", "4321", "--strictPort"],
    ],
  ])("lockfiles %j run the dev script as %j", (lockfiles, argv) => {
    expect(
      plan({
        lockfiles,
        packageJson: { scripts: { dev: "vite" }, devDependencies: { vite: "8.3.4" } },
      }),
    ).toEqual({ kind: "server", argv, env: { PORT: "4321" }, port: PORT, portVia: "flag" })
  })

  test.each([
    ["next", { dependencies: { next: "16.0.0" } }, ["-p", "4321"]],
    ["vite", { devDependencies: { vite: "8.3.4" } }, ["--port", "4321", "--strictPort"]],
    [
      "SvelteKit",
      { devDependencies: { "@sveltejs/kit": "3.0.0", vite: "8.3.4" } },
      ["--port", "4321", "--strictPort"],
    ],
    [
      "SvelteKit without vite listed",
      { devDependencies: { "@sveltejs/kit": "3.0.0" } },
      ["--port", "4321", "--strictPort"],
    ],
    ["Astro", { dependencies: { astro: "7.0.0" } }, ["--port", "4321"]],
    [
      "Astro with vite listed",
      { dependencies: { astro: "7.0.0", vite: "8.3.4" } },
      ["--port", "4321"],
    ],
    [
      "Vue on vite",
      { dependencies: { vue: "3.6.0" }, devDependencies: { vite: "8.3.4" } },
      ["--port", "4321", "--strictPort"],
    ],
    [
      "Next and vite both listed",
      { dependencies: { next: "16.0.0", vite: "8.3.4" } },
      ["-p", "4321"],
    ],
  ])("%s gets its port flags and PORT", (_, deps, flags) => {
    expect(
      plan({ lockfiles: ["bun.lock"], packageJson: { scripts: { dev: "x" }, ...deps } }),
    ).toEqual({
      kind: "server",
      argv: ["bun", "run", "dev", ...flags],
      env: { PORT: "4321" },
      port: PORT,
      portVia: "flag",
    })
  })

  test.each([
    ["no dependencies", {}],
    ["an unknown framework", { dependencies: { express: "5.0.0" } }],
    [
      "vue-cli, even with vite listed",
      { devDependencies: { "@vue/cli-service": "5.0.0", vite: "8.3.4" } },
    ],
  ])("%s passes the port only through PORT", (_, deps) => {
    for (const [lockfiles, pm] of [
      [["bun.lock"], "bun"],
      [[], "npm"],
    ] as const) {
      expect(
        plan({ lockfiles: [...lockfiles], packageJson: { scripts: { dev: "x" }, ...deps } }),
      ).toEqual({
        kind: "server",
        argv: [pm, "run", "dev"],
        env: { PORT: "4321" },
        port: PORT,
        portVia: "env",
      })
    }
  })

  test("start runs when there is no dev script, and an empty dev script counts as none", () => {
    for (const scripts of [{ start: "node server.js" }, { dev: "", start: "node server.js" }]) {
      expect(plan({ lockfiles: ["pnpm-lock.yaml"], packageJson: { scripts } })).toMatchObject({
        kind: "server",
        argv: ["pnpm", "run", "start"],
      })
    }
  })

  test("dev wins over start", () => {
    expect(
      plan({ lockfiles: ["yarn.lock"], packageJson: { scripts: { start: "a", dev: "b" } } }),
    ).toMatchObject({ argv: ["yarn", "run", "dev"] })
  })

  test("a script runs even when the directory also has HTML", () => {
    expect(plan({ hasHtml: true, packageJson: { scripts: { dev: "x" } } })).toMatchObject({
      kind: "server",
    })
  })

  test("an override command runs as given with PORT, ignoring package.json and HTML", () => {
    expect(
      plan({
        command: ["python3", "-m", "http.server"],
        hasHtml: true,
        lockfiles: ["bun.lock"],
        packageJson: { scripts: { dev: "vite" }, devDependencies: { vite: "8.3.4" } },
      }),
    ).toEqual({
      kind: "server",
      argv: ["python3", "-m", "http.server"],
      env: { PORT: "4321" },
      port: PORT,
      portVia: "env",
    })
  })

  test("an empty override command falls back to detection", () => {
    expect(plan({ command: [], hasHtml: true })).toEqual({ kind: "folder", root: ROOT })
  })

  test.each([
    ["no package.json", null],
    ["no scripts", { dependencies: { vite: "8.3.4" } }],
    ["only other scripts", { scripts: { build: "vite build", test: "vitest" } }],
  ])("%s with HTML opens the folder", (_, packageJson) => {
    expect(plan({ packageJson, hasHtml: true })).toEqual({ kind: "folder", root: ROOT })
  })

  test("nothing runnable says what is missing and how to run a command", () => {
    expect(plan({ packageJson: { scripts: { build: "tsc" } } })).toEqual({
      kind: "nothing",
      reason:
        "Nothing to run in /home/dev/shop: no dev or start script in package.json and no HTML files. Use iter8 run -- <command>.",
    })
  })

  test.each([
    ["scripts as an array", { scripts: ["dev"] }],
    ["a non-string script", { scripts: { dev: 5 } }],
    ["not an object", "vite"],
  ])("a package.json with %s is refused", (_, packageJson) => {
    expect(() => plan({ packageJson })).toThrow(ZodError)
  })
})

describe("printedPorts", () => {
  test.each([
    [
      "vite's coloured Local line",
      "  \u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m",
      [5173],
    ],
    ["Next's Local line", "   - Local:        http://localhost:3000", [3000]],
    ["an IPv4 loopback URL", "listening on http://127.0.0.1:8080/app", [8080]],
    ["an IPv6 loopback URL", "listening on http://[::1]:8081/", [8081]],
    ["the unspecified address, which is loopback here", "ready http://0.0.0.0:3001", [3001]],
    ["several URLs on one line", "http://localhost:1111/ and http://127.0.0.1:2222/", [1111, 2222]],
  ])("reads %s", (_, line, ports) => {
    expect(printedPorts(line)).toEqual(ports)
  })

  test.each([
    ["a LAN address", "  ➜  Network: http://192.168.1.20:5173/"],
    ["a public host", "http://example.com:3000/"],
    ["a host that only ends in localhost", "http://app.localhost:3000/"],
    ["a host that only starts with localhost", "http://localhost.example.com:3000/"],
    ["a URL without a port", "Local: http://localhost/"],
    ["a bare host and port", "localhost:3000"],
    ["https", "https://localhost:3000/"],
    ["a port above 65535", "http://localhost:70000/"],
    ["port 0", "http://localhost:0/"],
    ["no URL", "ready in 312 ms"],
  ])("ignores %s", (_, line) => {
    expect(printedPorts(line)).toEqual([])
  })
})
