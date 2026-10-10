import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ENV } from "@iter8/protocol"
import { resolveOverlayDir, serveAsset } from "./assets"

const directories: string[] = []

afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

async function overlayDir() {
  const root = await mkdtemp(join(tmpdir(), "iter8-"))
  directories.push(root)
  const dir = join(root, "overlay")
  await mkdir(join(dir, "fonts"), { recursive: true })
  await writeFile(join(dir, "overlay.js"), "export function mount() {}\n")
  await writeFile(join(dir, "fonts", "figtree.woff2"), new Uint8Array([119, 79, 70, 50]))
  await writeFile(join(root, "secret.txt"), "outside the overlay directory")
  await mkdir(join(root, "overlay-sibling"))
  await writeFile(join(root, "overlay-sibling", "secret.txt"), "beside the overlay directory")
  return dir
}

test("a file in the overlay directory is served with its MIME type", async () => {
  const dir = await overlayDir()
  const script = await serveAsset(dir, "overlay.js")
  expect(script.status).toBe(200)
  expect(script.headers.get("content-type")).toStartWith("text/javascript")
  expect(await script.text()).toBe("export function mount() {}\n")
  const font = await serveAsset(dir, "fonts/figtree.woff2")
  expect(font.status).toBe(200)
  expect(font.headers.get("content-type")).toBe("font/woff2")
  expect(new Uint8Array(await font.arrayBuffer())).toEqual(new Uint8Array([119, 79, 70, 50]))
})

test("a missing source.js, a directory and the root itself answer 404", async () => {
  const dir = await overlayDir()
  for (const pathname of ["source.js", "fonts", "fonts/", "", "nope/overlay.js"]) {
    expect((await serveAsset(dir, pathname)).status).toBe(404)
  }
})

test("paths that escape the overlay directory answer 404", async () => {
  const dir = await overlayDir()
  for (const pathname of [
    "../secret.txt",
    "../overlay-sibling/secret.txt",
    "..%2Foverlay-sibling%2Fsecret.txt",
    "..%2Fsecret.txt",
    "fonts%2F..%2F..%2Fsecret.txt",
    "%2e%2e/secret.txt",
    `${encodeURIComponent(join(dir, "..", "secret.txt"))}`,
    "%E0%A4%A",
    "overlay.js%00",
  ]) {
    expect((await serveAsset(dir, pathname)).status).toBe(404)
  }
})

test("ITER8_OVERLAY_DIR wins, and a source run uses the repository build", () => {
  expect(
    resolveOverlayDir({ [ENV.overlayDir]: "/custom" }, "/embedded", "/repo/dist/overlay"),
  ).toBe("/custom")
  expect(Bun.isStandaloneExecutable).toBe(false)
  expect(resolveOverlayDir({}, "/embedded", "/repo/dist/overlay")).toBe("/repo/dist/overlay")
  expect(resolveOverlayDir({ [ENV.overlayDir]: "" }, "/embedded", "/repo/dist/overlay")).toBe(
    "/repo/dist/overlay",
  )
  expect(resolveOverlayDir({}, "/embedded", "/repo/dist/overlay", true)).toBe("/embedded")
  expect(resolveOverlayDir({ [ENV.overlayDir]: "" }, "/embedded", "/repo/dist/overlay", true)).toBe(
    "/embedded",
  )
  expect(
    resolveOverlayDir({ [ENV.overlayDir]: "/custom" }, "/embedded", "/repo/dist/overlay", true),
  ).toBe("/custom")
  expect(resolveOverlayDir({}, "/embedded", "/repo/dist/overlay", false)).toBe("/repo/dist/overlay")
})
