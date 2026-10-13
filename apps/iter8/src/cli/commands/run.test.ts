import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ExitCode } from "@iter8/protocol"
import { runCommand } from "citty"
import type { Clock } from "../../connect/supervisor"
import { readProcessStart } from "../../pairing/process-identity"
import type { CliDeps } from "../client"
import { type DevServer, liveSystem, type RunSystem, run } from "./run"
import { fnv1a, stablePort } from "./run-plan"

const PAGE_URL = "http://p1.localhost:3990/"
const SERVE = `Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch: () => new Response("ok") }); console.log("listening")`

const directories: string[] = []
const groups: number[] = []

afterEach(async () => {
  for (const pid of groups.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {}
  }
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "iter8-run-")))
  directories.push(path)
  return path
}

async function freeTestPort(): Promise<number> {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const { port } = listener
  listener.stop(true)
  return port
}

async function until<T>(label: string, read: () => T | null | Promise<T | null>): Promise<T> {
  const deadline = performance.now() + 10_000
  for (;;) {
    const value = await read()
    if (value !== null) return value
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await Bun.sleep(20)
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const ambient = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => name !== "SSH_CONNECTION" && name !== "SSH_TTY"),
)

type Signal = "SIGINT" | "SIGTERM" | "SIGHUP"

type Options = {
  cwd?: string
  home?: string
  cliPid?: number
  probe?: RunSystem["probe"]
  env?: Record<string, string>
  platform?: "linux" | "darwin"
  laptops?: string[]
  launches?: boolean
  clock?: Clock
  portFree?: RunSystem["portFree"]
  open?: RunSystem["open"]
}

function setup(options: Options = {}) {
  const home = options.home ?? realpathSync(mkdtempSync(join(tmpdir(), "iter8-run-home-")))
  if (options.home === undefined) directories.push(home)
  const stdout: string[] = []
  const stderr: string[] = []
  const exits: number[] = []
  const deps: CliDeps = {
    connect: async () => {
      throw new Error("run must reach the service only through the system's open")
    },
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    exit: (code) => exits.push(code),
    cwd: options.cwd ?? "/",
    pid: options.cliPid ?? process.pid,
    ancestry: () => [],
    processStart: readProcessStart,
    readStdin: async () => "",
    makeTempDir: async () => {
      throw new Error("unused")
    },
    version: "0.0.0",
  }
  const base = liveSystem(deps, {})
  const spawned: {
    argv: string[]
    cwd: string
    env: Record<string, string | undefined>
    child: DevServer
  }[] = []
  const launched: string[][] = []
  const opened: { target: unknown; cwd: string }[] = []
  let interrupt: ((signal: Signal) => void) | null = null
  const system: RunSystem = {
    ...base,
    env: { ...ambient, ITER8_HOME: home, ...options.env },
    platform: options.platform ?? "linux",
    hostname: "devbox-7",
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.portFree ? { portFree: options.portFree } : {}),
    ...(options.probe ? { probe: options.probe } : {}),
    spawn: (argv, spawnOptions) => {
      const child = base.spawn(argv, spawnOptions)
      groups.push(child.pid)
      spawned.push({ argv, cwd: spawnOptions.cwd, env: spawnOptions.env, child })
      return child
    },
    launch: (argv) => {
      launched.push(argv)
      return options.launches ?? true
    },
    onInterrupt: (stop) => {
      interrupt = stop
    },
    open:
      options.open ??
      (async (target, cwd) => {
        opened.push({ target, cwd })
        return { url: PAGE_URL, laptops: options.laptops ?? [] }
      }),
  }
  const command = run(deps, system)
  return {
    home,
    stdout,
    stderr,
    exits,
    spawned,
    launched,
    opened,
    out: () => stdout.join(""),
    err: () => stderr.join(""),
    start: (rawArgs: string[]) => runCommand(command, { rawArgs }),
    interrupt(signal: Signal) {
      if (interrupt === null) throw new Error("run registered no interrupt handler")
      interrupt(signal)
    },
  }
}

const recordFile = (home: string, root: string) =>
  join(home, "run", `${fnv1a(root).toString(16).padStart(8, "0")}.pid`)

const readRecord = async (home: string, root: string) =>
  JSON.parse(await readFile(recordFile(home, root), "utf8").catch(() => "null"))

/** Advances only while `moving` holds, so a deadline cannot pass before the child has spoken. */
function fakeClock(moving: () => boolean): Clock & { now(): number } {
  let now = 0
  return {
    now: () => now,
    setTimeout: (callback, ms) => {
      if (moving()) now += ms
      return setTimeout(callback, 1)
    },
    clearTimeout,
  }
}

describe("a dev server", () => {
  test("runs the dev script with the detected package manager, port flags and PORT, then opens a proxied page", async () => {
    const workspace = await tempDir()
    await writeFile(join(workspace, "bun.lock"), "{}")
    const dir = join(workspace, "app")
    await mkdir(dir)
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: { dev: `bun -e '${SERVE}'` },
        devDependencies: { vite: "8.3.4" },
      }),
    )
    const port = await freeTestPort()
    const state = setup()
    const pending = state.start([dir, "--port", String(port)])
    await until("the page to open", () => state.opened[0] ?? null)

    expect(state.spawned.map(({ argv, cwd }) => ({ argv, cwd }))).toEqual([
      { argv: ["bun", "run", "dev", "--port", String(port), "--strictPort"], cwd: dir },
    ])
    expect(state.spawned[0]?.env.PORT).toBe(String(port))
    expect(state.opened).toEqual([
      { target: { kind: "server", upstream: `http://127.0.0.1:${port}/` }, cwd: dir },
    ])
    expect(state.out()).toStartWith(
      `Starting bun run dev --port ${port} --strictPort on port ${port}…\n`,
    )
    expect(state.out()).toContain("listening\n")
    expect(state.out()).toContain(`\n${PAGE_URL}\nOpened in your browser.\n`)

    state.interrupt("SIGINT")
    await pending
    expect(state.exits).toEqual([130])
  })

  test("a server that ignores PORT is found at the loopback URL it prints", async () => {
    const dir = await tempDir()
    const port = await freeTestPort()
    const printedPort = await freeTestPort()
    const state = setup()
    const pending = state.start([
      dir,
      "--port",
      String(port),
      "--",
      "bun",
      "-e",
      `Bun.serve({ hostname: "127.0.0.1", port: ${printedPort}, fetch: () => new Response("ok") }); console.log("\\u001b[36m  Local: http://localhost:${printedPort}/\\u001b[39m")`,
    ])
    await until("the page to open", () => state.opened[0] ?? null)

    expect(state.opened).toEqual([
      { target: { kind: "server", upstream: `http://127.0.0.1:${printedPort}/` }, cwd: dir },
    ])
    expect(state.out()).toContain(
      `The dev server ignored port ${port} and is on ${printedPort}, so this page's address changes between runs. Make it listen on ${port} with its --port flag or the $PORT variable.\n${PAGE_URL}\n`,
    )

    state.interrupt("SIGINT")
    await pending
    expect(state.exits).toEqual([130])
  })

  test("a printed URL on a non-loopback host is never probed", async () => {
    const dir = await tempDir()
    const port = await freeTestPort()
    const printedPort = await freeTestPort()
    const probed: string[] = []
    let spoken = ""
    const clock = fakeClock(() => spoken.includes("Network"))
    const state = setup({
      clock,
      probe: async (url) => {
        probed.push(url)
        return false
      },
    })
    const done = state.start([
      dir,
      "--port",
      String(port),
      "--",
      "bun",
      "-e",
      `console.log("Network: http://192.168.1.20:${printedPort}/"); setInterval(() => {}, 1000)`,
    ])
    await until("the child's output", () => {
      spoken = state.out()
      return spoken.includes("Network") ? true : null
    })
    await done
    expect(state.exits).toEqual([ExitCode.failure])
    expect(probed.length).toBeGreaterThan(0)
    expect(probed.filter((url) => url.includes(`:${printedPort}/`))).toEqual([])
  })

  test("SIGINT stops the dev server's whole process group, grandchildren included, and exits 130", async () => {
    const dir = await tempDir()
    const pidFile = join(dir, "grandchild.pid")
    const port = await freeTestPort()
    const state = setup()
    const pending = state.start([
      dir,
      "--port",
      String(port),
      "--",
      "sh",
      "-c",
      'bun -e "$0" & echo $! > "$1"; wait',
      SERVE,
      pidFile,
    ])
    await until("the page to open", () => state.opened[0] ?? null)
    const leader = state.spawned[0]?.child.pid ?? 0
    const grandchild = Number(await readFile(pidFile, "utf8"))
    expect(alive(leader)).toBe(true)
    expect(alive(grandchild)).toBe(true)
    expect((await readRecord(state.home, dir))?.pgid).toBe(leader)

    state.interrupt("SIGINT")
    await pending
    expect(state.exits).toEqual([130])
    await until("the grandchild to be gone", () => (alive(grandchild) ? null : true))
    expect(alive(leader)).toBe(false)
    expect(await fetch(`http://127.0.0.1:${port}/`).catch(() => null)).toBeNull()
    expect(await readRecord(state.home, dir)).toBeNull()
  })

  test("SIGHUP stops the dev server like SIGTERM, removes the record and exits 129", async () => {
    const dir = await tempDir()
    const port = await freeTestPort()
    const state = setup()
    const pending = state.start([dir, "--port", String(port), "--", "bun", "-e", SERVE])
    await until("the page to open", () => state.opened[0] ?? null)
    state.interrupt("SIGHUP")
    await pending
    expect(state.exits).toEqual([129])
    expect(await state.spawned[0]?.child.exited).toBe(143)
    expect(await readRecord(state.home, dir)).toBeNull()
  })

  test("SIGTERM stops the dev server and exits 143", async () => {
    const dir = await tempDir()
    const port = await freeTestPort()
    const state = setup()
    const pending = state.start([dir, "--port", String(port), "--", "bun", "-e", SERVE])
    await until("the page to open", () => state.opened[0] ?? null)
    state.interrupt("SIGTERM")
    await pending
    expect(state.exits).toEqual([143])
    expect(await state.spawned[0]?.child.exited).toBe(143)
  })

  test("a dev server that ignores SIGTERM is killed once the 5 s grace passes", async () => {
    const dir = await tempDir()
    const port = await freeTestPort()
    let stopping = false
    const state = setup({ clock: fakeClock(() => stopping) })
    const pending = state.start([
      dir,
      "--port",
      String(port),
      "--",
      "bun",
      "-e",
      `process.on("SIGTERM", () => console.log("ignored")); ${SERVE}`,
    ])
    await until("the page to open", () => state.opened[0] ?? null)
    stopping = true
    state.interrupt("SIGINT")
    await pending
    expect(state.exits).toEqual([130])
    expect(state.out()).toContain("ignored\n")
    expect(await state.spawned[0]?.child.exited).toBe(128 + 9)
  })

  test("an interrupt before the server answers stops it without opening a page", async () => {
    const dir = await tempDir()
    const port = await freeTestPort()
    const state = setup()
    const pending = state.start([
      dir,
      "--port",
      String(port),
      "--",
      "bun",
      "-e",
      'console.log("booting"); setInterval(() => {}, 1000)',
    ])
    await until("the child to start", () => (state.out().includes("booting") ? true : null))
    state.interrupt("SIGINT")
    await pending
    expect(state.exits).toEqual([130])
    expect(state.opened).toEqual([])
    expect(alive(state.spawned[0]?.child.pid ?? 0)).toBe(false)
  })

  test("a dev server that exits by itself after opening ends run with its code", async () => {
    const dir = await tempDir()
    const port = await freeTestPort()
    const state = setup()
    await state.start([
      dir,
      "--port",
      String(port),
      "--",
      "bun",
      "-e",
      `Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch() { setTimeout(() => process.exit(7), 200); return new Response("ok") } })`,
    ])
    expect(state.opened).toHaveLength(1)
    expect(state.exits).toEqual([7])
  })

  test("a failed open stops the dev server and exits with the open's code", async () => {
    const dir = await tempDir()
    const port = await freeTestPort()
    const state = setup({
      open: async () => {
        throw new Error("Cannot reach iter8 service", { cause: ExitCode.serviceUnavailable })
      },
    })
    await state.start([dir, "--port", String(port), "--", "bun", "-e", SERVE])
    expect(state.exits).toEqual([ExitCode.serviceUnavailable])
    expect(state.err()).toBe("Cannot reach iter8 service\n")
    expect(alive(state.spawned[0]?.child.pid ?? 0)).toBe(false)
  })
})

describe("readiness failures", () => {
  const lines = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`)

  test("no answer within 60 s fails naming the port with the last 20 lines of output", async () => {
    const dir = await tempDir()
    const port = await freeTestPort()
    let spoken = ""
    const clock = fakeClock(() => spoken.includes("line 25"))
    const state = setup({ clock })
    const done = state.start([
      dir,
      "--port",
      String(port),
      "--",
      "bun",
      "-e",
      `for (let i = 1; i <= 25; i++) console.error("line " + i); setInterval(() => {}, 1000)`,
    ])
    await until("the child's output", () => {
      spoken = state.err()
      return spoken.includes("line 25") ? true : null
    })
    await done
    expect(clock.now()).toBeGreaterThanOrEqual(60_000)
    expect(state.exits).toEqual([ExitCode.failure])
    expect(state.opened).toEqual([])
    const report = state.err().slice(state.err().indexOf("The dev server"))
    expect(report).toBe(
      [`The dev server did not answer on port ${port} within 60 s.`, ...lines.slice(5), ""].join(
        "\n",
      ),
    )
    expect(alive(state.spawned[0]?.child.pid ?? 0)).toBe(false)
  })

  test("a server that exits before answering fails naming the port with the last 20 lines", async () => {
    const dir = await tempDir()
    const port = await freeTestPort()
    const state = setup()
    await state.start([
      dir,
      "--port",
      String(port),
      "--",
      "bun",
      "-e",
      `for (let i = 1; i <= 25; i++) console.log("line " + i); process.exit(3)`,
    ])
    expect(state.exits).toEqual([ExitCode.failure])
    expect(state.opened).toEqual([])
    expect(state.err()).toBe(
      [
        `The dev server exited with code 3 before answering on port ${port}.`,
        ...lines.slice(5),
        "",
      ].join("\n"),
    )
  })

  test("fewer than 20 lines of output are all printed", async () => {
    const dir = await tempDir()
    const port = await freeTestPort()
    const state = setup()
    await state.start([
      dir,
      "--port",
      String(port),
      "--",
      "bun",
      "-e",
      'console.log("only"); process.exit(1)',
    ])
    expect(state.err()).toBe(
      `The dev server exited with code 1 before answering on port ${port}.\nonly\n`,
    )
  })
})

describe("browser placement", () => {
  async function opened(options: Options) {
    const dir = await tempDir()
    await writeFile(join(dir, "index.html"), "<h1>Hi</h1>")
    const state = setup(options)
    await state.start([dir])
    expect(state.exits).toEqual([ExitCode.ok])
    return state
  }

  test("on linux without SSH it runs xdg-open with the URL as one argument", async () => {
    const state = await opened({})
    expect(state.launched).toEqual([["xdg-open", PAGE_URL]])
    expect(state.out()).toBe(`${PAGE_URL}\nOpened in your browser.\n`)
  })

  test("on macOS without SSH it runs open with the URL as one argument", async () => {
    const state = await opened({ platform: "darwin" })
    expect(state.launched).toEqual([["open", PAGE_URL]])
  })

  test("empty SSH variables count as unset", async () => {
    const state = await opened({ env: { SSH_CONNECTION: "", SSH_TTY: "" } })
    expect(state.launched).toEqual([["xdg-open", PAGE_URL]])
  })

  test.each([{ SSH_CONNECTION: "10.0.0.2 51000 10.0.0.1 22" }, { SSH_TTY: "/dev/pts/3" }])(
    "on SSH (%j) with no laptop it prints the setup instruction instead of opening",
    async (env) => {
      const state = await opened({ env })
      expect(state.launched).toEqual([])
      expect(state.out()).toBe(
        `${PAGE_URL}\nYou're on SSH and no laptop is connected. On your laptop run: iter8 setup devbox-7\n`,
      )
    },
  )

  test("a connected laptop gets the page, even on SSH, and nothing opens here", async () => {
    const state = await opened({
      env: { SSH_CONNECTION: "10.0.0.2 51000 10.0.0.1 22" },
      laptops: ["air", "studio"],
    })
    expect(state.launched).toEqual([])
    expect(state.out()).toBe(`${PAGE_URL}\nOpened on air, studio.\n`)
  })

  test("an opener that cannot start says so instead of claiming the browser opened", async () => {
    const state = await opened({ launches: false })
    expect(state.out()).toBe(
      `${PAGE_URL}\nCouldn't start xdg-open; open the URL above in your browser.\n`,
    )
  })
})

describe("what to run", () => {
  test("a folder with HTML and no runnable script opens as a folder page without spawning", async () => {
    const dir = await tempDir()
    await writeFile(join(dir, "mock.html"), "<h1>Mock</h1>")
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { build: "x" } }))
    const state = setup()
    await state.start([dir])
    expect(state.exits).toEqual([ExitCode.ok])
    expect(state.spawned).toEqual([])
    expect(state.opened).toEqual([{ target: { kind: "folder", root: dir, file: null }, cwd: dir }])
  })

  test("DIR defaults to the working directory", async () => {
    const dir = await tempDir()
    await writeFile(join(dir, "index.html"), "<h1>Hi</h1>")
    const state = setup({ cwd: dir })
    await state.start([])
    expect(state.exits).toEqual([ExitCode.ok])
    expect(state.opened).toEqual([{ target: { kind: "folder", root: dir, file: null }, cwd: dir }])
  })

  test("a relative DIR resolves against the working directory", async () => {
    const dir = await tempDir()
    await mkdir(join(dir, "site"))
    await writeFile(join(dir, "site", "index.html"), "<h1>Hi</h1>")
    const state = setup({ cwd: dir })
    await state.start(["site"])
    expect(state.opened[0]?.cwd).toBe(join(dir, "site"))
  })

  test("nothing runnable fails with the instruction and starts nothing", async () => {
    const dir = await tempDir()
    const state = setup()
    await state.start([dir])
    expect(state.exits).toEqual([ExitCode.failure])
    expect(state.err()).toBe(
      `Nothing to run in ${dir}: no dev or start script in package.json and no HTML files. Use iter8 run -- <command>.\n`,
    )
    expect(state.spawned).toEqual([])
    expect(state.opened).toEqual([])
  })

  test("a missing directory exits not-found", async () => {
    const dir = await tempDir()
    const state = setup()
    await state.start([join(dir, "nope")])
    expect(state.exits).toEqual([ExitCode.notFound])
    expect(state.spawned).toEqual([])
  })

  test("a file as DIR is a usage error", async () => {
    const dir = await tempDir()
    await writeFile(join(dir, "index.html"), "")
    const state = setup()
    await state.start([join(dir, "index.html")])
    expect(state.exits).toEqual([ExitCode.usage])
  })

  test("an unparseable package.json fails instead of guessing", async () => {
    const dir = await tempDir()
    await writeFile(join(dir, "package.json"), "{ nope")
    await writeFile(join(dir, "index.html"), "")
    const state = setup()
    await state.start([dir])
    expect(state.exits).toEqual([ExitCode.failure])
    expect(state.err()).toStartWith(`Cannot parse ${join(dir, "package.json")}:`)
    expect(state.opened).toEqual([])
  })

  test("arguments after -- run as the command with PORT set, even where a dev script exists", async () => {
    const dir = await tempDir()
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "exit 9" } }))
    const port = await freeTestPort()
    const state = setup()
    await state.start([dir, "--port", String(port), "--", "sh", "-c", 'echo "port=$PORT"; exit 4'])
    expect(state.spawned.map(({ argv }) => argv)).toEqual([
      ["sh", "-c", 'echo "port=$PORT"; exit 4'],
    ])
    expect(state.spawned[0]?.env.PORT).toBe(String(port))
    expect(state.out()).toContain(`port=${port}\n`)
    expect(state.err()).toStartWith(
      `The dev server exited with code 4 before answering on port ${port}.`,
    )
  })

  test("a flag-like argument after -- belongs to the command, not to run", async () => {
    const dir = await tempDir()
    const port = await freeTestPort()
    const state = setup()
    await state.start([dir, "--port", String(port), "--", "sh", "-c", "exit 0", "--port", "1"])
    expect(state.spawned.map(({ argv }) => argv)).toEqual([["sh", "-c", "exit 0", "--port", "1"]])
  })

  test("-- with no command is a usage error", async () => {
    const dir = await tempDir()
    const state = setup()
    await state.start([dir, "--"])
    expect(state.exits).toEqual([ExitCode.usage])
    expect(state.spawned).toEqual([])
  })

  test.each(["0", "65536", "abc", "-1"])("--port %s is a usage error", async (value) => {
    const dir = await tempDir()
    const state = setup()
    await state.start([dir, `--port=${value}`, "--", "true"])
    expect(state.exits).toEqual([ExitCode.usage])
    expect(state.spawned).toEqual([])
  })
})

describe("the port", () => {
  async function startedPort(dir: string, portFree: RunSystem["portFree"]) {
    const state = setup({ portFree })
    await state.start([dir, "--", "true"])
    return { state, port: Number(state.spawned[0]?.env.PORT) }
  }

  test("without --port the same project root gets the same port on every run", async () => {
    const dir = await tempDir()
    const first = await startedPort(dir, async () => true)
    const second = await startedPort(dir, async () => true)
    expect(first.port).toBe(stablePort(dir))
    expect(second.port).toBe(first.port)
    expect(first.state.out()).toStartWith(`Starting true on port ${first.port}…\n`)
  })

  test("a busy stable port steps forward to the next free one", async () => {
    const dir = await tempDir()
    const stable = stablePort(dir)
    const { port } = await startedPort(dir, async (candidate) => candidate !== stable)
    expect(port).toBe(stable === 4899 ? 4100 : stable + 1)
  })

  test("stepping wraps from 4899 back to 4100", async () => {
    const dir = await tempDir()
    const stable = stablePort(dir)
    const free = stable === 4100 ? 4101 : 4100
    const { port } = await startedPort(dir, async (candidate) => candidate === free)
    expect(port).toBe(free)
  })

  test("every port busy fails without spawning", async () => {
    const dir = await tempDir()
    const { state } = await startedPort(dir, async () => false)
    expect(state.exits).toEqual([ExitCode.failure])
    expect(state.err()).toBe("No free port in 4100–4899\n")
    expect(state.spawned).toEqual([])
  })

  test("a busy --port fails before spawning, since a probe would reach the wrong server", async () => {
    const dir = await tempDir()
    const holder = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
    try {
      const state = setup()
      await state.start([dir, "--port", String(holder.port), "--", "true"])
      expect(state.exits).toEqual([ExitCode.failure])
      expect(state.err()).toBe(`Port ${holder.port} is already in use\n`)
      expect(state.spawned).toEqual([])
    } finally {
      holder.stop(true)
    }
  })
})

describe("a dev server left behind by a run whose CLI died", () => {
  const IDLE = ["--", "bun", "-e", "setInterval(() => {}, 1000)"]

  async function deadPid(): Promise<number> {
    const gone = Bun.spawn(["true"])
    await gone.exited
    return gone.pid
  }

  /** A run recorded under a CLI pid that has already exited, as after a SIGKILL. */
  async function orphan(home: string, args: string[], options: Options = {}) {
    const state = setup({ ...options, home, cliPid: await deadPid() })
    const pending = state.start(args)
    await until("the orphan's page to open", () => state.opened[0] ?? null)
    return { state, pending, leader: state.spawned[0]?.child.pid ?? 0 }
  }

  /** Reports the stable port busy for as long as `holder()` names a live process. */
  const stableHeldBy = (dir: string, holder: () => number) => async (port: number) =>
    port !== stablePort(dir) || holder() === 0 || !alive(holder())

  test("the next run with the same --port stops it and takes the port back", async () => {
    const dir = await tempDir()
    const home = await tempDir()
    const port = await freeTestPort()
    const args = [dir, "--port", String(port), "--", "bun", "-e", SERVE]
    const first = await orphan(home, args)
    expect(alive(first.leader)).toBe(true)

    const second = setup({ home })
    const pending = second.start(args)
    await until("the second page to open", () => second.opened[0] ?? null)
    await first.pending
    expect(alive(first.leader)).toBe(false)
    expect(second.spawned[0]?.env.PORT).toBe(String(port))
    expect(second.opened[0]?.target).toEqual({
      kind: "server",
      upstream: `http://127.0.0.1:${port}/`,
    })
    expect((await readRecord(home, dir))?.pgid).toBe(second.spawned[0]?.child.pid)

    second.interrupt("SIGINT")
    await pending
    expect(second.exits).toEqual([130])
    expect(await readRecord(home, dir)).toBeNull()
  })

  test("without --port the next run stops it instead of stepping past the stable port", async () => {
    const dir = await tempDir()
    const home = await tempDir()
    let holder = 0
    const options = { portFree: stableHeldBy(dir, () => holder), probe: async () => true }
    const first = await orphan(home, [dir, ...IDLE], options)
    holder = first.leader
    expect(first.state.spawned[0]?.env.PORT).toBe(String(stablePort(dir)))

    const second = setup({ ...options, home })
    const pending = second.start([dir, ...IDLE])
    await until("the second page to open", () => second.opened[0] ?? null)
    await first.pending
    expect(alive(first.leader)).toBe(false)
    expect(second.spawned[0]?.env.PORT).toBe(String(stablePort(dir)))

    second.interrupt("SIGINT")
    await pending
  })

  test("a dev server whose run is still alive is left running", async () => {
    const dir = await tempDir()
    const home = await tempDir()
    let holder = 0
    const options = { portFree: stableHeldBy(dir, () => holder), probe: async () => true, home }
    const first = setup(options)
    const firstPending = first.start([dir, ...IDLE])
    await until("the first page to open", () => first.opened[0] ?? null)
    holder = first.spawned[0]?.child.pid ?? 0

    const second = setup(options)
    const secondPending = second.start([dir, ...IDLE])
    await until("the second page to open", () => second.opened[0] ?? null)
    expect(alive(holder)).toBe(true)
    const stable = stablePort(dir)
    expect(second.spawned[0]?.env.PORT).toBe(String(stable === 4899 ? 4100 : stable + 1))

    first.interrupt("SIGINT")
    second.interrupt("SIGINT")
    await Promise.all([firstPending, secondPending])
  })

  test.each([
    ["its leader's pid now has another start time", { startedAt: "linux:0:0" }],
    ["the record belongs to another root with the same hash", { root: "/elsewhere" }],
  ])("a record is not acted on when %s", async (_, change) => {
    const dir = await tempDir()
    const home = await tempDir()
    const port = await freeTestPort()
    const args = [dir, "--port", String(port), "--", "bun", "-e", SERVE]
    const first = await orphan(home, args)
    const recorded = await readRecord(home, dir)
    await writeFile(recordFile(home, dir), JSON.stringify({ ...recorded, ...change }))

    const second = setup({ home })
    await second.start(args)
    expect(second.exits).toEqual([ExitCode.failure])
    expect(second.err()).toBe(`Port ${port} is already in use\n`)
    expect(alive(first.leader)).toBe(true)

    first.state.interrupt("SIGINT")
    await first.pending
  })
})
