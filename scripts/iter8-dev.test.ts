import { afterEach, beforeEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { z } from "zod"

const repo = resolve(import.meta.dir, "..")
const launcher = join(repo, "scripts/iter8-dev")
let scratch = ""

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "iter8-dev-test-"))
  await mkdir(join(scratch, "bin"))
  await writeFile(
    join(scratch, "bin/bun"),
    '#!/bin/sh\nprintf "%s\\0" "$ITER8_HOME" "$ITER8_POOL" "$@"\n',
  )
  await chmod(join(scratch, "bin/bun"), 0o755)
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

async function launch(
  script: string,
  env: Record<string, string>,
  args: string[] = ["status", "--json"],
): Promise<string[]> {
  const child = Bun.spawn([script, ...args], {
    env: { PATH: `${join(scratch, "bin")}:/usr/bin:/bin`, HOME: join(scratch, "home"), ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  expect(code).toBe(0)
  return out.split("\0").slice(0, -1)
}

test("without ITER8_HOME or ITER8_POOL it runs the source CLI on ~/.iter8-dev and pool 3970-3973", async () => {
  expect(await launch(launcher, {})).toEqual([
    join(scratch, "home/.iter8-dev"),
    "3970-3973",
    join(repo, "apps/iter8/src/main.ts"),
    "status",
    "--json",
  ])
})

test("an ITER8_HOME or ITER8_POOL already set wins", async () => {
  const lines = await launch(launcher, { ITER8_HOME: "/elsewhere", ITER8_POOL: "4000-4001" })
  expect(lines.slice(0, 2)).toEqual(["/elsewhere", "4000-4001"])
})

test("run through a symlink it still finds the repo's CLI", async () => {
  const link = join(scratch, "bin/iter8")
  await symlink(launcher, link)
  expect((await launch(link, {}))[2]).toBe(join(repo, "apps/iter8/src/main.ts"))
})

test("an empty ITER8_HOME or ITER8_POOL falls back to the default", async () => {
  const lines = await launch(launcher, { ITER8_HOME: "", ITER8_POOL: "" })
  expect(lines.slice(0, 2)).toEqual([join(scratch, "home/.iter8-dev"), "3970-3973"])
})

test("setting only ITER8_HOME leaves the pool at its default", async () => {
  const lines = await launch(launcher, { ITER8_HOME: "/elsewhere" })
  expect(lines.slice(0, 2)).toEqual(["/elsewhere", "3970-3973"])
})

test("setting only ITER8_POOL leaves the home at its default", async () => {
  const lines = await launch(launcher, { ITER8_POOL: "4000-4001" })
  expect(lines.slice(0, 2)).toEqual([join(scratch, "home/.iter8-dev"), "4000-4001"])
})

test("with no arguments it forwards nothing after the main.ts path", async () => {
  const lines = await launch(launcher, {}, [])
  expect(lines.slice(2)).toEqual([join(repo, "apps/iter8/src/main.ts")])
})

test("arguments with spaces and an empty argument arrive intact", async () => {
  const args = ["run", "two words", "", "--note=a  b", "*"]
  const lines = await launch(launcher, {}, args)
  expect(lines.slice(3)).toEqual(args)
})

test("a chain of relative symlinks still finds the repo's CLI", async () => {
  await mkdir(join(scratch, "a"))
  await mkdir(join(scratch, "b"))
  const hop = join(scratch, "b/hop")
  const link = join(scratch, "a/link")
  await symlink(relative(dirname(hop), launcher), hop)
  await symlink("../b/hop", link)
  expect((await launch(link, {}))[2]).toBe(join(repo, "apps/iter8/src/main.ts"))
})

test("the launcher file mode is 755", async () => {
  expect((await stat(launcher)).mode & 0o777).toBe(0o755)
})

test("the root package.json dev, dev:claude and prod scripts read exactly as designed", async () => {
  const manifest = z
    .object({ scripts: z.record(z.string(), z.string()) })
    .parse(await Bun.file(join(repo, "package.json")).json())
  expect(manifest.scripts.dev).toBe("bun scripts/dev.ts")
  expect(manifest.scripts["dev:claude"]).toBe("ITER8_BIN=$PWD/scripts/iter8-dev claude")
  expect(manifest.scripts.prod).toBe("iter8 run playground")
})
