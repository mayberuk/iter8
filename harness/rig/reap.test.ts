import { expect, test } from "bun:test"
import { waitFor } from "./wait"

const probe = Bun.fileURLToPath(new URL("./reap-probe.ts", import.meta.url))
const START_TIMEOUT_MS = 60_000
const GONE_TIMEOUT_MS = 10_000

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function startOrphanable(mode: "exit" | "hang") {
  const child = Bun.spawn([process.execPath, probe, mode], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  })
  const reader = child.stdout.getReader()
  let line = ""
  const decoder = new TextDecoder()
  const servicePid = await waitFor(
    "the probe to print the service pid",
    async () => {
      const { value, done } = await reader.read()
      if (value !== undefined) line += decoder.decode(value, { stream: true })
      if (line.includes("\n")) return Number(line.trim())
      if (done) throw new Error(`the probe exited before printing a pid (exit ${child.exitCode})`)
      return null
    },
    { timeoutMs: START_TIMEOUT_MS, everyMs: 10 },
  )
  expect(alive(servicePid)).toBe(true)
  return { child, servicePid }
}

const serviceGone = (pid: number) =>
  waitFor(`service ${pid} to be killed`, async () => (alive(pid) ? null : true), {
    timeoutMs: GONE_TIMEOUT_MS,
    everyMs: 50,
  })

test("a service started through the rig dies when its process exits without running teardown", async () => {
  const { child, servicePid } = await startOrphanable("exit")
  try {
    await child.exited
    await serviceGone(servicePid)
  } finally {
    if (alive(servicePid)) process.kill(servicePid, "SIGKILL")
  }
}, 120_000)

test("a service started through the rig dies when its process is killed outright", async () => {
  const { child, servicePid } = await startOrphanable("hang")
  try {
    child.kill("SIGKILL")
    await child.exited
    await serviceGone(servicePid)
  } finally {
    if (alive(servicePid)) process.kill(servicePid, "SIGKILL")
  }
}, 120_000)
