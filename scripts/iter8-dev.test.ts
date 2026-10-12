import { afterEach, beforeEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repo = resolve(import.meta.dir, "..")
const launcher = join(repo, "scripts/iter8-dev")
let scratch = ""

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "iter8-dev-test-"))
  await mkdir(join(scratch, "bin"))
  await writeFile(
    join(scratch, "bin/bun"),
    '#!/bin/sh\nprintf "%s\\n" "$ITER8_HOME" "$ITER8_POOL" "$@"\n',
  )
  await chmod(join(scratch, "bin/bun"), 0o755)
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

async function launch(script: string, env: Record<string, string>): Promise<string[]> {
  const child = Bun.spawn([script, "status", "--json"], {
    env: { PATH: `${join(scratch, "bin")}:/usr/bin:/bin`, HOME: join(scratch, "home"), ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  expect(code).toBe(0)
  return out.trimEnd().split("\n")
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
