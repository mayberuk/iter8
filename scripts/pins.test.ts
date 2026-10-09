import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import fc from "fast-check"
import { z } from "zod"

const manifestSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  packageManager: z.string().optional(),
})
const exactVersion =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

function assertPinnedDependencies(packagePath: string, input: unknown) {
  const manifest = manifestSchema.parse(input)
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (version !== "workspace:*" && !exactVersion.test(version)) {
        throw new Error(
          `${packagePath}: ${section}.${name} must be an exact version; got ${version}`,
        )
      }
    }
  }
}

const repoRoot = fileURLToPath(new URL("../", import.meta.url))
const packagePaths = [
  "package.json",
  "packages/*/package.json",
  "harness/package.json",
  "fixtures/*/package.json",
]
  .flatMap((pattern) => [...new Bun.Glob(pattern).scanSync({ cwd: repoRoot })])
  .sort()

for (const packagePath of packagePaths) {
  test(`${packagePath} pins every dependency`, async () => {
    assertPinnedDependencies(packagePath, await Bun.file(`${repoRoot}${packagePath}`).json())
  })
}

test("the root package manager is Bun 1.4.2", async () => {
  const manifest = manifestSchema.parse(await Bun.file(`${repoRoot}package.json`).json())
  expect(manifest.packageManager).toBe("bun@1.4.2")
})

test("exact versions and workspace links are accepted in every dependency section", () => {
  fc.assert(
    fc.property(fc.nat(), fc.nat(), fc.nat(), (major, minor, patch) => {
      for (const version of [`${major}.${minor}.${patch}`, "workspace:*"]) {
        assertPinnedDependencies("example/package.json", {
          dependencies: { zod: version },
          devDependencies: { typescript: version },
          optionalDependencies: { preact: version },
          peerDependencies: { hono: version },
        })
      }
    }),
  )
})

test("ranges and tags are rejected with the package and dependency name", () => {
  fc.assert(
    fc.property(
      fc.nat(),
      fc.nat(),
      fc.nat(),
      fc.constantFrom(
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ),
      (major, minor, patch, section) => {
        const version = `${major}.${minor}.${patch}`
        for (const invalid of [
          `^${version}`,
          `~${version}`,
          `>=${version}`,
          `${major}.${minor}.*`,
          `${version} || 99.0.0`,
          `${version} - 99.0.0`,
          "*",
          "latest",
          "next",
          "workspace:^",
        ]) {
          expect(() =>
            assertPinnedDependencies("example/package.json", { [section]: { zod: invalid } }),
          ).toThrow(`example/package.json: ${section}.zod`)
        }
      },
    ),
  )
})
