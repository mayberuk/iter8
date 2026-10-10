import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { MachineId } from "@iter8/protocol"
import {
  LATEST_MIGRATION_VERSION,
  nextSequence,
  openStore,
  readOrCreateMachineId,
  runMigrations,
} from "./db"
import initialSchema from "./migrations/001_init.sql" with { type: "text" }

const databases: Database[] = []
const directories: string[] = []

afterEach(async () => {
  for (const db of databases.splice(0)) db.close()
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

function store(path = ":memory:") {
  const db = openStore(path)
  databases.push(db)
  return db
}

async function databasePath() {
  const directory = await mkdtemp(join(tmpdir(), "iter8-"))
  directories.push(directory)
  return join(directory, "state", "iter8.db")
}

test("a fresh store applies every migration and creates exactly the contracted tables and columns", () => {
  const db = store()
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: LATEST_MIGRATION_VERSION })
  const columns = {
    meta: ["key", "value"],
    owners: [
      "id",
      "agent",
      "pid",
      "started_at",
      "label",
      "cwd",
      "created_at",
      "relabel_pending",
      "busy",
      "gone_reason",
    ],
    pages: [
      "id",
      "token",
      "project_root",
      "target_kind",
      "target",
      "port",
      "owner_id",
      "generation",
      "created_at",
    ],
    page_upstreams: ["page_id", "upstream", "port"],
    retired_labels: ["id"],
    notes: [
      "id",
      "page_id",
      "round_id",
      "kind",
      "ordinal",
      "author_json",
      "intent",
      "body",
      "target_json",
      "anchor_status",
      "capture_json",
      "resolution_json",
      "created_at",
    ],
    rounds: ["id", "page_id", "owner_id", "state_json", "created_at"],
    round_keys: ["idempotency_key", "round_id"],
    announcements: ["owner_id", "label", "round_id", "at"],
    screenshots: ["ref", "page_id", "png", "width", "height", "created_at"],
    prefs: ["id", "prefs_json"],
    messages: [
      "id",
      "page_id",
      "round_id",
      "owner_id",
      "author_json",
      "text",
      "dedupe_key",
      "at",
      "ordinal",
    ],
    page_chat: ["page_id", "enabled"],
    owner_focus: ["owner_id", "page_id", "round_id", "at"],
  }
  const tables = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  )
  expect(
    tables
      .all()
      .map((row) => row.name)
      .sort(),
  ).toEqual(Object.keys(columns).sort())
  for (const [table, expected] of Object.entries(columns)) {
    expect(
      db
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name),
    ).toEqual(expected)
  }
})

test("opening a missing state directory creates private directory and database permissions", async () => {
  const path = await databasePath()
  const db = store(path)
  expect((await stat(dirname(path))).mode & 0o777).toBe(0o700)
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" })
  expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 })
  expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 })
})

test("reopening preserves rows, machine identity and counters and restores database permissions", async () => {
  const path = await databasePath()
  const first = store(path)
  first.query("INSERT INTO retired_labels (id) VALUES (?)").run("larkspur")
  const machineId = readOrCreateMachineId(first)
  first.transaction(() => expect(nextSequence(first, "note_seq")).toBe(1))()
  first.close()
  await chmod(path, 0o644)
  const reopened = store(path)
  expect(reopened.query("SELECT id FROM retired_labels").all()).toEqual([{ id: "larkspur" }])
  expect(reopened.query("PRAGMA user_version").get()).toEqual({
    user_version: LATEST_MIGRATION_VERSION,
  })
  expect(readOrCreateMachineId(reopened)).toBe(machineId)
  reopened.transaction(() => expect(nextSequence(reopened, "note_seq")).toBe(2))()
  expect((await stat(path)).mode & 0o777).toBe(0o600)
})

test("a failing migration rolls back its schema and leaves the previous version and rows intact", () => {
  const db = new Database(":memory:")
  databases.push(db)
  db.exec("CREATE TABLE pages (id TEXT); INSERT INTO pages VALUES ('existing');")
  expect(() => runMigrations(db)).toThrow()
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 0 })
  expect(db.query("SELECT id FROM pages").all()).toEqual([{ id: "existing" }])
  expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([
    { name: "pages" },
  ])
})

test("machine identity is a persisted 128-bit unpadded base64url value", () => {
  const db = store()
  const id = readOrCreateMachineId(db)
  expect(MachineId.parse(id)).toBe(id)
  expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/)
  expect(Buffer.from(id, "base64url").byteLength).toBe(16)
  expect(readOrCreateMachineId(db)).toBe(id)
  expect(db.query("SELECT value FROM meta WHERE key = 'machine_id'").get()).toEqual({ value: id })
})

test("machine identity reads and validates an existing value", () => {
  const db = store()
  db.query("INSERT INTO meta (key, value) VALUES ('machine_id', ?)").run("stored-machine")
  expect(readOrCreateMachineId(db)).toBe(MachineId.parse("stored-machine"))
  db.exec("UPDATE meta SET value = '' WHERE key = 'machine_id'")
  expect(() => readOrCreateMachineId(db)).toThrow()
})

test("sequences increment independently from one", () => {
  const db = store()
  const allocate = db.transaction((name: "note_seq" | "round_seq" | "message_seq") =>
    nextSequence(db, name),
  )
  expect([allocate("note_seq"), allocate("note_seq"), allocate("note_seq")]).toEqual([1, 2, 3])
  expect([allocate("round_seq"), allocate("round_seq"), allocate("round_seq")]).toEqual([1, 2, 3])
  expect([allocate("message_seq"), allocate("message_seq"), allocate("message_seq")]).toEqual([
    1, 2, 3,
  ])
})

test("both new and existing sequence increments roll back with the caller's transaction", () => {
  const db = store()
  const abort = db.transaction(() => {
    nextSequence(db, "note_seq")
    nextSequence(db, "round_seq")
    nextSequence(db, "message_seq")
    throw new Error("abort write")
  })
  expect(abort).toThrow("abort write")
  expect(db.query("SELECT * FROM meta").all()).toEqual([])
  const allocate = db.transaction(() => [
    nextSequence(db, "note_seq"),
    nextSequence(db, "round_seq"),
    nextSequence(db, "message_seq"),
  ])
  expect(allocate()).toEqual([1, 1, 1])
  expect(abort).toThrow("abort write")
  expect(allocate()).toEqual([2, 2, 2])
})

test("the schema enforces foreign keys, target and note kinds, unique identities and singleton prefs", () => {
  const db = store()
  const owner = db.query(
    `INSERT INTO owners (id, agent, pid, started_at, label, cwd, created_at, relabel_pending, busy)
     VALUES (?, 'agent', 42, 'started', 'label', '/project', 'created', 0, 0)`,
  )
  owner.run("owner-one")
  expect(() => owner.run("owner-two")).toThrow()
  const page = db.query(
    `INSERT INTO pages (id, token, project_root, target_kind, target, port, owner_id, generation, created_at)
     VALUES (?, 'token', '/project', ?, 'http://localhost:3000', 3990, ?, 0, 'created')`,
  )
  expect(() => page.run("larkspur", "server", "missing-owner")).toThrow()
  expect(() => page.run("larkspur", "invalid", null)).toThrow()
  page.run("larkspur", "server", null)
  expect(() => page.run("other-page", "server", null)).toThrow()
  const note = db.query(
    `INSERT INTO notes (id, page_id, kind, ordinal, author_json, intent, body, target_json,
      anchor_status, resolution_json, created_at)
     VALUES (?, ?, ?, 1, '{}', 'fix', 'body', '{}', 'anchored', '{}', 'created')`,
  )
  expect(() => note.run("N1", "missing-page", "draft")).toThrow()
  expect(() => note.run("N1", "larkspur", "invalid")).toThrow()
  for (const [index, kind] of ["draft", "sent", "agent"].entries()) {
    note.run(`N${index + 1}`, "larkspur", kind)
  }
  db.exec("INSERT INTO prefs (id, prefs_json) VALUES (1, '{}')")
  expect(() => db.exec("INSERT INTO prefs (id, prefs_json) VALUES (2, '{}')")).toThrow()
})

test("opening a version-one store preserves every row and seeds each paired owner's highest page focus", async () => {
  const directory = await mkdtemp(join(tmpdir(), "iter8-migrate-"))
  const path = join(directory, "iter8.db")
  const previous = new Database(path)
  let migrated: Database | null = null
  try {
    previous.exec(initialSchema)
    previous.exec(`
      PRAGMA user_version = 1;
      INSERT INTO owners VALUES ('owner-one', 'claude', 101, 'started', 'first', '/project', 'created', 0, 0, NULL);
      INSERT INTO owners VALUES ('owner-two', 'claude', 102, 'started', 'second', '/project', 'created', 0, 0, NULL);
      INSERT INTO owners VALUES ('unpaired', 'claude', 103, 'started', 'third', '/project', 'created', 0, 0, NULL);
      INSERT INTO pages VALUES ('yarrow', 'token', '/project', 'server', 'http://localhost:3000', 3990, 'owner-one', 1, 'created');
      INSERT INTO pages VALUES ('aster', 'token', '/project', 'server', 'http://localhost:3001', 3991, 'owner-one', 2, 'created');
      INSERT INTO pages VALUES ('larkspur', 'token', '/project', 'server', 'http://localhost:3002', 3992, 'owner-two', 1, 'created');
      INSERT INTO pages VALUES ('meadow', 'token', '/project', 'server', 'http://localhost:3003', 3993, NULL, 0, 'created');
      INSERT INTO meta VALUES ('note_seq', '1');
      INSERT INTO page_upstreams VALUES ('yarrow', 'http://localhost:3004', 3994);
      INSERT INTO retired_labels VALUES ('yarrow');
      INSERT INTO rounds VALUES ('R1', 'yarrow', 'owner-one', '{}', 'created');
      INSERT INTO notes VALUES ('N1', 'yarrow', 'R1', 'sent', 1, '{}', 'fix', 'Keep this note', '{}', 'anchored', NULL, '{}', 'created');
      INSERT INTO round_keys VALUES ('send-key', 'R1');
      INSERT INTO announcements VALUES ('owner-one', 'first', 'R1', 'created');
      INSERT INTO screenshots VALUES ('shot', 'yarrow', X'0102', 1, 1, 'created');
      INSERT INTO prefs VALUES (1, '{}');
    `)
    const tables = previous
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
    const snapshots = tables.map(({ name }) => ({
      name,
      rows: previous.query(`SELECT * FROM ${name}`).all(),
    }))
    previous.close()
    migrated = openStore(path)
    expect(LATEST_MIGRATION_VERSION).toBe(2)
    expect(migrated.query("PRAGMA user_version").get()).toEqual({ user_version: 2 })
    for (const { name, rows } of snapshots)
      expect(migrated.query(`SELECT * FROM ${name}`).all()).toEqual(rows)
    expect(
      migrated.query("SELECT owner_id, page_id, round_id FROM owner_focus ORDER BY owner_id").all(),
    ).toEqual([
      { owner_id: "owner-one", page_id: "yarrow", round_id: null },
      { owner_id: "owner-two", page_id: "larkspur", round_id: null },
    ])
    runMigrations(migrated)
    expect(migrated.query("SELECT COUNT(*) AS n FROM owner_focus").get()).toEqual({ n: 2 })
  } finally {
    previous.close()
    migrated?.close()
    await rm(directory, { recursive: true })
  }
})
