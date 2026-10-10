import { expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { fixtureDir, MANIFEST, startFixture } from "../../rig/fixtures"
import { WORKER } from "../../rig/ports"
import { waitFor } from "../../rig/wait"

const FIXTURES_MODULE = Bun.fileURLToPath(new URL("../../rig/fixtures.ts", import.meta.url))
const TIMEOUT_MS = 240_000

const OTHER_PROCESS = `
import { startFixture } from ${JSON.stringify(FIXTURES_MODULE)}
const running = await startFixture("next-webpack")
try {
  const response = await fetch(running.url("/"))
  console.log(JSON.stringify({ status: response.status, body: await response.text() }))
  for await (const _ of console) break
} finally {
  await running.stop()
}
`

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ""
  try {
    while (!text.includes("\n")) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
  return text.split("\n")[0] ?? ""
}

async function distDirsOf(pids: number[]): Promise<string[]> {
  const names = await readdir(fixtureDir("next-webpack"))
  return names.filter((name) => pids.some((pid) => name.startsWith(`.next-p${pid}-`))).sort()
}

test(
  "two processes run next-webpack at once, each ready and serving the page, each with its own distDir",
  async () => {
    const target = MANIFEST.find((entry) => entry.name === "next-webpack")?.targets[0]
    if (!target) throw new Error("fixtures/manifest.json has no next-webpack target")
    const child = Bun.spawn(["bun", "-e", OTHER_PROCESS], {
      env: { ...process.env, BUN_TEST_WORKER_ID: String(WORKER) },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    try {
      const ours = startFixture("next-webpack")
      const theirs = firstLine(child.stdout)
      const [running, line] = await Promise.all([ours, theirs])
      try {
        if (line === "") {
          throw new Error(
            `the other process never became ready:\n${await new Response(child.stderr).text()}`,
          )
        }
        const other = JSON.parse(line) as { status: number; body: string }
        const own = await fetch(running.url("/"))
        const ownBody = await own.text()
        expect({ own: own.status, other: other.status }).toEqual({ own: 200, other: 200 })
        expect(ownBody).toContain(`data-source-target="${target}"`)
        expect(other.body).toContain(`data-source-target="${target}"`)
        expect(await distDirsOf([process.pid, child.pid])).toHaveLength(2)
      } finally {
        await running.stop()
      }
    } finally {
      child.stdin.write("stop\n")
      await child.stdin.end()
      await waitFor(
        "the other process to exit",
        async () => (child.exitCode === null ? null : true),
        {
          timeoutMs: 30_000,
        },
      )
    }
    expect(child.exitCode).toBe(0)
    expect(await distDirsOf([process.pid, child.pid])).toEqual([])
  },
  TIMEOUT_MS,
)
