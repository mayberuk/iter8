import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { PageToken, ScreenshotRef } from "@iter8/protocol"
import { openStore } from "../store/db"
import { createPages } from "./pages"
import { createScreenshots } from "./screenshots"

const databases: Database[] = []
const createdAt = "2026-10-09T12:00:00.000Z"
const png = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=",
    "base64",
  ),
)

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function setup() {
  const db = openStore(":memory:")
  databases.push(db)
  const pages = createPages(db, { randomToken: () => PageToken.parse("a".repeat(43)) })
  const page = pages.open({
    target: { kind: "server", upstream: "http://localhost:5173", extras: [] },
    projectRoot: "/project",
    poolPorts: [3990],
  }).page
  const other = pages.open({
    target: { kind: "server", upstream: "http://localhost:6000", extras: [] },
    projectRoot: "/project",
    poolPorts: [3990],
  }).page
  return { db, page, other, screenshots: createScreenshots(db, { now: () => new Date(createdAt) }) }
}

test("PNG bytes and IHDR dimensions persist with a random 22-character reference", () => {
  const { db, page, other, screenshots } = setup()
  const screenshot = screenshots.store(page.id, png)
  expect(screenshot).toEqual({
    ref: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
    width: 1,
    height: 1,
  })
  if (!screenshot) throw new Error("Expected a stored screenshot")
  expect(screenshots.read(page.id, screenshot.ref)).toEqual(png)
  expect(screenshots.read(null, screenshot.ref)).toEqual(png)
  expect(screenshots.read(other.id, screenshot.ref)).toBeNull()
  expect(createScreenshots(db, { now: () => new Date(0) }).read(page.id, screenshot.ref)).toEqual(
    png,
  )
  expect(screenshots.read(page.id, ScreenshotRef.parse("missing"))).toBeNull()
  expect(screenshots.read(null, ScreenshotRef.parse("missing"))).toBeNull()
  expect(db.query("SELECT page_id, width, height, created_at FROM screenshots").get()).toEqual({
    page_id: page.id,
    width: 1,
    height: 1,
    created_at: createdAt,
  })
  expect(screenshots.store(page.id, png)?.ref).not.toBe(screenshot.ref)
})

test("invalid signatures, missing IHDR, truncated headers and zero dimensions store nothing", () => {
  const { db, page, screenshots } = setup()
  const badSignature = png.slice()
  badSignature[0] = 0
  const badIhdr = png.slice()
  badIhdr[12] = 0
  const zeroWidth = png.slice()
  new DataView(zeroWidth.buffer).setUint32(16, 0)
  const zeroHeight = png.slice()
  new DataView(zeroHeight.buffer).setUint32(20, 0)
  for (const invalid of [
    new Uint8Array(),
    new TextEncoder().encode("not a PNG"),
    png.slice(0, 23),
    badSignature,
    badIhdr,
    zeroWidth,
    zeroHeight,
  ]) {
    expect(screenshots.store(page.id, invalid)).toBeNull()
  }
  expect(db.query("SELECT * FROM screenshots").all()).toEqual([])
})

test("header inspection honors byte offsets and reads dimensions in network order", () => {
  const { page, screenshots } = setup()
  const backing = new Uint8Array(40)
  const header = backing.subarray(7, 31)
  header.set(png.subarray(0, 24))
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
  view.setUint32(16, 640)
  view.setUint32(20, 480)
  const screenshot = screenshots.store(page.id, header)
  expect(screenshot?.width).toBe(640)
  expect(screenshot?.height).toBe(480)
  if (!screenshot) throw new Error("Expected a stored header")
  expect(screenshots.read(page.id, screenshot.ref)).toEqual(header)
})
