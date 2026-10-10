import type { Database } from "bun:sqlite"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { realpathSync } from "node:fs"
import { HttpUrl, Page, PageId, PageToken, Port } from "@iter8/protocol"

export type OpenPage = {
  target: { kind: "server"; upstream: string; extras: string[] } | { kind: "folder"; root: string }
  projectRoot: string
  poolPorts: number[]
}
export type PageRecord = { page: Page; token: PageToken; projectRoot: string }
export type HostMatch = { record: PageRecord; upstream: string | null; primary: boolean }
export type Pages = {
  open(input: OpenPage): PageRecord
  match(hostname: string, port: number): HostMatch | null
  get(pageId: PageId): PageRecord | null
  verifyToken(record: PageRecord, token: string | null): boolean
  list(): PageRecord[]
  reassignPorts(poolPorts: number[]): void
}

type PageRow = {
  id: string
  token: string
  project_root: string
  target_kind: "server" | "folder"
  target: string
  port: number
  owner_id: string | null
  generation: number
}

type ExtraUpstream = Extract<Page["target"], { kind: "server" }>["extraUpstreams"][number]

const plantNames = [
  "larkspur",
  "yarrow",
  "aster",
  "azalea",
  "basil",
  "birch",
  "cedar",
  "clover",
  "crocus",
  "dahlia",
  "daisy",
  "elm",
  "fern",
  "fir",
  "flax",
  "foxglove",
  "ginger",
  "ginkgo",
  "hazel",
  "heather",
  "holly",
  "hosta",
  "hyssop",
  "iris",
  "ivy",
  "jasmine",
  "juniper",
  "laurel",
  "lavender",
  "lilac",
  "lily",
  "lotus",
  "lupine",
  "magnolia",
  "maple",
  "marigold",
  "mint",
  "moss",
  "myrtle",
  "nettle",
  "oak",
  "olive",
  "orchid",
  "pansy",
  "peony",
  "pine",
  "poppy",
  "primrose",
  "reed",
  "rosemary",
  "rue",
  "sage",
  "sedge",
  "sorrel",
  "spruce",
  "sumac",
  "tansy",
  "thistle",
  "thyme",
  "tulip",
  "violet",
  "willow",
  "wisteria",
  "zinnia",
] as const

export function randomPageToken(): PageToken {
  return PageToken.parse(randomBytes(32).toString("base64url"))
}

export function createPages(db: Database, deps: { randomToken: () => PageToken }): Pages {
  const columns = "id, token, project_root, target_kind, target, port, owner_id, generation"
  const byId = db.query<PageRow, [string]>(`SELECT ${columns} FROM pages WHERE id = ?`)
  const byTarget = db.query<PageRow, [string, string, string]>(
    `SELECT ${columns} FROM pages WHERE project_root = ? AND target_kind = ? AND target = ?`,
  )
  const allPages = db.query<PageRow, []>(`SELECT ${columns} FROM pages ORDER BY rowid`)
  const extrasFor = db.query<ExtraUpstream, [string]>(
    "SELECT upstream, port FROM page_upstreams WHERE page_id = ? ORDER BY rowid",
  )
  const insertExtra = db.query(
    "INSERT INTO page_upstreams (page_id, upstream, port) VALUES (?, ?, ?)",
  )
  const retired = db.query<{ id: string }, [string]>("SELECT id FROM retired_labels WHERE id = ?")

  function record(row: PageRow): PageRecord {
    return {
      page: Page.parse({
        id: row.id,
        origin: `http://${row.id}.localhost:${row.port}`,
        target:
          row.target_kind === "server"
            ? { kind: "server", upstream: row.target, extraUpstreams: extrasFor.all(row.id) }
            : { kind: "folder", root: row.target },
        pairing: row.owner_id === null ? null : { owner: row.owner_id, generation: row.generation },
      }),
      token: PageToken.parse(row.token),
      projectRoot: row.project_root,
    }
  }

  function pool(ports: number[]): number[] {
    const result = ports.map((port) => Port.parse(port))
    if (!result.length || new Set(result).size !== result.length) {
      throw new Error(`Invalid port pool [${ports.join(", ")}]`)
    }
    return result
  }

  function nextLabel(): PageId {
    for (let suffix = 1; ; suffix++) {
      for (const name of plantNames) {
        const label = suffix === 1 ? name : `${name}-${suffix}`
        if (!retired.get(label)) return PageId.parse(label)
      }
    }
  }

  const open = db.transaction((input: OpenPage): PageRecord => {
    const ports = pool(input.poolPorts)
    const target =
      input.target.kind === "server"
        ? new URL(HttpUrl.parse(input.target.upstream)).origin
        : realpathSync(input.target.root)
    const incomingExtras =
      input.target.kind === "server"
        ? [...new Set(input.target.extras.map((url) => new URL(HttpUrl.parse(url)).origin))]
        : []
    let row = byTarget.get(input.projectRoot, input.target.kind, target)
    const existingExtras = row ? extrasFor.all(row.id) : []
    const additions = incomingExtras.filter(
      (upstream) => !existingExtras.some((extra) => extra.upstream === upstream),
    )
    const primaryPort = row?.port ?? ports[0]
    if (primaryPort === undefined) throw new Error("Port pool is empty")
    const used = new Set([primaryPort, ...existingExtras.map((extra) => extra.port)])
    const free = ports.filter((port) => !used.has(port))
    if (additions.length > free.length) {
      throw new Error(`Not enough ports in pool [${ports.join(", ")}] for extra upstreams`)
    }
    if (!row) {
      const id = nextLabel()
      const token = PageToken.parse(deps.randomToken())
      db.query("INSERT INTO retired_labels (id) VALUES (?)").run(id)
      db.query(
        `INSERT INTO pages
         (id, token, project_root, target_kind, target, port, owner_id, generation, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?)`,
      ).run(
        id,
        token,
        input.projectRoot,
        input.target.kind,
        target,
        primaryPort,
        new Date().toISOString(),
      )
      row = byId.get(id)
    }
    if (!row) throw new Error("Inserted page could not be read")
    for (const [index, upstream] of additions.entries()) {
      const port = free[index]
      if (port === undefined) throw new Error("Extra upstream has no pool port")
      insertExtra.run(row.id, upstream, port)
    }
    return record(row)
  })

  const reassignPorts = db.transaction((poolPorts: number[]) => {
    const ports = pool(poolPorts)
    for (const row of allPages.all()) {
      const primaryPort = ports.includes(row.port) ? row.port : ports[0]
      if (primaryPort === undefined) throw new Error("Port pool is empty")
      const extras = extrasFor.all(row.id)
      const kept = new Set(
        extras
          .map((extra) => extra.port)
          .filter((port) => port !== primaryPort && ports.includes(port)),
      )
      const free = ports.filter((port) => port !== primaryPort && !kept.has(port))
      const moving = extras.filter(
        (extra) => extra.port === primaryPort || !ports.includes(extra.port),
      )
      if (moving.length > free.length) {
        throw new Error(`Not enough ports in pool [${ports.join(", ")}] for extra upstreams`)
      }
      db.query("UPDATE pages SET port = ? WHERE id = ?").run(primaryPort, row.id)
      db.query("DELETE FROM page_upstreams WHERE page_id = ?").run(row.id)
      let next = 0
      for (const extra of extras) {
        const stays = extra.port !== primaryPort && ports.includes(extra.port)
        const port = stays ? extra.port : free[next++]
        if (port === undefined) throw new Error("Extra upstream has no pool port")
        insertExtra.run(row.id, extra.upstream, port)
      }
    }
  })

  return {
    open: (input) => open.immediate(input),
    get(pageId) {
      const row = byId.get(pageId)
      return row ? record(row) : null
    },
    list: () => allPages.all().map(record),
    match(hostname, port) {
      if (!hostname.endsWith(".localhost")) return null
      const id = PageId.safeParse(hostname.slice(0, -".localhost".length))
      if (!id.success) return null
      const row = byId.get(id.data)
      if (!row) return null
      if (port === row.port) {
        return {
          record: record(row),
          upstream: row.target_kind === "server" ? row.target : null,
          primary: true,
        }
      }
      const extra = extrasFor.all(row.id).find((candidate) => candidate.port === port)
      return extra ? { record: record(row), upstream: extra.upstream, primary: false } : null
    },
    verifyToken(record, token) {
      if (token === null) return false
      const expected = Buffer.from(record.token)
      const supplied = Buffer.from(token)
      return expected.length === supplied.length && timingSafeEqual(expected, supplied)
    },
    reassignPorts: (ports) => reassignPorts.immediate(ports),
  }
}
