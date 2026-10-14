import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { OverlayPrefs } from "@iter8/protocol"
import { openStore } from "../store/db"
import { createPrefs } from "./prefs"

const databases: Database[] = []
const defaults = {
  theme: "auto",
  dock: "br",
  collapsed: false,
  pinsVisible: true,
  coachDone: false,
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function setup() {
  const db = openStore(":memory:")
  databases.push(db)
  return { db, prefs: createPrefs(db) }
}

test("unsaved preferences return the defaults without creating a row or sharing mutable state", () => {
  const { db, prefs } = setup()
  expect<unknown>(prefs.get()).toEqual(defaults)
  const value = prefs.get()
  value.theme = "dark"
  expect<unknown>(prefs.get()).toEqual(defaults)
  expect(db.query("SELECT * FROM prefs").all()).toEqual([])
})

test("saving preferences replaces one durable row and validates the protocol", () => {
  const { db, prefs } = setup()
  const first = OverlayPrefs.parse({
    theme: "dark",
    dock: "tl",
    collapsed: true,
    pinsVisible: false,
    coachDone: true,
  })
  expect(prefs.save(first)).toEqual(first)
  expect(prefs.get()).toEqual(first)
  expect(createPrefs(db).get()).toEqual(first)
  first.theme = "light"
  expect(prefs.get().theme).toBe("dark")
  const second = OverlayPrefs.parse({ ...defaults, theme: "light", dock: "bc", dockEdge: "bottom" })
  expect(prefs.save(second)).toEqual(second)
  expect(prefs.get()).toEqual(second)
  expect(db.query("SELECT id FROM prefs").all()).toEqual([{ id: 1 }])
  expect(() => prefs.save({ ...second, dock: "invalid" } as unknown as OverlayPrefs)).toThrow()
  expect(prefs.get()).toEqual(second)
})

test("preferences read from storage are parsed through the protocol", () => {
  const { db, prefs } = setup()
  db.query("INSERT INTO prefs (id, prefs_json) VALUES (1, ?)").run(
    JSON.stringify({ ...defaults, extra: "discarded" }),
  )
  expect<unknown>(prefs.get()).toEqual(defaults)
  db.query("UPDATE prefs SET prefs_json = ?").run(JSON.stringify({ ...defaults, collapsed: "yes" }))
  expect(() => prefs.get()).toThrow()
})
