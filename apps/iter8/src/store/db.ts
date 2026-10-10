import { Database } from "bun:sqlite"
import { randomBytes } from "node:crypto"
import { chmodSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { MachineId } from "@iter8/protocol"
import initialSchema from "./migrations/001_init.sql" with { type: "text" }
import conversationSchema from "./migrations/002_conversation.sql" with { type: "text" }

const migrations = [
  { version: 1, sql: initialSchema },
  { version: 2, sql: conversationSchema },
] as const

export const LATEST_MIGRATION_VERSION: number = migrations[migrations.length - 1]?.version ?? 0

export function runMigrations(db: Database): void {
  const version =
    db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0
  for (const migration of migrations) {
    if (migration.version <= version) continue
    db.transaction(() => {
      db.exec(migration.sql)
      db.exec(`PRAGMA user_version = ${migration.version}`)
    })()
  }
}

export function openStore(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new Database(path)
  try {
    if (path !== ":memory:") chmodSync(path, 0o600)
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
    runMigrations(db)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export function readOrCreateMachineId(db: Database): MachineId {
  const read = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'machine_id'")
  const existing = read.get()
  if (existing) return MachineId.parse(existing.value)
  const id = MachineId.parse(randomBytes(16).toString("base64url"))
  db.query(
    "INSERT INTO meta (key, value) VALUES ('machine_id', ?) ON CONFLICT (key) DO NOTHING",
  ).run(id)
  return MachineId.parse(read.get()?.value)
}

/** Sequence allocation rolls back with the caller's transaction, so an aborted write consumes no id. */
export function nextSequence(db: Database, name: "note_seq" | "round_seq" | "message_seq"): number {
  const row = db
    .query<{ value: string }, [string]>(
      `INSERT INTO meta (key, value) VALUES (?, '1')
       ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
       RETURNING value`,
    )
    .get(name)
  if (!row) throw new Error(`Sequence ${name} did not return a value`)
  return Number(row.value)
}
