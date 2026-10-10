import type { Database } from "bun:sqlite"
import { randomBytes } from "node:crypto"
import { type PageId, Screenshot, type ScreenshotRef } from "@iter8/protocol"

export type Screenshots = {
  store(pageId: PageId, png: Uint8Array): Screenshot | null
  read(pageId: PageId | null, ref: ScreenshotRef): Uint8Array | null
}

export function createScreenshots(db: Database, deps: { now: () => Date }): Screenshots {
  return {
    store(pageId, png) {
      const signature = [137, 80, 78, 71, 13, 10, 26, 10]
      const ihdr = new TextDecoder().decode(png.subarray(12, 16))
      if (
        png.length < 24 ||
        signature.some((byte, index) => png[index] !== byte) ||
        ihdr !== "IHDR"
      ) {
        return null
      }
      const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
      const parsed = Screenshot.safeParse({
        ref: randomBytes(16).toString("base64url"),
        width: view.getUint32(16),
        height: view.getUint32(20),
      })
      if (!parsed.success) return null
      const screenshot = parsed.data
      db.query(
        "INSERT INTO screenshots (ref, page_id, png, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        screenshot.ref,
        pageId,
        png,
        screenshot.width,
        screenshot.height,
        deps.now().toISOString(),
      )
      return screenshot
    },
    read(pageId, ref) {
      const row =
        pageId === null
          ? db
              .query<{ png: Uint8Array }, [string]>("SELECT png FROM screenshots WHERE ref = ?")
              .get(ref)
          : db
              .query<{ png: Uint8Array }, [string, string]>(
                "SELECT png FROM screenshots WHERE ref = ? AND page_id = ?",
              )
              .get(ref, pageId)
      return row?.png ?? null
    },
  }
}
