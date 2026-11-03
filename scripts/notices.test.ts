import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { bundledPackages, collectNotices, nonPermissive, renderNotices } from "./notices"

const root = join(import.meta.dir, "..")
const noticesFile = Bun.file(join(root, "THIRD-PARTY-NOTICES"))

describe("THIRD-PARTY-NOTICES", () => {
  test("names every directly declared runtime dependency", async () => {
    const manifest = (await Bun.file(join(root, "package.json")).json()) as {
      dependencies: Record<string, string>
    }
    const text = await noticesFile.text()
    for (const name of Object.keys(manifest.dependencies)) {
      if (name === "@iter8/protocol") continue
      expect(text).toContain(`\n${name} ${manifest.dependencies[name]}\n`)
    }
  })

  test("lists every bundled package, including transitive ones, at its locked version", async () => {
    const text = await noticesFile.text()
    const bundled = await bundledPackages(root)
    expect(bundled.length).toBeGreaterThan(13)
    for (const { name, version } of bundled) {
      expect(text).toContain(`\n${name} ${version}\nLicense: `)
    }
  })

  test("follows the workspace protocol package into zod and keeps type-only packages out", async () => {
    const names = (await bundledPackages(root)).map((p) => p.name)
    expect(names).toContain("zod")
    expect(names).toContain("thread-stream")
    expect(names.filter((n) => n.startsWith("@types/"))).toEqual([])
  })

  test("is the output of bun scripts/notices.ts", async () => {
    expect(await noticesFile.text()).toBe(renderNotices(await collectNotices(root)))
  })

  test("every bundled package has a permissive licence", async () => {
    expect(nonPermissive(await collectNotices(root)).map((n) => `${n.name}@${n.version}`)).toEqual(
      [],
    )
  })
})
