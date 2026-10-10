import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { Subprocess } from "bun"
import { parseLinuxStat, processAncestry, readProcessStart } from "./process-identity"

const children: Subprocess[] = []
const chains: Subprocess<"pipe", "pipe", "ignore">[] = []

afterEach(async () => {
  for (const chain of chains.splice(0)) {
    chain.stdin.end()
    await chain.exited
  }
  for (const child of children.splice(0)) {
    child.kill()
    await child.exited
  }
})

function spawnChild() {
  const child = Bun.spawn(["sleep", "30"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
  children.push(child)
  return child
}

const numericFields = "456 123 123 0 -1 4194304 10 0 0 0 1 2 0 0 20 0 1 0 9876543210123456789"
const validStat = `123 (sleep) S ${numericFields} 4096 1\n`

describe("parseLinuxStat", () => {
  test("reads the parent and preserves start ticks without numeric rounding", () => {
    expect(parseLinuxStat(validStat)).toEqual({ ppid: 456, startTicks: "9876543210123456789" })
  })

  test("finds fields after the last closing parenthesis in a command with spaces and parentheses", () => {
    expect(parseLinuxStat(`123 (worker (background) job)) S ${numericFields}`)).toEqual({
      ppid: 456,
      startTicks: "9876543210123456789",
    })
  })

  test("accepts pid 1's parent of zero", () => {
    expect(parseLinuxStat(`1 (init) S ${numericFields.replace(/^456/, "0")}`)?.ppid).toBe(0)
  })

  test.each([
    "",
    "123 (sleep)",
    "123 (sleep S 456",
    "123 sleep) S 456",
    validStat.replace(/^123/, "bad"),
    validStat.replace(") S ", ")S "),
    validStat.replace(") S ", ") invalid "),
    validStat.replace("S 456", "S -1"),
    validStat.replace("S 456", "S parent"),
    validStat.replace("S 456", "S 9007199254740992"),
    validStat.replace("9876543210123456789", "ticks"),
    validStat.replace("9876543210123456789", "-1"),
    validStat.replace("9876543210123456789", "1.5"),
    validStat.replace("4194304", "bad"),
    `123 (sleep) S ${numericFields.split(" ").slice(0, -1).join(" ")}`,
  ])("returns null for malformed or truncated stat text: %s", (stat) => {
    expect(parseLinuxStat(stat)).toBeNull()
  })
})

describe("process identity", () => {
  test("a running child has a stable non-null start and no identity after being reaped", async () => {
    const child = spawnChild()
    const startedAt = readProcessStart(child.pid)
    expect(startedAt).not.toBeNull()
    expect(readProcessStart(child.pid)).toBe(startedAt)
    if (process.platform === "linux") {
      const bootTime = /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1]
      expect(bootTime).toBeDefined()
      expect(startedAt).toMatch(new RegExp(`^linux:${bootTime}:\\d+$`))
    } else if (process.platform === "darwin") {
      expect(startedAt).toMatch(/^darwin:\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/)
    }
    child.kill()
    await child.exited
    expect(readProcessStart(child.pid)).toBeNull()
    expect(processAncestry(child.pid)).toEqual([])
  })

  test("ancestry starts with the child followed by the test process", () => {
    const child = spawnChild()
    const ancestry = processAncestry(child.pid)
    expect(ancestry[0]?.pid).toBe(child.pid)
    expect(ancestry[0]?.startedAt).toBe(readProcessStart(child.pid) ?? undefined)
    expect(ancestry[1]?.pid).toBe(process.pid)
    expect(ancestry[1]?.startedAt).toBe(readProcessStart(process.pid) ?? undefined)
    expect(ancestry.every((entry) => entry.pid > 0 && entry.startedAt.length > 0)).toBe(true)
  })

  test("ancestry stops at 64 entries, nearest first, on a chain of 70 nested shells", async () => {
    const chainScript =
      'if [ "$1" -gt 0 ]; then sh -c "$CHAIN_SCRIPT" sh $(($1 - 1)); exit $?; fi; echo $$; cat'
    const chain = Bun.spawn(["sh", "-c", chainScript, "sh", "70"], {
      env: { ...process.env, CHAIN_SCRIPT: chainScript },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    })
    chains.push(chain)
    const { value } = await chain.stdout.getReader().read()
    const leafPid = Number(new TextDecoder().decode(value).trim())
    expect(Number.isSafeInteger(leafPid)).toBe(true)

    const ancestry = processAncestry(leafPid)
    expect(ancestry).toHaveLength(64)
    expect(ancestry[0]?.pid).toBe(leafPid)
    expect(new Set(ancestry.map((entry) => entry.pid)).size).toBe(64)
    expect(ancestry.some((entry) => entry.pid === process.pid)).toBe(false)
  }, 15_000)

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "invalid pid %s has no identity or ancestry",
    (pid) => {
      expect(readProcessStart(pid)).toBeNull()
      expect(processAncestry(pid)).toEqual([])
    },
  )
})
