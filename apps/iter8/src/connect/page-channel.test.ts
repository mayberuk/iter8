import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { chmod, lstat, mkdtemp, rename, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import {
  acceptablePage,
  announceToLaptops,
  LaptopOpen,
  laptopSocketName,
  listenForPages,
} from "./page-channel"

const message = LaptopOpen.parse({
  machineId: "devbox-id",
  url: "http://larkspur.localhost:3990/notes?round=1#pin",
})
const expected = { machineId: "devbox-id", ports: [3990, 3991] }

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "i8-"))
  try {
    await run(home)
  } finally {
    await rm(home, { recursive: true })
  }
}

function send(socketPath: string, body: string, path = "/open", method = "POST") {
  return fetch(`http://iter8${path}`, {
    unix: socketPath,
    method,
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(1000),
  })
}

const liveNames = ["a1", "a2", "z1", "z2"]
const badName = "m-bad"
const creationOrders = [
  [...liveNames.slice(0, 2), badName, ...liveNames.slice(2)],
  [...liveNames.slice(2).reverse(), badName, ...liveNames.slice(0, 2).reverse()],
]

function socketIn(home: string, name: string): string {
  return join(home, `laptop-${name}-01234567.sock`)
}

describe("LaptopOpen", () => {
  test("uses protocol identity and HTTP URL validation and drops unknown keys", () => {
    expect(LaptopOpen.parse({ ...message, extra: "ignored" })).toEqual(message)
    for (const body of [
      null,
      {},
      { ...message, machineId: "" },
      { ...message, url: "file:///x" },
    ]) {
      expect(LaptopOpen.safeParse(body).success).toBe(false)
    }
  })
})

describe("laptopSocketName", () => {
  test("normalizes the laptop name while retaining its nonce", () => {
    expect(laptopSocketName("Ada's Mac_1", "a1b2c3d4")).toBe("laptop-ada-s-mac-1-a1b2c3d4.sock")
    expect(laptopSocketName("A/B.C ", "01234567")).toBe("laptop-a-b-c--01234567.sock")
    expect(laptopSocketName("A".repeat(40), "01234567")).toBe(
      "laptop-aaaaaaaaaaaaaaaaaaaaaaaa-01234567.sock",
    )
    expect(laptopSocketName("", "01234567")).toBe("laptop--01234567.sock")
  })
})

describe("acceptablePage", () => {
  test("accepts only the expected machine and forwarded local page", () => {
    expect(acceptablePage(message, expected)).toBe(true)
    expect(
      acceptablePage({ ...message, url: "http://another-page.localhost:3991" }, expected),
    ).toBe(true)
    expect(acceptablePage({ ...message, url: "http://PAGE.localhost:3990" }, expected)).toBe(true)
  })

  test.each([
    "http://example.com:3990",
    "http://localhost:3990",
    "http://127.0.0.1:3990",
    "http://[::1]:3990",
    "http://a.b.localhost:3990",
    "http://page.localhost.example.com:3990",
    "http://page.localhost.:3990",
    "http://.localhost:3990",
    "http://-page.localhost:3990",
    "http://page-.localhost:3990",
    "http://page_name.localhost:3990",
    `http://${"a".repeat(64)}.localhost:3990`,
    "https://page.localhost:3990",
    "http://user@page.localhost:3990",
    "http://:secret@page.localhost:3990",
    "http://user:secret@page.localhost:3990",
    "http://page.localhost:3992",
  ])("refuses %s", (url) => {
    expect(acceptablePage(LaptopOpen.parse({ ...message, url }), expected)).toBe(false)
  })

  test("refuses a wrong machine or an empty forwarded pool", () => {
    expect(acceptablePage(message, { ...expected, machineId: "other-machine" })).toBe(false)
    expect(acceptablePage(message, { ...expected, ports: [] })).toBe(false)
  })

  test("uses HTTP's default port when it is forwarded", () => {
    for (const url of ["http://page.localhost", "http://page.localhost:80"]) {
      const page = LaptopOpen.parse({ ...message, url })
      expect(acceptablePage(page, { ...expected, ports: [80] })).toBe(true)
      expect(acceptablePage(page, expected)).toBe(false)
    }
  })

  test("accepts valid DNS labels at their length boundaries", () => {
    for (const label of ["a", "1", "a-b", "a".repeat(63)]) {
      expect(acceptablePage({ ...message, url: `http://${label}.localhost:3990` }, expected)).toBe(
        true,
      )
    }
  })

  test("a page is acceptable only on a forwarded port", () => {
    const port = fc.integer({ min: 1, max: 65535 })
    const url = fc.oneof(
      fc.webUrl(),
      fc.string(),
      port.map((value) => `http://page.localhost:${value}`),
      fc.constant("http://page.localhost"),
    )
    fc.assert(
      fc.property(
        url,
        fc.uniqueArray(port, { maxLength: 20 }),
        fc.boolean(),
        (url, ports, include) => {
          const page = LaptopOpen.safeParse({ ...message, url })
          if (!page.success) return
          const parsed = new URL(url)
          const pagePort = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80))
          const forwarded = include ? [...ports, pagePort] : ports
          const accepted = acceptablePage(page.data, { ...expected, ports: forwarded })
          if (accepted) expect(forwarded).toContain(pagePort)
          if (parsed.protocol === "http:" && parsed.hostname === "page.localhost") {
            expect(accepted).toBe(forwarded.includes(pagePort))
          }
          expect(
            acceptablePage(page.data, {
              ...expected,
              ports: forwarded.filter((value) => value !== pagePort),
            }),
          ).toBe(false)
        },
      ),
    )
  })
})

describe("listenForPages", () => {
  test("creates an owner-only socket, delivers the parsed message, and removes it on close", async () => {
    await withHome(async (home) => {
      const socketPath = join(home, "connect.sock")
      const received: LaptopOpen[] = []
      const listener = await listenForPages({
        socketPath,
        accept(page) {
          received.push(page)
          return true
        },
      })
      try {
        const socket = await stat(socketPath)
        expect(socket.isSocket()).toBe(true)
        expect(socket.mode & 0o777).toBe(0o600)
        const response = await send(socketPath, JSON.stringify({ ...message, extra: "ignored" }))
        expect(response.status).toBe(204)
        expect(await response.text()).toBe("")
        expect(received).toEqual([message])
      } finally {
        await listener.close()
      }
      expect(existsSync(socketPath)).toBe(false)
    })
  })

  test("returns 400 for invalid bodies and 404 for other paths or methods without accepting", async () => {
    await withHome(async (home) => {
      const socketPath = join(home, "connect.sock")
      const received: LaptopOpen[] = []
      const listener = await listenForPages({
        socketPath,
        accept(page) {
          received.push(page)
          return true
        },
      })
      try {
        for (const body of ["{", "null", "{}", JSON.stringify({ ...message, url: "file:///x" })]) {
          expect((await send(socketPath, body)).status).toBe(400)
        }
        for (const [path, method] of [
          ["/other", "POST"],
          ["/open/", "POST"],
          ["/open", "PUT"],
        ]) {
          expect((await send(socketPath, JSON.stringify(message), path, method)).status).toBe(404)
        }
        expect((await fetch("http://iter8/open", { unix: socketPath })).status).toBe(404)
        expect(received).toEqual([])
      } finally {
        await listener.close()
      }
    })
  })

  test("returns 403 for every page outside the expected forwarded origin and machine", async () => {
    await withHome(async (home) => {
      const socketPath = join(home, "connect.sock")
      const listener = await listenForPages({
        socketPath,
        accept: (page) => acceptablePage(page, expected),
      })
      try {
        const refusals = [
          { ...message, machineId: "other-machine" },
          ...[
            "http://example.com:3990",
            "http://a.b.localhost:3990",
            "https://page.localhost:3990",
            "http://user:secret@page.localhost:3990",
            "http://page.localhost:3992",
          ].map((url) => ({ ...message, url })),
        ]
        for (const page of refusals) {
          expect((await send(socketPath, JSON.stringify(page))).status).toBe(403)
        }
      } finally {
        await listener.close()
      }
    })
  })
})

describe("announceToLaptops", () => {
  test("reaches all accepting listeners, returns their full laptop names, and ignores other files", async () => {
    await withHome(async (home) => {
      const received: LaptopOpen[] = []
      const listeners: Array<{ close(): Promise<void> }> = []
      try {
        for (const name of ["biruks-mac", "linux-laptop"]) {
          listeners.push(
            await listenForPages({
              socketPath: join(home, `laptop-${name}-01234567.sock`),
              accept(page) {
                received.push(page)
                return acceptablePage(page, expected)
              },
            }),
          )
        }
        for (const name of ["control.sock", "laptop-backup.txt"])
          await writeFile(join(home, name), "keep")
        expect((await announceToLaptops(home, message)).sort()).toEqual([
          "biruks-mac",
          "linux-laptop",
        ])
        expect(received).toEqual([message, message])
        expect(existsSync(join(home, "control.sock"))).toBe(true)
        expect(existsSync(join(home, "laptop-backup.txt"))).toBe(true)
      } finally {
        for (const listener of listeners) await listener.close()
      }
    })
  })

  test("unlinks a stale socket and continues to a live listener", async () => {
    await withHome(async (home) => {
      const stalePath = join(home, "laptop-abandoned-01234567.sock")
      const originalPath = join(home, "creating.sock")
      const stale = Bun.listen({ unix: originalPath, socket: { data() {} } })
      try {
        await rename(originalPath, stalePath)
      } finally {
        stale.stop(true)
      }
      expect((await stat(stalePath)).isSocket()).toBe(true)
      const listener = await listenForPages({
        socketPath: join(home, "laptop-live-01234567.sock"),
        accept: () => true,
      })
      try {
        expect(await announceToLaptops(home, message)).toEqual(["live"])
        expect(existsSync(stalePath)).toBe(false)
      } finally {
        await listener.close()
      }
    })
  })

  test("reports every live listener around a stale socket, whatever the directory order", async () => {
    for (const order of creationOrders) {
      await withHome(async (home) => {
        const listeners: Awaited<ReturnType<typeof listenForPages>>[] = []
        try {
          for (const name of order) {
            if (name !== badName) {
              listeners.push(
                await listenForPages({ socketPath: socketIn(home, name), accept: () => true }),
              )
              continue
            }
            const originalPath = join(home, "creating.sock")
            const stale = Bun.listen({ unix: originalPath, socket: { data() {} } })
            try {
              await rename(originalPath, socketIn(home, name))
            } finally {
              stale.stop(true)
            }
          }
          expect((await announceToLaptops(home, message)).sort()).toEqual(liveNames)
          expect(existsSync(socketIn(home, badName))).toBe(false)
        } finally {
          for (const listener of listeners) await listener.close()
        }
      })
    }
  })

  test("unlinks a socket entry whose endpoint no longer exists", async () => {
    await withHome(async (home) => {
      const socketPath = join(home, "laptop-missing-01234567.sock")
      await symlink(join(home, "gone.sock"), socketPath)
      expect(await announceToLaptops(home, message)).toEqual([])
      await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" })
    })
  })

  test("preserves a socket when connecting is denied by its permissions", async () => {
    await withHome(async (home) => {
      const socketPath = join(home, "laptop-private-01234567.sock")
      const listener = await listenForPages({ socketPath, accept: () => true })
      try {
        await chmod(socketPath, 0o000)
        expect(await announceToLaptops(home, message)).toEqual([])
        expect((await stat(socketPath)).isSocket()).toBe(true)
      } finally {
        await listener.close()
      }
    })
  })

  test("does not report a refusing listener or remove its socket", async () => {
    await withHome(async (home) => {
      const socketPath = join(home, "laptop-refusing-01234567.sock")
      const listener = await listenForPages({ socketPath, accept: () => false })
      try {
        expect(await announceToLaptops(home, message)).toEqual([])
        expect(existsSync(socketPath)).toBe(true)
      } finally {
        await listener.close()
      }
    })
  })

  test("abandons an unanswered listener after about one second, preserves its socket, and continues", async () => {
    await withHome(async (home) => {
      const socketPath = join(home, "laptop-asleep-01234567.sock")
      let finish: ((response: Response) => void) | undefined
      const unanswered = Bun.serve({
        unix: socketPath,
        fetch: () =>
          new Promise<Response>((resolve) => {
            finish = resolve
          }),
      })
      let listener: Awaited<ReturnType<typeof listenForPages>> | undefined
      try {
        listener = await listenForPages({
          socketPath: join(home, "laptop-live-01234567.sock"),
          accept: () => true,
        })
        const started = performance.now()
        expect(await announceToLaptops(home, message)).toEqual(["live"])
        const elapsed = performance.now() - started
        expect(elapsed).toBeGreaterThanOrEqual(900)
        expect(elapsed).toBeLessThan(2000)
        expect(existsSync(socketPath)).toBe(true)
        expect(finish).toBeDefined()
      } finally {
        finish?.(new Response(null, { status: 204 }))
        await unanswered.stop(true)
        await listener?.close()
      }
    })
  })

  test("reports every live listener around an unanswered one, whatever the directory order", async () => {
    for (const order of creationOrders) {
      await withHome(async (home) => {
        const listeners: Awaited<ReturnType<typeof listenForPages>>[] = []
        const pending: ((response: Response) => void)[] = []
        let unanswered: ReturnType<typeof Bun.serve> | undefined
        try {
          for (const name of order) {
            if (name === badName) {
              unanswered = Bun.serve({
                unix: socketIn(home, name),
                fetch: () => new Promise<Response>((resolve) => pending.push(resolve)),
              })
              continue
            }
            listeners.push(
              await listenForPages({ socketPath: socketIn(home, name), accept: () => true }),
            )
          }
          expect((await announceToLaptops(home, message)).sort()).toEqual(liveNames)
          expect(existsSync(socketIn(home, badName))).toBe(true)
        } finally {
          for (const finish of pending) finish(new Response(null, { status: 204 }))
          await unanswered?.stop(true)
          for (const listener of listeners) await listener.close()
        }
      })
    }
  })

  test.each([200, 302, 400, 404, 500])(
    "preserves a listener answering %i and does not report it",
    async (status) => {
      await withHome(async (home) => {
        const socketPath = join(home, "laptop-other-01234567.sock")
        const server = Bun.serve({
          unix: socketPath,
          fetch: (request) =>
            new Response(null, {
              status: new URL(request.url).pathname === "/accepted" ? 204 : status,
              headers: { location: "/accepted" },
            }),
        })
        try {
          expect(await announceToLaptops(home, message)).toEqual([])
          expect(existsSync(socketPath)).toBe(true)
        } finally {
          await server.stop(true)
        }
      })
    },
  )

  test("returns an empty list for a missing home or a path that is not a directory", async () => {
    await withHome(async (home) => {
      expect(await announceToLaptops(join(home, "missing"), message)).toEqual([])
      const file = join(home, "file")
      await writeFile(file, "")
      expect(await announceToLaptops(file, message)).toEqual([])
    })
  })
})
