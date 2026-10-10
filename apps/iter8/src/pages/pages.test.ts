import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PageId, PageToken } from "@iter8/protocol"
import fc from "fast-check"
import { openStore } from "../store/db"
import { createPages, type OpenPage, randomPageToken } from "./pages"

const databases: Database[] = []
const directories: string[] = []
const poolPorts = [3990, 3991, 3992, 3993]

afterEach(async () => {
  for (const db of databases.splice(0)) db.close()
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

function setup() {
  const db = openStore(":memory:")
  databases.push(db)
  let sequence = 0
  const deps = { randomToken: () => PageToken.parse(String(++sequence).padStart(43, "a")) }
  return { db, deps, pages: createPages(db, deps) }
}

function server(upstream = "http://localhost:5173", extras: string[] = []): OpenPage {
  return { target: { kind: "server", upstream, extras }, projectRoot: "/project", poolPorts }
}

test("reopening a normalized target retains its label, token and project across factory restarts", () => {
  const { pages, db, deps } = setup()
  const first = pages.open(server("http://localhost:5173/path?search=yes#hash"))
  expect<unknown>(first.page).toEqual({
    id: "larkspur",
    origin: "http://larkspur.localhost:3990",
    target: { kind: "server", upstream: "http://localhost:5173", extraUpstreams: [] },
    pairing: null,
  })
  expect(first.projectRoot).toBe("/project")
  expect(pages.open(server())).toEqual(first)
  expect(createPages(db, deps).open(server())).toEqual(first)
  expect(pages.get(first.page.id)).toEqual(first)
  expect(pages.list()).toEqual([first])
  expect(pages.get(PageId.parse("missing"))).toBeNull()
  expect<unknown>(pages.open({ ...server(), projectRoot: "/other" }).page.id).toBe("yarrow")
})

test("extras append once in input order and use the next free ports on the same hostname", () => {
  const { pages } = setup()
  const first = pages.open(server("http://localhost:5173", ["http://localhost:5174/path"]))
  const second = pages.open(
    server("http://localhost:5173", [
      "http://localhost:5174/again",
      "https://localhost:5175",
      "https://localhost:5175/path",
    ]),
  )
  expect(second.token).toBe(first.token)
  expect(second.page.id).toBe(first.page.id)
  expect(second.page.target).toEqual({
    kind: "server",
    upstream: "http://localhost:5173",
    extraUpstreams: [
      { upstream: "http://localhost:5174", port: 3991 },
      { upstream: "https://localhost:5175", port: 3992 },
    ],
  })
  expect(pages.open(server()).page.target).toEqual(second.page.target)
  expect(pages.match("larkspur.localhost", 3990)).toEqual({
    record: second,
    upstream: "http://localhost:5173",
    primary: true,
  })
  expect(pages.match("larkspur.localhost", 3992)).toEqual({
    record: second,
    upstream: "https://localhost:5175",
    primary: false,
  })
  for (const host of [
    "localhost",
    "larkspur.localhost.attacker",
    "x.larkspur.localhost",
    "larkspur.localhost.",
    "LARKSPUR.localhost",
    "missing.localhost",
    "larkspur.localhost:3990",
  ]) {
    expect(pages.match(host, 3990)).toBeNull()
  }
  expect(pages.match("larkspur.localhost", 3993)).toBeNull()
})

test("an insufficient pool rejects new pages and appended extras without partial writes", () => {
  const { db, pages } = setup()
  const oversized = {
    ...server("http://localhost:5173", ["http://localhost:5174"]),
    poolPorts: [3990],
  }
  expect(() => pages.open(oversized)).toThrow("pool [3990]")
  expect(pages.list()).toEqual([])
  expect(db.query("SELECT * FROM retired_labels").all()).toEqual([])
  const first = pages.open(server())
  expect(() => pages.open(oversized)).toThrow("pool [3990]")
  expect(pages.get(first.page.id)).toEqual(first)
  for (const ports of [[], [3990, 3990], [0], [65536]]) {
    expect(() => pages.open({ ...server("http://localhost:6000"), poolPorts: ports })).toThrow()
  }
  expect(() => pages.open(server("ftp://localhost:5173"))).toThrow()
  expect(pages.list()).toEqual([first])
})

test("all 64 plant labels are issued before suffixes and retired labels survive page deletion", () => {
  const { db, pages } = setup()
  const labels = Array.from(
    { length: 129 },
    (_, i) => pages.open(server(`http://localhost:${5000 + i}`)).page.id,
  )
  expect(new Set(labels).size).toBe(129)
  expect(labels.slice(0, 64).every((label) => /^[a-z]+$/.test(label))).toBe(true)
  expect<unknown>(labels[0]).toBe("larkspur")
  expect<unknown>(labels[1]).toBe("yarrow")
  expect<unknown>(labels[64]).toBe("larkspur-2")
  expect<unknown>(labels[65]).toBe("yarrow-2")
  expect<unknown>(labels[128]).toBe("larkspur-3")
  db.query("DELETE FROM pages WHERE id = ?").run("larkspur")
  expect<unknown>(pages.open(server()).page.id).toBe("yarrow-3")
  expect(db.query("SELECT id FROM retired_labels WHERE id = 'larkspur'").get()).toEqual({
    id: "larkspur",
  })
})

test("a label is never reused even when arbitrary pages are removed", () => {
  fc.assert(
    fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 80 }), (remove) => {
      using db = openStore(":memory:")
      const pages = createPages(db, { randomToken: () => PageToken.parse("a".repeat(43)) })
      const issued = new Set<string>()
      for (const [index, shouldRemove] of remove.entries()) {
        const record = pages.open(server(`http://localhost:${5000 + index}`))
        expect(issued.has(record.page.id)).toBe(false)
        issued.add(record.page.id)
        if (shouldRemove) db.query("DELETE FROM pages WHERE id = ?").run(record.page.id)
      }
    }),
    { numRuns: 30 },
  )
})

test("folder targets resolve symlinks and match only their primary port", async () => {
  const { pages } = setup()
  const root = await mkdtemp(join(tmpdir(), "iter8-"))
  directories.push(root)
  const alias = join(root, "alias")
  await symlink(root, alias)
  const first = pages.open({
    target: { kind: "folder", root },
    projectRoot: "/project",
    poolPorts,
  })
  expect(
    pages.open({ target: { kind: "folder", root: alias }, projectRoot: "/project", poolPorts }),
  ).toEqual(first)
  expect(first.page.target).toEqual({ kind: "folder", root })
  expect(pages.match("larkspur.localhost", 3990)).toEqual({
    record: first,
    upstream: null,
    primary: true,
  })
  expect(pages.match("larkspur.localhost", 3991)).toBeNull()
})

test("pairing is read from the store without changing it on reopen", () => {
  const { db, pages } = setup()
  const first = pages.open(server())
  db.query(`INSERT INTO owners
    (id, agent, pid, started_at, label, cwd, created_at, relabel_pending, busy)
    VALUES ('owner', 'codex', 123, 'start', 'label', '/project', 'now', 0, 0)`).run()
  db.query("UPDATE pages SET owner_id = 'owner', generation = 7 WHERE id = ?").run(first.page.id)
  expect<unknown>(pages.open(server()).page.pairing).toEqual({ owner: "owner", generation: 7 })
})

test("port reassignment moves primary and extras together while preserving identity and tokens", () => {
  const { pages } = setup()
  const first = pages.open(
    server("http://localhost:5173", ["http://localhost:5174", "http://localhost:5175"]),
  )
  pages.reassignPorts([4003, 4001, 4002])
  const moved = pages.get(first.page.id)
  expect(moved?.page.origin).toBe("http://larkspur.localhost:4003")
  expect(moved?.token).toBe(first.token)
  expect(moved?.page.target).toEqual({
    kind: "server",
    upstream: "http://localhost:5173",
    extraUpstreams: [
      { upstream: "http://localhost:5174", port: 4001 },
      { upstream: "http://localhost:5175", port: 4002 },
    ],
  })
  expect(pages.match("larkspur.localhost", 3990)).toBeNull()
  expect(pages.match("larkspur.localhost", 3991)).toBeNull()
  expect(pages.match("larkspur.localhost", 4003)?.primary).toBe(true)
  expect(pages.match("larkspur.localhost", 4001)?.upstream).toBe("http://localhost:5174")
  pages.reassignPorts([4001, 4003, 4002])
  expect(pages.get(first.page.id)?.page.origin).toBe("http://larkspur.localhost:4003")
})

test("reassigning ports moves only the extras whose port left the pool", () => {
  const { pages } = setup()
  const first = pages.open(
    server("http://localhost:5173", ["http://localhost:5174", "http://localhost:5175"]),
  )
  expect(first.page.target).toMatchObject({
    extraUpstreams: [
      { upstream: "http://localhost:5174", port: 3991 },
      { upstream: "http://localhost:5175", port: 3992 },
    ],
  })

  pages.reassignPorts([3990, 3992, 3993])

  expect(pages.get(first.page.id)?.page.target).toEqual({
    kind: "server",
    upstream: "http://localhost:5173",
    extraUpstreams: [
      { upstream: "http://localhost:5174", port: 3993 },
      { upstream: "http://localhost:5175", port: 3992 },
    ],
  })
  expect(pages.match("larkspur.localhost", 3992)?.upstream).toBe("http://localhost:5175")
  expect(pages.match("larkspur.localhost", 3993)?.upstream).toBe("http://localhost:5174")
  expect(pages.match("larkspur.localhost", 3991)).toBeNull()
})

test("reassigning to a pool that still holds every port changes nothing, whatever its order", () => {
  const { pages } = setup()
  pages.open(server("http://localhost:5173", ["http://localhost:5174", "http://localhost:5175"]))
  pages.open(server("http://localhost:6000", ["http://localhost:6001"]))
  const before = pages.list()
  pages.reassignPorts([3993, 3992, 3991, 3990])
  expect(pages.list()).toEqual(before)
})

test("an extra on the port the primary has to move to is the one that moves", () => {
  const { pages } = setup()
  const first = pages.open(server("http://localhost:5173", ["http://localhost:5174"]))
  pages.reassignPorts([3991, 3992])
  const moved = pages.get(first.page.id)
  expect(moved?.page.origin).toBe("http://larkspur.localhost:3991")
  expect(moved?.page.target).toMatchObject({
    extraUpstreams: [{ upstream: "http://localhost:5174", port: 3992 }],
  })
})

test("shrinking a pool rolls back reassignment of every page when any page cannot fit", () => {
  const { pages } = setup()
  pages.open(server())
  pages.open(server("http://localhost:6000", ["http://localhost:6001", "http://localhost:6002"]))
  const before = pages.list()
  expect(() => pages.reassignPorts([4000, 4001])).toThrow("pool [4000, 4001]")
  expect(pages.list()).toEqual(before)
  expect(() => pages.reassignPorts([])).toThrow()
  expect(pages.list()).toEqual(before)
})

test("tokens reject another page, unequal byte lengths, equal-length changes and absence", () => {
  const { pages } = setup()
  const first = pages.open(server())
  const second = pages.open(server("http://localhost:6000"))
  expect(pages.verifyToken(first, first.token)).toBe(true)
  for (const token of [
    second.token,
    null,
    "",
    first.token.slice(1),
    `${first.token}a`,
    "b".repeat(43),
    "é".repeat(43),
  ]) {
    expect(pages.verifyToken(first, token)).toBe(false)
  }
})

test("production tokens contain 32 random bytes encoded as unpadded base64url", () => {
  const tokens = Array.from({ length: 32 }, () => randomPageToken())
  expect(new Set(tokens).size).toBe(32)
  for (const token of tokens) {
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(token, "base64url").length).toBe(32)
    expect(PageToken.parse(token)).toBe(token)
  }
  const { db } = setup()
  const page = createPages(db, { randomToken: randomPageToken }).open(server())
  expect(page.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
})
