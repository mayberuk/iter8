import { expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { WORKER } from "./ports"
import { scratchDir } from "./scratch"

const portsModule = new URL("./ports.ts", import.meta.url).href
const FIRST = 21000

async function withClaimsDir<T>(run: (claims: string) => Promise<T>): Promise<T> {
  const scratch = await scratchDir(`/tmp/iter8-w${WORKER}-claims-`)
  try {
    return await run(join(scratch.path, "claims"))
  } finally {
    await scratch.dispose()
  }
}

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ""
  while (!text.includes("\n")) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value)
  }
  return text.split("\n")[0] ?? ""
}

function allocator(claims: string, code: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { nextPort, poolRange } = await import(${JSON.stringify(portsModule)}); ${code}`,
    ],
    {
      env: { ...process.env, BUN_TEST_WORKER_ID: "1", ITER8_PORT_CLAIMS_DIR: claims },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [whole, head] = child.stdout.tee()
  const result = Promise.all([
    new Response(whole).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }))
  return { child, result, firstLine: () => firstLine(head) }
}

async function runAllocator(claims: string, code: string) {
  const { stdout, stderr, exitCode } = await allocator(claims, code).result
  expect(stderr).toBe("")
  expect(exitCode).toBe(0)
  return JSON.parse(stdout)
}

async function sleeper() {
  const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(120000)"], {
    stdout: "ignore",
    stderr: "ignore",
  })
  return {
    pid: child.pid,
    stop: async () => {
      child.kill()
      await child.exited
    },
  }
}

test("two processes with the same worker id allocate disjoint ports at the same time", async () => {
  await withClaimsDir(async (claims) => {
    const goAt = Date.now() + 1500
    const code = `
      while (Date.now() < ${goAt}) await Bun.sleep(1);
      const ports = [];
      for (let i = 0; i < 10; i++) ports.push(await nextPort());
      const pool = await poolRange(4);
      console.log(JSON.stringify({ ports, pool }));
      await Bun.stdin.text();
    `
    const children = [allocator(claims, code), allocator(claims, code)]
    try {
      const lines = await Promise.all(children.map((entry) => entry.firstLine()))
      const [leftPorts, rightPorts] = lines.map((line) => {
        const { ports, pool } = JSON.parse(line) as { ports: number[]; pool: string }
        const [first, last] = pool.split("-").map(Number) as [number, number]
        return [...ports, ...Array.from({ length: last - first + 1 }, (_, i) => first + i)]
      }) as [number[], number[]]
      expect(new Set(leftPorts).size).toBe(14)
      expect(new Set(rightPorts).size).toBe(14)
      expect(leftPorts.filter((port) => rightPorts.includes(port))).toEqual([])
    } finally {
      for (const { child } of children) child.stdin.end()
      await Promise.all(children.map(({ result }) => result))
    }
  })
}, 30000)

test("a claim naming a dead pid is reclaimed and its file replaced", async () => {
  await withClaimsDir(async (claims) => {
    const dead = await sleeper()
    await dead.stop()
    await Bun.write(join(claims, String(FIRST)), String(dead.pid))
    const seen = await runAllocator(
      claims,
      `
      const port = await nextPort();
      const owner = Number(await Bun.file(${JSON.stringify(join(claims, String(FIRST)))}).text());
      console.log(JSON.stringify({ port, owner, pid: process.pid }));
    `,
    )
    expect(seen.port).toBe(FIRST)
    expect(seen.owner).toBe(seen.pid)
  })
})

test("a claim held by a live process is skipped", async () => {
  await withClaimsDir(async (claims) => {
    const holder = await sleeper()
    try {
      await Bun.write(join(claims, String(FIRST)), String(holder.pid))
      await Bun.write(join(claims, String(FIRST + 2)), String(holder.pid))
      const seen = await runAllocator(
        claims,
        `console.log(JSON.stringify({ port: await nextPort(), pool: await poolRange(2) }))`,
      )
      expect(seen.port).toBe(FIRST + 1)
      expect(seen.pool).toBe(`${FIRST + 3}-${FIRST + 4}`)
      expect(await readFile(join(claims, String(FIRST)), "utf8")).toBe(String(holder.pid))
    } finally {
      await holder.stop()
    }
  })
})

test("a process removes the claims it made when it exits and leaves other claims alone", async () => {
  await withClaimsDir(async (claims) => {
    const holder = await sleeper()
    try {
      const foreign = String(FIRST + 90)
      await Bun.write(join(claims, foreign), String(holder.pid))
      const seen = await runAllocator(
        claims,
        `
        const { readdirSync } = await import("node:fs");
        const port = await nextPort();
        const pool = await poolRange(3);
        console.log(JSON.stringify({ port, pool, during: readdirSync(${JSON.stringify(claims)}).sort() }));
      `,
      )
      expect(seen.during).toEqual(
        [FIRST, FIRST + 1, FIRST + 2, FIRST + 3, FIRST + 90].map(String).sort(),
      )
      expect(await readdir(claims)).toEqual([foreign])
    } finally {
      await holder.stop()
    }
  })
})
