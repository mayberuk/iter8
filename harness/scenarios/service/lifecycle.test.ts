import { afterEach, expect, test } from "bun:test"
import { join } from "node:path"
import { ExitCode, OpenResult, ServiceStatus } from "@iter8/protocol"
import { type CliEnv, runCli } from "../../rig/cli"
import { fixtureDir } from "../../rig/fixtures"
import { throwawayHome } from "../../rig/home"
import { poolRange } from "../../rig/ports"
import type { Scratch } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"

const homes: Scratch[] = []

async function lockPid(home: string): Promise<number | null> {
  try {
    return JSON.parse(await Bun.file(join(home, "service.lock")).text()).pid
  } catch {
    return null
  }
}

afterEach(async () => {
  for (const home of homes.splice(0)) {
    const pid = await lockPid(home.path)
    if (pid !== null && alive(pid)) {
      process.kill(pid, "SIGTERM")
      await waitFor(`service ${pid} to exit`, async () => (alive(pid) ? null : true), {
        timeoutMs: 15_000,
      }).catch(() => process.kill(pid, "SIGKILL"))
    }
    await home.dispose()
  }
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function freshEnv(): Promise<CliEnv> {
  const home = await throwawayHome()
  homes.push(home)
  return { home: home.path, pool: await poolRange(4) }
}

async function statusPid(env: CliEnv): Promise<number> {
  const run = await runCli(env, ["status", "--json"])
  expect(run.exitCode).toBe(ExitCode.ok)
  return run.json(ServiceStatus).pid
}

test("status starts nothing: with no service it exits 5", async () => {
  const env = await freshEnv()
  const run = await runCli(env, ["status", "--json"])
  expect(run.exitCode).toBe(ExitCode.serviceUnavailable)
})

test("two CLI commands that start the service at once leave exactly one service", async () => {
  const env = await freshEnv()
  const target = fixtureDir("static")

  const [first, second] = await Promise.all([
    runCli(env, ["open", target, "--json"]),
    runCli(env, ["open", target, "--json"]),
  ])
  expect(first.exitCode).toBe(ExitCode.ok)
  expect(second.exitCode).toBe(ExitCode.ok)
  expect(first.json(OpenResult).page.id).toBe(second.json(OpenResult).page.id)

  const pid = await statusPid(env)
  expect(alive(pid)).toBe(true)
  expect(await lockPid(env.home)).toBe(pid)
  expect(await statusPid(env)).toBe(pid)
}, 60_000)

test("the service a CLI run started keeps answering after that CLI exits", async () => {
  const env = await freshEnv()
  const target = fixtureDir("static")

  const opened = await runCli(env, ["open", target, "--json"])
  expect(opened.exitCode).toBe(ExitCode.ok)

  const pid = await statusPid(env)
  expect(alive(pid)).toBe(true)

  const again = await runCli(env, ["open", target, "--json"])
  expect(again.exitCode).toBe(ExitCode.ok)
  expect(again.json(OpenResult).page.id).toBe(opened.json(OpenResult).page.id)
  expect(await statusPid(env)).toBe(pid)
}, 60_000)
