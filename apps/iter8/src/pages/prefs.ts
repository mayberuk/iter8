import type { Database } from "bun:sqlite"
import { OverlayPrefs } from "@iter8/protocol"

export type Prefs = { get(): OverlayPrefs; save(prefs: OverlayPrefs): OverlayPrefs }

export function createPrefs(db: Database): Prefs {
  return {
    get() {
      const row = db
        .query<{ prefs_json: string }, []>("SELECT prefs_json FROM prefs WHERE id = 1")
        .get()
      return OverlayPrefs.parse(
        row
          ? JSON.parse(row.prefs_json)
          : {
              theme: "auto",
              dock: "br",
              collapsed: false,
              pinsVisible: true,
              coachDone: false,
            },
      )
    },
    save(prefs) {
      const parsed = OverlayPrefs.parse(prefs)
      db.query(
        "INSERT INTO prefs (id, prefs_json) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET prefs_json = excluded.prefs_json",
      ).run(JSON.stringify(parsed))
      return parsed
    },
  }
}
