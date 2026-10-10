import { expect, spyOn, test } from "bun:test"
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import fc from "fast-check"
import { chromium } from "playwright"
import { launchChromium, newPage } from "../../rig/browser"
import { throwawayHome } from "../../rig/home"
import { nextPort, portBlock, WORKER } from "../../rig/ports"
import { scratchDir } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

const portsModule = new URL("../../rig/ports.ts", import.meta.url).href
const firstPortOf = (worker: number) => 21000 + 100 * (worker - 1)

async function runAllocator(code: string, worker: string | null = String(WORKER)) {
  const env = { ...process.env }
  if (worker === null) delete env.BUN_TEST_WORKER_ID
  else env.BUN_TEST_WORKER_ID = worker
  const claims = await scratchDir(`/tmp/iter8-w${WORKER}-claims-`)
  env.ITER8_PORT_CLAIMS_DIR = claims.path
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
    const { nextPort, poolRange, WORKER } = await import(${JSON.stringify(portsModule)});
    ${code}
  `,
      ],
      {
        env,
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, stderr, exitCode }
  } finally {
    await claims.dispose()
  }
}

test("distinct workers have disjoint 100-port blocks below the ephemeral range and outside service pools", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 117 }),
      fc.integer({ min: 1, max: 117 }),
      (left, right) => {
        const a = portBlock(left)
        const b = portBlock(right)
        expect(a).toEqual({ first: 21000 + 100 * (left - 1), last: 21099 + 100 * (left - 1) })
        for (const block of [a, b]) {
          expect(block.last - block.first + 1).toBe(100)
          expect(block.last).toBeLessThan(32768)
          expect(block.first).toBeGreaterThan(3993)
        }
        if (left !== right) expect(a.last < b.first || b.last < a.first).toBe(true)
      },
    ),
  )
})

test("invalid worker ids and blocks reaching the ephemeral range are rejected", async () => {
  for (const worker of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 118]) {
    expect(() => portBlock(worker)).toThrow("BUN_TEST_WORKER_ID")
  }
  for (const worker of ["0", "-1", "1.5", "invalid", "", "118"]) {
    const result = await runAllocator("", worker)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("BUN_TEST_WORKER_ID")
  }
  const result = await runAllocator("console.log(WORKER)", null)
  expect(result.exitCode).toBe(0)
  expect(result.stdout.trim()).toBe("1")
})

test("pools and individual allocations share one consecutive block without repeating, then wrap", async () => {
  const result = await runAllocator(`
    const firstPool = await poolRange(4);
    const firstPort = await nextPort();
    const secondPool = await poolRange(4);
    const remaining = await Promise.all(Array.from({ length: 91 }, () => nextPort()));
    const wrapped = await nextPort();
    const wrappedPool = await poolRange(3);
    console.log(JSON.stringify({ firstPool, firstPort, secondPool, remaining, wrapped, wrappedPool }));
  `)
  expect(result.stderr).toBe("")
  expect(result.exitCode).toBe(0)
  const data = JSON.parse(result.stdout) as {
    firstPool: string
    firstPort: number
    secondPool: string
    remaining: number[]
    wrapped: number
    wrappedPool: string
  }
  const first = 21000 + 100 * (WORKER - 1)
  expect(data.firstPool).toBe(`${first}-${first + 3}`)
  expect(data.firstPort).toBe(first + 4)
  expect(data.secondPool).toBe(`${first + 5}-${first + 8}`)
  expect(data.remaining).toEqual(Array.from({ length: 91 }, (_, index) => first + 9 + index))
  expect(new Set([data.firstPort, ...data.remaining]).size).toBe(92)
  expect(data.wrapped).toBe(first)
  expect(data.wrappedPool).toBe(`${first + 1}-${first + 3}`)
})

test("a pool never straddles the end of the block and is placed after wrapping instead", async () => {
  const first = firstPortOf(116)
  const result = await runAllocator(
    `
    const head = await poolRange(98);
    const pool = await poolRange(5);
    console.log(JSON.stringify({ head, pool }));
  `,
    "116",
  )
  expect(result.stderr).toBe("")
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({
    head: `${first}-${first + 97}`,
    pool: `${first}-${first + 4}`,
  })
})

test("allocation skips ports that are held and a pool needs a fully free run", async () => {
  const held = await nextPort()
  const server = Bun.serve({ hostname: "127.0.0.1", port: held, fetch: () => new Response("held") })
  try {
    const result = await runAllocator(`
      let failure = "";
      try { await poolRange(100); } catch (error) { failure = error.message; }
      const pool = await poolRange(3);
      console.log(JSON.stringify({ failure, pool }));
    `)
    expect(result.stderr).toBe("")
    expect(result.exitCode).toBe(0)
    const data = JSON.parse(result.stdout) as { failure: string; pool: string }
    const first = firstPortOf(WORKER)
    const block = `${first}-${first + 99}`
    expect(data.failure).toBe(`Port block ${block} exhausted for worker ${WORKER}`)
    const [start, end] = data.pool.split("-").map(Number) as [number, number]
    expect(end - start).toBe(2)
    expect(start).toBeGreaterThanOrEqual(first)
    expect(end).toBeLessThanOrEqual(first + 99)
    expect(held < start || held > end).toBe(true)
  } finally {
    await server.stop(true)
  }
})

test("child processes under two explicit worker ids allocate from disjoint blocks", async () => {
  const code = `console.log(JSON.stringify({ worker: WORKER, pool: await poolRange(3), port: await nextPort() }))`
  const [left, right] = await Promise.all([runAllocator(code, "116"), runAllocator(code, "117")])
  for (const [result, worker] of [
    [left, 116],
    [right, 117],
  ] as const) {
    expect(result.stderr).toBe("")
    expect(result.exitCode).toBe(0)
    const first = firstPortOf(worker)
    expect(JSON.parse(result.stdout)).toEqual({
      worker,
      pool: `${first}-${first + 2}`,
      port: first + 3,
    })
  }
  expect(firstPortOf(116) + 99).toBeLessThan(firstPortOf(117))
})

test("a pool of exactly the whole block succeeds, the next port wraps and one port more is refused", async () => {
  const first = firstPortOf(116)
  const whole = await runAllocator(
    `
    const pool = await poolRange(100);
    const after = await nextPort();
    console.log(JSON.stringify({ pool, after }));
  `,
    "116",
  )
  expect(whole.stderr).toBe("")
  expect(whole.exitCode).toBe(0)
  const data = JSON.parse(whole.stdout) as { pool: string; after: number }
  expect(data.pool).toBe(`${first}-${first + 99}`)
  expect(data.after).toBe(first)

  const oversized = await runAllocator(
    `
    let message = "";
    try { await poolRange(101); } catch (error) { message = error.message; }
    console.log(message);
  `,
    "116",
  )
  expect(oversized.exitCode).toBe(0)
  expect(oversized.stdout.trim()).toBe(`Port block ${first}-${first + 99} exhausted for worker 116`)
})

test("nextPort skips a held port and cycles through the rest of the block", async () => {
  const held = await nextPort()
  const server = Bun.serve({ hostname: "127.0.0.1", port: held, fetch: () => new Response("held") })
  try {
    const result = await runAllocator(`
      const granted = [];
      for (let index = 0; index < 250; index++) granted.push(await nextPort());
      console.log(JSON.stringify(granted));
    `)
    expect(result.stderr).toBe("")
    expect(result.exitCode).toBe(0)
    const granted = JSON.parse(result.stdout) as number[]
    const first = firstPortOf(WORKER)
    const others = Array.from({ length: 100 }, (_, index) => first + index).filter(
      (port) => port !== held,
    )
    expect(granted).toEqual(Array.from({ length: 250 }, (_, index) => others[index % 99] as number))
  } finally {
    await server.stop(true)
  }
})

test("a fully held block throws naming the block and worker, and a single free port is found repeatedly", async () => {
  const worker = 117
  const first = firstPortOf(worker)
  const spare = first + 41
  const servers = Array.from({ length: 100 }, (_, index) => first + index)
    .filter((port) => port !== spare)
    .map((port) => Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("held") }))
  try {
    const result = await runAllocator(
      `
      const granted = [await nextPort(), await nextPort(), await nextPort()];
      console.log(JSON.stringify(granted));
    `,
      String(worker),
    )
    expect(result.stderr).toBe("")
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([spare, spare, spare])

    servers.push(
      Bun.serve({ hostname: "127.0.0.1", port: spare, fetch: () => new Response("held") }),
    )
    const exhausted = await runAllocator(
      `
      const messages = [];
      for (const attempt of [() => nextPort(), () => poolRange(1), () => poolRange(2)]) {
        try { await attempt(); messages.push("granted"); } catch (error) { messages.push(error.message); }
      }
      console.log(JSON.stringify(messages));
    `,
      String(worker),
    )
    expect(exhausted.stderr).toBe("")
    expect(exhausted.exitCode).toBe(0)
    const message = `Port block ${first}-${first + 99} exhausted for worker ${worker}`
    expect(JSON.parse(exhausted.stdout)).toEqual([message, message, message])
  } finally {
    await Promise.all(servers.map((server) => server.stop(true)))
  }
})

test("a long run of allocate, bind and release cycles never exhausts the block", async () => {
  const first = firstPortOf(116)
  const result = await runAllocator(
    `
    const seen = new Set();
    for (let cycle = 0; cycle < 250; cycle++) {
      const port = await nextPort();
      const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") });
      seen.add(port);
      await server.stop(true);
    }
    console.log(JSON.stringify({ count: seen.size, min: Math.min(...seen), max: Math.max(...seen) }));
  `,
    "116",
  )
  expect(result.stderr).toBe("")
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ count: 100, min: first, max: first + 99 })
})

test("invalid pool sizes do not consume any ports", async () => {
  const result = await runAllocator(`
    for (const size of [0, -1, 1.5, Infinity, NaN]) {
      try { await poolRange(size); throw new Error("Accepted invalid size"); }
      catch (error) { if (!error.message.includes("positive integer")) throw error; }
    }
    console.log(await nextPort());
  `)
  expect(result.exitCode).toBe(0)
  expect(result.stdout.trim()).toBe(String(21000 + 100 * (WORKER - 1)))
})

test("waitFor returns the first non-null value, including falsy values", async () => {
  for (const expected of [0, false, "", { ready: true }]) {
    let reads = 0
    const result = await waitFor("ready value", async () => (++reads < 3 ? null : expected), {
      timeoutMs: 1000,
      everyMs: 1,
    })
    expect(result).toBe(expected)
    expect(reads).toBe(3)
  }
})

test("waitFor propagates a reader error immediately without retrying", async () => {
  const error = new Error("read failed")
  let reads = 0
  await expect(
    waitFor(
      "failing reader",
      async () => {
        reads++
        throw error
      },
      { timeoutMs: 1000 },
    ),
  ).rejects.toBe(error)
  expect(reads).toBe(1)
})

test("waitFor timeout names the condition, timeout and last value", async () => {
  await expect(
    waitFor("agent ready", async () => null, {
      timeoutMs: 10,
      everyMs: 1,
    }),
  ).rejects.toThrow("agent ready after 10 ms; last value: null")
})

test("waitFor polls no sooner than everyMs apart and keeps polling until it succeeds", async () => {
  const stamps: number[] = []
  await waitFor(
    "fourth read",
    async () => {
      stamps.push(performance.now())
      return stamps.length < 4 ? null : true
    },
    { timeoutMs: 5000, everyMs: 100 },
  )
  expect(stamps).toHaveLength(4)
  for (let index = 1; index < stamps.length; index++) {
    const gap = (stamps[index] ?? 0) - (stamps[index - 1] ?? 0)
    expect(gap).toBeGreaterThanOrEqual(90)
    expect(gap).toBeLessThan(500)
  }
})

test("waitFor gives up after timeoutMs, not before and not much later, even with a longer interval", async () => {
  for (const { timeoutMs, everyMs } of [
    { timeoutMs: 300, everyMs: 20 },
    { timeoutMs: 300, everyMs: 5000 },
  ]) {
    const started = performance.now()
    await expect(waitFor("never ready", async () => null, { timeoutMs, everyMs })).rejects.toThrow(
      `never ready after ${timeoutMs} ms`,
    )
    const elapsed = performance.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 10)
    expect(elapsed).toBeLessThan(timeoutMs + 700)
  }
})

test("throwawayHome leaves the contents of earlier homes untouched until their owner disposes them", async () => {
  const earlier = await throwawayHome()
  const later = await throwawayHome()
  try {
    await mkdir(`${earlier.path}/nested`)
    await writeFile(`${earlier.path}/nested/keep.txt`, "kept")
    await writeFile(`${earlier.path}/top.txt`, "also kept")
    expect(later.path).not.toBe(earlier.path)
    expect(await readdir(later.path)).toEqual([])
    await later.dispose()
    expect(await exists(later.path)).toBe(false)
    expect((await readdir(earlier.path)).sort()).toEqual(["nested", "top.txt"])
    expect(await readFile(`${earlier.path}/nested/keep.txt`, "utf8")).toBe("kept")
    expect(await readFile(`${earlier.path}/top.txt`, "utf8")).toBe("also kept")
  } finally {
    await earlier.dispose()
    await later.dispose()
  }
  expect(await exists(earlier.path)).toBe(false)
})

test("throwaway homes are distinct empty directories with short control socket paths", async () => {
  const homes = await Promise.all([throwawayHome(), throwawayHome()])
  try {
    expect(new Set(homes.map((home) => home.path)).size).toBe(2)
    for (const { path } of homes) {
      expect(path).toMatch(new RegExp(`^/tmp/iter8-w${WORKER}-[a-zA-Z0-9]{6}$`))
      expect(await readdir(path)).toEqual([])
      expect(Buffer.byteLength(`${path}/control.sock`)).toBeLessThan(100)
    }
  } finally {
    await Promise.all(homes.map((home) => home.dispose()))
  }
})

test("newPage isolates contexts and collects console and uncaught page errors", async () => {
  const browser = await launchChromium()
  try {
    const first = await newPage(browser)
    const second = await newPage(browser)
    try {
      expect(first.page.context()).not.toBe(second.page.context())
      await first.page.evaluate(() => console.error("console failure"))
      await first.page.addScriptTag({ content: 'throw new Error("page failure")' })
      await waitFor(
        "both browser errors",
        async () => (first.errors.length === 2 ? first.errors : null),
        {
          timeoutMs: 1000,
        },
      )
      expect(first.errors).toEqual(["console failure", "page failure"])
      expect(second.errors).toEqual([])
      await first.close()
      expect(first.page.isClosed()).toBe(true)
      expect(second.page.isClosed()).toBe(false)
    } finally {
      await first.close()
      await second.close()
    }
  } finally {
    await browser.close()
  }
}, 15000)

test("launchChromium launches headless with exactly the caller's args and no others", async () => {
  const launch = spyOn(chromium, "launch")
  try {
    const plain = await launchChromium()
    await plain.close()
    const custom = await launchChromium({ args: ["--lang=en-GB", "--mute-audio"] })
    await custom.close()
    expect(launch.mock.calls).toEqual([
      [{ headless: true, args: [] }],
      [{ headless: true, args: ["--lang=en-GB", "--mute-audio"] }],
    ])
  } finally {
    launch.mockRestore()
  }
}, 15000)

test("launchChromium runs a headless browser that honours a caller flag", async () => {
  const agent = "iter8-launch-probe/1"
  const defaults = await launchChromium()
  const flagged = await launchChromium({ args: [`--user-agent=${agent}`] })
  try {
    const first = await newPage(defaults)
    const second = await newPage(flagged)
    try {
      expect(await first.page.evaluate(() => navigator.userAgent)).toContain("HeadlessChrome")
      expect(await second.page.evaluate(() => navigator.userAgent)).toBe(agent)
    } finally {
      await first.close()
      await second.close()
    }
  } finally {
    await defaults.close()
    await flagged.close()
  }
}, 15000)
