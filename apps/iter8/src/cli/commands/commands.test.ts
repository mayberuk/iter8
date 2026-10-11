import type { Database } from "bun:sqlite"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import {
  type Capture,
  CLI_SURFACE,
  DraftBody,
  ExitCode,
  formatPointer,
  HookEndReason,
  HookSource,
  IdempotencyKey,
  Intent,
  LANDING_PATH,
  OpenResult,
  type OwnerId,
  type PageId,
  PageToken,
  PairingGeneration,
  PairResult,
  POINTER_LINE,
  PROTOCOL_VERSION,
  ServiceStatus,
  ShowResult,
  VersionReport,
} from "@iter8/protocol"
import { type ArgsDef, type CommandDef, runCommand } from "citty"
import { hc } from "hono/client"
import { type LaptopOpen, listenForPages } from "../../connect/page-channel"
import { createAgentNotes } from "../../pages/agent-notes"
import { createPages } from "../../pages/pages"
import { createScreenshots } from "../../pages/screenshots"
import { createOwners } from "../../pairing/owners"
import { createInbox } from "../../rounds/inbox"
import { type ControlApp, createControlApi } from "../../service/control-api"
import { createLiveHub } from "../../service/live"
import { createWaiters, type Waiters } from "../../service/waiters"
import { openStore, readOrCreateMachineId } from "../../store/db"
import { type CliDeps, controlClientFor } from "../client"
import { cliCommands } from "./index"

const databases: Database[] = []
const directories: string[] = []
const waiterSets: Waiters[] = []
const pendingCommands: Promise<unknown>[] = []

afterEach(async () => {
  for (const waiters of waiterSets.splice(0)) waiters.cancelAll()
  await Promise.allSettled(pendingCommands.splice(0))
  for (const db of databases.splice(0)) db.close()
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), "iter8-"))
  directories.push(path)
  return path
}

async function setup() {
  const home = await tempDir()
  const db = openStore(":memory:")
  databases.push(db)
  const cwd = "/tmp/iter8-project"
  const pid = 9001
  const starts = new Map([
    [pid, "linux:1:9001"],
    [9002, "linux:1:9002"],
  ])
  const now = () => new Date("2026-10-09T18:00:00.000Z")
  const owners = createOwners(db, { now, processStart: (pid) => starts.get(pid) ?? null })
  let sequence = 0
  const pages = createPages(db, {
    randomToken: () => PageToken.parse(`token${String(++sequence).padStart(40, "0")}`),
  })
  const screenshots = createScreenshots(db, { now })
  const waiters = createWaiters()
  waiterSets.push(waiters)
  const live = createLiveHub()
  const listener = (owner: OwnerId) =>
    waiters.isArmed(owner) ? ("armed" as const) : ("none" as const)
  const inbox = createInbox(db, {
    now,
    ownerState: (owner) => owners.state(owner),
    pairing: (pageId) => {
      const link = pages.get(pageId)?.page.pairing
      return link ? owners.pairing(link.owner, link.generation, listener(link.owner)) : null
    },
  })
  const machineId = readOrCreateMachineId(db)
  const app = createControlApi({
    pages,
    owners,
    inbox,
    screenshots,
    live,
    waiters,
    agentNotes: createAgentNotes(db, { now }),
    machineId,
    onPageOpened() {},
    drain() {},
    poolPorts: () => [3990, 3991, 3992, 3993],
    status: (owner) =>
      ServiceStatus.parse({
        state: "ready",
        version: "0.1.0",
        build: "source",
        protocolVersion: PROTOCOL_VERSION,
        schemaVersion: 1,
        machineId,
        machineName: "workstation",
        pid,
        home,
        pool: [3990, 3991, 3992, 3993],
        overlay: "present",
        owner: owner ? owners.pairing(owner, PairingGeneration.parse(0), listener(owner)) : null,
      }),
  })
  const stdout: string[] = []
  const stderr: string[] = []
  const exits: number[] = []
  const connections: { start: boolean }[] = []
  const requests: { path: string; search: string; body: unknown }[] = []
  const responses: { path: string; body: string }[] = []
  let statusFailure: "disconnected" | "refused" | "invalid" | null = null
  const client = hc<ControlApp>("http://iter8", {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      requests.push({
        path: url.pathname,
        search: url.search,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      })
      if (url.pathname === "/status" && statusFailure !== null) {
        if (statusFailure === "disconnected") throw new Error("Control connection lost")
        return statusFailure === "refused"
          ? new Response("Service unavailable", { status: 503 })
          : Response.json({})
      }
      const response = await app.request(`${url.pathname}${url.search}`, init)
      responses.push({ path: url.pathname, body: await response.clone().text() })
      return response
    },
  })
  const deps: CliDeps = {
    connect: async (options) => {
      connections.push(options)
      return client
    },
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    exit: (code) => exits.push(code),
    cwd,
    pid,
    ancestry: () => [{ pid, startedAt: starts.get(pid) ?? "" }],
    processStart: (pid) => starts.get(pid) ?? null,
    makeTempDir: tempDir,
    version: "0.1.0",
  }
  function clear() {
    stdout.length = 0
    stderr.length = 0
    exits.length = 0
    connections.length = 0
    requests.length = 0
    responses.length = 0
  }
  function failStatus(kind: NonNullable<typeof statusFailure>) {
    statusFailure = kind
  }
  async function run(name: string, rawArgs: string[] = []) {
    const commands = cliCommands(deps)
    const command = commands[name]
    if (!command) throw new Error(`Unknown command ${name}`)
    const pending = runCommand(command, { rawArgs })
    pendingCommands.push(pending)
    await pending
  }
  async function start(agent?: string, sessionPid = pid) {
    await run("hook", [
      "start",
      "--pid",
      String(sessionPid),
      "--label",
      `session-${sessionPid}`,
      "--source",
      "startup",
      "--json",
      ...(agent === undefined ? [] : ["--agent", agent]),
    ])
    expect(exits).toEqual([ExitCode.ok])
    const pairing = PairResult.parse(JSON.parse(stdout.join(""))).pairing
    clear()
    return pairing
  }
  async function openPage() {
    await run("open", ["http://localhost:5173", "--json"])
    expect(exits).toEqual([ExitCode.ok])
    const opened = OpenResult.parse(JSON.parse(stdout.join("")))
    clear()
    return opened.page
  }
  function sendMany(pageId: PageId, drafts: Array<{ body: string; capture?: Capture }>) {
    const notes = drafts.map(({ body, capture }) =>
      inbox.createDraft(
        pageId,
        DraftBody.parse({
          intent: "fix",
          body,
          anchorStatus: "anchored",
          target: {
            kind: "element",
            anchor: {
              selector: ["h1"],
              box: { x: 1, y: 2, width: 100, height: 20 },
              renderGeneration: 0,
            },
          },
          ...(capture === undefined ? {} : { capture }),
        }),
      ),
    )
    const result = inbox.send(pageId, {
      generation: pages.get(pageId)?.page.pairing?.generation ?? PairingGeneration.parse(0),
      noteIds: notes.map((note) => note.id),
      idempotencyKey: IdempotencyKey.parse(`send-key-${notes[0]?.id}`),
    })
    if (result.outcome !== "accepted") throw new Error(`Refused ${result.reason}`)
    return result.round
  }
  const send = (pageId: PageId, capture?: Capture) =>
    sendMany(pageId, [{ body: "Make the heading readable", ...(capture ? { capture } : {}) }])
  return {
    deps,
    client,
    app,
    run,
    failStatus,
    clear,
    start,
    openPage,
    send,
    sendMany,
    stdout,
    stderr,
    exits,
    connections,
    requests,
    responses,
    pages,
    inbox,
    screenshots,
    owners,
    waiters,
    machineId,
    home,
    pid,
  }
}

async function armed(waiters: Waiters, owner: OwnerId) {
  const deadline = Date.now() + 1000
  while (!waiters.isArmed(owner)) {
    if (Date.now() > deadline) throw new Error("Hook wait did not arm")
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

async function resolved<T>(value: T | Promise<T> | (() => T | Promise<T>)): Promise<T> {
  return typeof value === "function" ? await (value as () => T | Promise<T>)() : await value
}

type State = Awaited<ReturnType<typeof setup>>

async function leaveStaleSocket(socketPath: string) {
  const creating = `${socketPath}.creating`
  const server = Bun.listen({ unix: creating, socket: { data() {} } })
  try {
    await rename(creating, socketPath)
  } finally {
    server.stop(true)
  }
  expect((await stat(socketPath)).isSocket()).toBe(true)
}

function servedOpen(state: State): unknown {
  return JSON.parse(state.responses.find((response) => response.path === "/open")?.body ?? "")
}

const connectHint = () =>
  `Browser on another machine? Run there: iter8 connect ${hostname()} (or forward the pool yourself: ssh -N -o ExitOnForwardFailure=yes -L 3990:localhost:3990 -L 3991:localhost:3991 -L 3992:localhost:3992 -L 3993:localhost:3993 ${hostname()}).`

describe("command surface", () => {
  test("derives every owned command, positional and flag from CLI_SURFACE", async () => {
    const commands = cliCommands((await setup()).deps)
    expect(Object.keys(commands).sort()).toEqual(
      ["open", "attach", "rounds", "show", "done", "note", "status", "version", "hook"].sort(),
    )
    for (const [name, spec] of Object.entries(CLI_SURFACE)) {
      if (name === "serve") continue
      const [root = "", child] = name.split(" ")
      let command = commands[root]
      expect(command).toBeDefined()
      if (child) {
        const children = await resolved(command?.subCommands ?? {})
        command = await resolved(children[child] as CommandDef)
      }
      const args: ArgsDef = await resolved(command?.args ?? {})
      expect(Object.keys(args).sort()).toEqual(
        [...spec.positionals, ...spec.flags.map((flag) => flag.name), "json"].sort(),
      )
      expect(args.json?.type).toBe("boolean")
      for (const positional of spec.positionals) {
        expect(args[positional]?.type).toBe("positional")
        expect(args[positional]?.required).toBe(true)
      }
      for (const flag of spec.flags) {
        expect(args[flag.name]?.required).toBe(flag.required)
        expect(args[flag.name]?.valueHint).toBe(
          Array.isArray(flag.value) ? flag.value.join("|") : flag.value,
        )
        expect(args[flag.name]?.description).toBe(flag.repeatable ? "Repeatable" : "")
      }
    }
  })

  test("every missing required flag and invalid enum value exits usage", async () => {
    for (const [name, spec] of Object.entries(CLI_SURFACE)) {
      if (name === "serve") continue
      const [root = "", child] = name.split(" ")
      const valid = spec.flags.flatMap((flag) =>
        flag.required
          ? [
              `--${flag.name}`,
              flag.value === "integer"
                ? "9001"
                : Array.isArray(flag.value)
                  ? (flag.value[0] ?? "")
                  : "value",
            ]
          : [],
      )
      for (const flag of spec.flags) {
        if (!flag.required && !Array.isArray(flag.value)) continue
        const state = await setup()
        const args = [...(child ? [child] : []), ...spec.positionals.map(() => "page"), ...valid]
        const offset = args.indexOf(`--${flag.name}`)
        if (flag.required) args.splice(offset, 2)
        else args.push(`--${flag.name}`, "invalid")
        await state.run(root, args)
        expect(state.exits).toEqual([ExitCode.usage])
        expect(state.stdout).toEqual([])
        expect(state.connections).toEqual([])
      }
      for (const flag of spec.flags.filter((flag) => Array.isArray(flag.value))) {
        const state = await setup()
        const args = [...(child ? [child] : []), ...spec.positionals.map(() => "page"), ...valid]
        args[args.indexOf(`--${flag.name}`) + 1] = "invalid"
        await state.run(root, args)
        expect(state.exits).toEqual([ExitCode.usage])
        expect(state.connections).toEqual([])
      }
    }
  })

  test("bad integers, unknown flags, duplicate flags and missing positionals exit usage", async () => {
    for (const [command, args] of [
      ["hook", ["wait", "--pid", "abc", "--timeout-seconds", "1"]],
      ["hook", ["wait", "--pid", "0", "--timeout-seconds", "1"]],
      ["hook", ["wait", "--pid", "9001", "--timeout-seconds", "2147484"]],
      ["version", ["--wat"]],
      ["version", ["--json", "--json"]],
      ["show", []],
      ["note", ["page", "--intent", "fix", "--body", "x", "--at"]],
    ] as const) {
      const state = await setup()
      await state.run(command, [...args])
      expect(state.exits).toEqual([ExitCode.usage])
      expect(state.connections).toEqual([])
    }
  })
})

describe("hook commands", () => {
  test.each(["claude", undefined])(
    "start preserves agent %s and sends process identity",
    async (agent) => {
      const state = await setup()
      await state.run("hook", [
        "start",
        "--pid",
        "9001",
        "--label",
        "session",
        "--source",
        "startup",
        "--json",
        ...(agent ? ["--agent", agent] : []),
      ])
      expect(state.exits).toEqual([ExitCode.ok])
      expect(PairResult.parse(JSON.parse(state.stdout.join(""))).pairing.agent).toBe(
        agent ?? "agent",
      )
      expect(state.requests[0]?.body).toMatchObject({
        agent: agent ?? "agent",
        pid: 9001,
        startedAt: "linux:1:9001",
      })
      expect(state.connections).toEqual([{ start: true }])
    },
  )

  test.each(["start", "prompt"])("%s prints only unannounced pointers", async (command) => {
    const state = await setup()
    await state.start("claude")
    const page = await state.openPage()
    const round = state.send(page.id)
    const args = [
      command,
      "--pid",
      "9001",
      ...(command === "start" ? ["--label", "session-9001", "--source", "resume"] : []),
    ]
    await state.run("hook", args)
    expect(state.exits).toEqual([ExitCode.ok])
    expect(state.stderr).toEqual([])
    expect(state.stdout).toHaveLength(1)
    expect(state.stdout[0]?.trim()).toMatch(POINTER_LINE)
    expect(state.stdout[0]).toContain(round.id)
    expect(state.stdout[0]).not.toContain("Make the heading readable")
    state.clear()
    await state.run("hook", args)
    expect(state.stdout).toEqual([])
  })

  test.each(["start", "prompt"])(
    "%s prints one pointer line per unannounced round, in order",
    async (command) => {
      const state = await setup()
      await state.start("claude")
      const page = await state.openPage()
      const rounds = [
        state.send(page.id),
        state.sendMany(page.id, [{ body: "a" }, { body: "b" }]),
        state.send(page.id),
      ]
      await state.run("hook", [
        command,
        "--pid",
        "9001",
        ...(command === "start" ? ["--label", "session-9001", "--source", "resume"] : []),
      ])
      expect(state.exits).toEqual([ExitCode.ok])
      expect(state.stderr).toEqual([])
      expect(state.stdout).toEqual(
        rounds.map(
          (round) =>
            `${formatPointer({ roundId: round.id, pageId: page.id, noteCount: round.notes.length })}\n`,
        ),
      )
      for (const line of state.stdout) expect(line.trim()).toMatch(POINTER_LINE)
      expect(state.stdout[1]).toContain("2 notes")
    },
  )

  test("prompt, stop and end update the registered owner without extra output", async () => {
    const state = await setup()
    const pairing = await state.start()
    await state.run("hook", ["prompt", "--pid", "9001", "--json"])
    expect(state.owners.state(pairing.owner).status).toBe("busy")
    state.clear()
    await state.run("hook", ["stop", "--pid", "9001", "--json"])
    expect(state.owners.state(pairing.owner).status).toBe("live")
    expect(state.stdout).toEqual([])
    expect(state.stderr).toEqual([])
    state.clear()
    await state.run("hook", [
      "end",
      "--pid",
      "9001",
      "--label",
      "session-9001",
      "--reason",
      "logout",
      "--json",
    ])
    expect(state.owners.state(pairing.owner)).toEqual({ status: "gone", reason: "ended" })
    expect(state.stdout).toEqual([])
    expect(state.stderr).toEqual([])
    expect(state.exits).toEqual([ExitCode.ok])
  })

  test("wait wakes with pointer lines on stderr and exit wake", async () => {
    const state = await setup()
    const pairing = await state.start()
    const page = await state.openPage()
    const pending = state.run("hook", ["wait", "--pid", "9001", "--timeout-seconds", "600"])
    await armed(state.waiters, pairing.owner)
    state.send(page.id)
    state.waiters.wake(pairing.owner)
    await pending
    expect(state.exits).toEqual([ExitCode.wake])
    expect(state.stdout).toEqual([])
    expect(state.stderr).toHaveLength(1)
    expect(state.stderr[0]?.trim()).toMatch(POINTER_LINE)
    expect(state.connections).toEqual([{ start: true }])
    expect(state.requests.filter((request) => request.path === "/hook/wait")).toHaveLength(1)
  })

  test("wait woken by two rounds writes one pointer line each to stderr", async () => {
    const state = await setup()
    const pairing = await state.start()
    const page = await state.openPage()
    const pending = state.run("hook", ["wait", "--pid", "9001", "--timeout-seconds", "600"])
    await armed(state.waiters, pairing.owner)
    const rounds = [state.send(page.id), state.sendMany(page.id, [{ body: "a" }, { body: "b" }])]
    state.waiters.wake(pairing.owner)
    await pending
    expect(state.exits).toEqual([ExitCode.wake])
    expect(state.stdout).toEqual([])
    expect(state.stderr).toEqual(
      rounds.map(
        (round) =>
          `${formatPointer({ roundId: round.id, pageId: page.id, noteCount: round.notes.length })}\n`,
      ),
    )
    for (const line of state.stderr) expect(line.trim()).toMatch(POINTER_LINE)
  })

  test.each(["600", "2147483"])(
    "wait sends the pid, its start time and the full timeout %s",
    async (timeout) => {
      const state = await setup()
      const pairing = await state.start()
      const pending = state.run("hook", ["wait", "--pid", "9001", "--timeout-seconds", timeout])
      await armed(state.waiters, pairing.owner)
      state.waiters.cancelAll()
      await pending
      const waits = state.requests.filter((request) => request.path === "/hook/wait")
      expect(waits).toHaveLength(1)
      expect(Object.fromEntries(new URLSearchParams(waits[0]?.search))).toEqual({
        pid: "9001",
        startedAt: "linux:1:9001",
        timeoutSeconds: timeout,
      })
    },
  )

  test("wait times out with silent success", async () => {
    const state = await setup()
    await state.start()
    await state.run("hook", ["wait", "--pid", "9001", "--timeout-seconds", "0", "--json"])
    expect(state.exits).toEqual([ExitCode.ok])
    expect(state.stdout).toEqual([])
    expect(state.stderr).toEqual([])
  })

  test.each(["replaced", "cancelled"])("wait %s ends with silent success", async (outcome) => {
    const state = await setup()
    const pairing = await state.start()
    const pending = state.run("hook", ["wait", "--pid", "9001", "--timeout-seconds", "600"])
    await armed(state.waiters, pairing.owner)
    const replacement = outcome === "replaced" ? state.waiters.arm(pairing.owner, 600_000) : null
    if (outcome === "cancelled") state.waiters.cancelAll()
    await pending
    state.waiters.cancelAll()
    if (replacement) await replacement
    expect(state.exits).toEqual([ExitCode.ok])
    expect(state.stdout).toEqual([])
    expect(state.stderr).toEqual([])
  })

  test.each(["null", "throw"])("wait with connect %s exits unavailable once", async (mode) => {
    const state = await setup()
    state.deps.connect = async (options) => {
      state.connections.push(options)
      if (mode === "throw") throw new Error("Start failed")
      return null
    }
    await state.run("hook", ["wait", "--pid", "9001", "--timeout-seconds", "600"])
    expect(state.exits).toEqual([ExitCode.serviceUnavailable])
    expect(state.connections).toEqual([{ start: true }])
    expect(state.stdout).toEqual([])
    expect(state.stderr).toHaveLength(1)
    expect(state.stderr[0]?.trim()).not.toMatch(POINTER_LINE)
  })

  test("lost fetch after the wait request was sent exits unavailable without reconnecting", async () => {
    const state = await setup()
    const pairing = await state.start()
    let pending: Promise<Response> | Response | undefined
    const broken = hc<ControlApp>("http://iter8", {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        pending = state.app.request(`${url.pathname}${url.search}`, init)
        await armed(state.waiters, pairing.owner)
        throw new Error("Control socket disconnected")
      },
    })
    state.deps.connect = async (options) => {
      state.connections.push(options)
      return broken
    }
    await state.run("hook", ["wait", "--pid", "9001", "--timeout-seconds", "600"])
    state.waiters.cancelAll()
    if (pending) await pending
    expect(state.exits).toEqual([ExitCode.serviceUnavailable])
    expect(state.connections).toEqual([{ start: true }])
    expect(state.stdout).toEqual([])
    expect(state.stderr).toHaveLength(1)
    expect(state.stderr[0]).toBe("Lost iter8 control connection: Control socket disconnected\n")
  })
})

describe("agent commands", () => {
  test("open lists localhost URLs and the full pool forward hint", async () => {
    const state = await setup()
    await state.run("open", [
      "http://localhost:5173/view",
      "--upstream",
      "http://127.0.0.1:5174",
      "--upstream=http://[::1]:5175",
    ])
    expect(state.exits).toEqual([ExitCode.ok])
    expect(state.stdout.join("")).toMatch(/http:\/\/[a-z][a-z0-9-]*\.localhost:3990\//)
    expect(state.stdout.join("")).toContain(
      `Browser on another machine? Run there: iter8 connect ${hostname()} (or forward the pool yourself: ssh -N -o ExitOnForwardFailure=yes -L 3990:localhost:3990 -L 3991:localhost:3991 -L 3992:localhost:3992 -L 3993:localhost:3993 ${hostname()}).\n`,
    )
    for (const port of [3990, 3991, 3992, 3993])
      expect(state.stdout.join("")).toContain(`-L ${port}:localhost:${port}`)
    expect(state.requests[0]?.body).toMatchObject({
      cwd: state.deps.cwd,
      upstreams: ["http://127.0.0.1:5174/", "http://[::1]:5175/"],
    })
  })

  test("open an existing file or directory uses a real folder and preserves the file name", async () => {
    const directory = await tempDir()
    const path = join(directory, "a file.html")
    await writeFile(path, "<h1>Hello</h1>")
    const state = await setup()
    for (const target of [path, directory]) {
      await state.run("open", [target, "--json"])
      expect(state.exits).toEqual([ExitCode.ok])
      const result = OpenResult.parse(JSON.parse(state.stdout.join("")))
      expect(result.page.target).toEqual({ kind: "folder", root: directory })
      expect(new URL(result.url).pathname).toBe(target === path ? "/a%20file.html" : "/")
      state.clear()
    }
  })

  test.each([
    "https://example.com",
    "ftp://localhost:21",
    "does-not-exist",
    "http://localhost.evil.com",
    "http://127.evil.com",
    "http://user:password@localhost",
  ])("open rejects %s before connecting", async (target) => {
    const state = await setup()
    await state.run("open", [target])
    expect(state.exits).toEqual([ExitCode.usage])
    expect(state.connections).toEqual([])
  })

  test("attach, rounds, note, show, done and status emit their protocol JSON results", async () => {
    const state = await setup()
    const pairing = await state.start("claude")
    const page = await state.openPage()
    const round = state.send(page.id)
    for (const [name, args] of [
      ["attach", [page.id]],
      ["rounds", []],
      [
        "note",
        [
          page.id,
          "--intent",
          "question",
          "--body",
          "Why?",
          "--at",
          "x-card",
          "--at",
          "h1",
          "--role",
          "heading",
          "--name",
          "Title",
          "--text",
          "Hello",
        ],
      ],
      ["show", [round.id]],
      ["done", [round.notes[0]?.id ?? "", "--reply", "Updated"]],
      ["status", []],
    ] as const) {
      await state.run(name, [...args, "--json", "--owner", pairing.owner])
      expect(state.exits).toEqual([ExitCode.ok])
      const result = JSON.parse(state.stdout.join(""))
      expect(CLI_SURFACE[name].output.safeParse(result).success).toBe(true)
      expect(state.stderr).toEqual([])
      expect(state.connections).toEqual([{ start: name !== "status" }])
      expect(state.requests[0]?.body).toMatchObject({
        owner: pairing.owner,
        identities: [{ pid: 9001, startedAt: "linux:1:9001" }],
      })
      if (name === "note") expect(result.note.target.anchor.selector).toEqual(["x-card", "h1"])
      state.clear()
    }
  })

  test.each([false, true])(
    "show json=%s claims the round and writes each captured PNG",
    async (json) => {
      const state = await setup()
      await state.start()
      const page = await state.openPage()
      const png = Uint8Array.from([
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
      ])
      const screenshot = state.screenshots.store(page.id, png)
      if (!screenshot) throw new Error("PNG rejected")
      const capture: Capture = {
        completeness: "complete",
        omittedParts: [],
        url: `${page.origin}/`,
        viewport: { width: 800, height: 600, devicePixelRatio: 1 },
        theme: "light",
        screenshot,
      }
      const round = state.send(page.id, capture)
      await state.run("show", [round.id, ...(json ? ["--json"] : [])])
      expect(state.exits).toEqual([ExitCode.ok])
      const directory = directories.at(-1)
      if (!directory) throw new Error("No screenshot directory created")
      const path = join(directory, `${round.notes[0]?.id}.png`)
      expect(new Uint8Array(await readFile(path))).toEqual(png)
      expect(state.inbox.round(round.id)?.state.stage).toBe("claimed")
      if (json)
        expect(ShowResult.parse(JSON.parse(state.stdout.join(""))).round.stage).toBe("claimed")
      else expect(state.stdout.join("")).toContain(`Screenshot: ${path}`)
    },
  )

  test("show writes each note's own screenshot under its own name and skips notes without one", async () => {
    const state = await setup()
    await state.start()
    const page = await state.openPage()
    const pngOf = (width: number) =>
      Uint8Array.from([
        137,
        80,
        78,
        71,
        13,
        10,
        26,
        10,
        0,
        0,
        0,
        13,
        73,
        72,
        68,
        82,
        0,
        0,
        0,
        width,
        0,
        0,
        0,
        1,
      ])
    const [pngA, pngB] = [pngOf(1), pngOf(2)]
    const shotA = state.screenshots.store(page.id, pngA)
    const shotB = state.screenshots.store(page.id, pngB)
    if (!shotA || !shotB) throw new Error("PNG rejected")
    const captureOf = (screenshot?: typeof shotA): Capture => ({
      completeness: "complete",
      omittedParts: [],
      url: `${page.origin}/`,
      viewport: { width: 800, height: 600, devicePixelRatio: 1 },
      theme: "light",
      ...(screenshot ? { screenshot } : {}),
    })
    const round = state.sendMany(page.id, [
      { body: "first", capture: captureOf(shotA) },
      { body: "second" },
      { body: "third", capture: captureOf(shotB) },
      { body: "fourth", capture: captureOf() },
    ])
    const [first, second, third, fourth] = round.notes.map((note) => note.id)
    if (!first || !second || !third || !fourth) throw new Error("The round lacks four notes")

    await state.run("show", [round.id])
    expect(state.exits).toEqual([ExitCode.ok])
    const directory = directories.at(-1)
    if (!directory) throw new Error("No screenshot directory created")
    expect((await readdir(directory)).sort()).toEqual([`${first}.png`, `${third}.png`])
    expect(new Uint8Array(await readFile(join(directory, `${first}.png`)))).toEqual(pngA)
    expect(new Uint8Array(await readFile(join(directory, `${third}.png`)))).toEqual(pngB)

    const sections = state.stdout.join("").split(/^## /m).slice(1)
    const sectionOf = (id: string) => sections.find((section) => section.startsWith(`${id} `)) ?? ""
    expect(sectionOf(first)).toContain(`Screenshot: ${join(directory, `${first}.png`)}\n`)
    expect(sectionOf(second)).not.toContain("Screenshot:")
    expect(sectionOf(third)).toContain(`Screenshot: ${join(directory, `${third}.png`)}\n`)
    expect(sectionOf(fourth)).toContain("Screenshot: none\n")
  })

  test("each show run writes into its own fresh directory and leaves earlier runs' files intact", async () => {
    const state = await setup()
    await state.start()
    const page = await state.openPage()
    const pngOf = (width: number) =>
      Uint8Array.from([
        137,
        80,
        78,
        71,
        13,
        10,
        26,
        10,
        0,
        0,
        0,
        13,
        73,
        72,
        68,
        82,
        0,
        0,
        0,
        width,
        0,
        0,
        0,
        1,
      ])
    const [pngA, pngB] = [pngOf(1), pngOf(2)]
    const roundWith = (png: Uint8Array, body: string) => {
      const screenshot = state.screenshots.store(page.id, png)
      if (!screenshot) throw new Error("PNG rejected")
      return state.sendMany(page.id, [
        {
          body,
          capture: {
            completeness: "complete",
            omittedParts: [],
            url: `${page.origin}/`,
            viewport: { width: 800, height: 600, devicePixelRatio: 1 },
            theme: "light",
            screenshot,
          },
        },
      ])
    }
    const first = roundWith(pngA, "first round")
    const second = roundWith(pngB, "second round")
    const firstNote = first.notes[0]?.id
    const secondNote = second.notes[0]?.id
    if (!firstNote || !secondNote) throw new Error("A seeded round has no note")

    const show = async (roundId: string) => {
      const before = directories.length
      await state.run("show", [roundId])
      expect(state.exits).toEqual([ExitCode.ok])
      state.clear()
      expect(directories).toHaveLength(before + 1)
      return directories.at(-1) ?? ""
    }
    const firstRun = await show(first.id)
    const repeatRun = await show(first.id)
    const secondRun = await show(second.id)

    expect(new Set([firstRun, repeatRun, secondRun]).size).toBe(3)
    const bytes = async (directory: string, note: string) =>
      new Uint8Array(await readFile(join(directory, `${note}.png`)))
    expect(await bytes(firstRun, firstNote)).toEqual(pngA)
    expect(await bytes(repeatRun, firstNote)).toEqual(pngA)
    expect(await bytes(secondRun, secondNote)).toEqual(pngB)
    expect(await readdir(firstRun)).toEqual([`${firstNote}.png`])
    expect(await readdir(secondRun)).toEqual([`${secondNote}.png`])
  })

  test("done prints done or answered and unknown note exits notFound", async () => {
    const state = await setup()
    await state.start()
    const page = await state.openPage()
    for (const reply of [undefined, "Changed"]) {
      const round = state.send(page.id)
      const note = round.notes[0]
      if (!note) throw new Error("Missing note")
      await state.run("done", [note.id, ...(reply ? ["--reply", reply] : [])])
      expect(state.stdout).toEqual([`${note.id} ${reply ? "answered" : "done"}\n`])
      expect(state.exits).toEqual([ExitCode.ok])
      state.clear()
    }
    await state.run("done", ["N999"])
    expect(state.exits).toEqual([ExitCode.notFound])
    expect(state.stdout).toEqual([])
  })

  test("resolved wrong owner refuses show and done", async () => {
    const state = await setup()
    await state.start()
    const page = await state.openPage()
    const round = state.send(page.id)
    const other = await state.start("claude", 9002)
    for (const [command, id] of [
      ["show", round.id],
      ["done", round.notes[0]?.id ?? ""],
    ]) {
      await state.run(command ?? "", [id ?? "", "--owner", other.owner])
      expect(state.exits).toEqual([ExitCode.refused])
      expect(state.stdout).toEqual([])
      state.clear()
    }
  })

  test("agent text results are readable and diagnostics stay off stdout", async () => {
    const state = await setup()
    const pairing = await state.start("claude")
    const page = await state.openPage()
    const round = state.send(page.id)
    await state.run("rounds")
    expect(state.stdout.join("")).toContain(`${round.id} ${page.id} queued`)
    state.clear()
    await state.run("attach", [page.id])
    expect(state.stdout).toEqual([`Paired with ${pairing.process.label} (claude)\n`])
    state.clear()
    await state.run("note", [page.id, "--intent", "fix", "--body", "Readable", "--at", "h1"])
    expect(state.stdout.join("")).toMatch(/^N[1-9][0-9]* unanchored\n$/)
    state.clear()
    await state.run("status")
    expect(state.stdout.join("")).toContain(`Owner: ${pairing.process.label}`)
    expect(state.stderr).toEqual([])
    state.clear()
    await state.run("show", ["R999"])
    expect(state.exits).toEqual([ExitCode.notFound])
    expect(state.stdout).toEqual([])
    expect(state.stderr).toEqual(["Unknown round R999\n"])
  })

  test("service-side bad request maps to usage", async () => {
    const state = await setup()
    const directory = await tempDir()
    await state.run("open", [directory, "--upstream", "http://localhost:5173"])
    expect(state.exits).toEqual([ExitCode.usage])
    expect(state.stdout).toEqual([])
    expect(state.stderr).toEqual(["--upstream applies only to a dev server target\n"])
  })

  test("status with no running service exits unavailable without starting", async () => {
    const state = await setup()
    state.deps.connect = async (options) => {
      state.connections.push(options)
      return null
    }
    await state.run("status", ["--json"])
    expect(state.connections).toEqual([{ start: false }])
    expect(state.exits).toEqual([ExitCode.serviceUnavailable])
    expect(state.stdout).toEqual([])
    expect(state.stderr).toHaveLength(1)
  })

  test("version has the protocol version and never connects", async () => {
    const state = await setup()
    await state.run("version", ["--json"])
    expect(VersionReport.parse(JSON.parse(state.stdout.join("")))).toEqual({
      version: "0.1.0",
      protocolVersion: PROTOCOL_VERSION,
    })
    expect(state.exits).toEqual([ExitCode.ok])
    expect(state.connections).toEqual([])
    state.clear()
    await state.run("version")
    expect(state.stdout).toEqual(["iter8 0.1.0\n"])
    expect(state.connections).toEqual([])
  })
})

describe("control client", () => {
  test("sends every request over the unix socket with Bun's idle timeout disabled", async () => {
    const seen: Array<{ url: string; init: unknown }> = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      seen.push({ url: String(input), init })
      return Response.json({ outcome: "timeout" })
    }) as unknown as typeof fetch)
    try {
      const client = controlClientFor("/tmp/iter8-never-opened/control.sock")
      const response = await client.hook.wait.$get({
        query: { pid: "9001", timeoutSeconds: "600" },
      })
      expect(await response.json()).toEqual({ outcome: "timeout" })
    } finally {
      fetchSpy.mockRestore()
    }
    expect(seen).toHaveLength(1)
    expect(new URL(seen[0]?.url ?? "").pathname).toBe("/hook/wait")
    expect(seen[0]?.init).toMatchObject({
      unix: "/tmp/iter8-never-opened/control.sock",
      timeout: false,
    })
  })

  test("reaches a real unix-socket server whose reply comes after a silent wait", async () => {
    const directory = await tempDir()
    const socket = join(directory, "control.sock")
    const server = Bun.serve({
      unix: socket,
      fetch: async () => {
        await Bun.sleep(300)
        return Response.json({ outcome: "timeout" })
      },
    })
    try {
      const response = await controlClientFor(socket).hook.wait.$get({
        query: { pid: "9001", timeoutSeconds: "600" },
      })
      expect(await response.json()).toEqual({ outcome: "timeout" })
    } finally {
      await server.stop(true)
    }
  })
})

describe("show text output", () => {
  test("names the round, the page and every note's authored body, as the protocol data has them", async () => {
    const state = await setup()
    await state.start()
    const page = await state.openPage()
    const round = state.sendMany(page.id, [
      { body: "Heading is too small on mobile" },
      { body: "Button label wraps" },
      { body: "Footer link colour fails contrast" },
    ])
    await state.run("show", [round.id, "--json"])
    const data = ShowResult.parse(JSON.parse(state.stdout.join("")))
    state.clear()
    expect(data.notes).toHaveLength(3)

    await state.run("show", [round.id])
    expect(state.exits).toEqual([ExitCode.ok])
    const text = state.stdout.join("")
    expect(text).toContain(`Round ${data.round.id}`)
    expect(text).toContain(`Page: ${data.round.pageId}`)
    for (const { authored } of data.notes) {
      expect(text).toContain(authored.id)
      expect(text).toContain(authored.body)
    }
    expect(text).not.toContain("undefined")
  })
})

describe("hook wait response failures", () => {
  test.each([
    ["a body that is not JSON", () => new Response("{broken", { status: 200 })],
    [
      "a body stream that fails after the headers",
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("connection reset"))
            },
          }),
          { status: 200 },
        ),
    ],
  ])("%s exits unavailable, once, without reconnecting", async (_name, reply) => {
    const state = await setup()
    await state.start()
    state.clear()
    const sent: string[] = []
    const broken = hc<ControlApp>("http://iter8", {
      fetch: async (input: RequestInfo | URL) => {
        sent.push(new URL(String(input)).pathname)
        return reply()
      },
    })
    state.deps.connect = async (options) => {
      state.connections.push(options)
      return broken
    }
    await state.run("hook", ["wait", "--pid", "9001", "--timeout-seconds", "600"])
    expect(state.exits).toEqual([ExitCode.serviceUnavailable])
    expect(state.connections).toEqual([{ start: true }])
    expect(sent).toEqual(["/hook/wait"])
    expect(state.stdout).toEqual([])
    expect(state.stderr).toEqual(["Lost iter8 control connection while waiting\n"])
  })
})

describe("note and done requests", () => {
  test("note sends exactly the given intent, body, every hop and the optional fields it was given", async () => {
    const state = await setup()
    const pairing = await state.start("claude")
    const page = await state.openPage()
    await state.run("note", [
      page.id,
      "--intent",
      "question",
      "--body",
      "Should this card keep its shadow?",
      "--at",
      "x-shell",
      "--at",
      "x-card >> .inner",
      "--at",
      "h2",
      "--role",
      "heading",
      "--name",
      "Pricing",
      "--text",
      "Pricing that scales",
      "--json",
    ])
    expect(state.exits).toEqual([ExitCode.ok])
    expect(state.requests[0]?.path).toBe("/note")
    expect(state.requests[0]?.body).toEqual({
      identities: [{ pid: 9001, startedAt: "linux:1:9001" }],
      owner: null,
      page: page.id,
      intent: "question",
      body: "Should this card keep its shadow?",
      at: ["x-shell", "x-card >> .inner", "h2"],
      role: "heading",
      name: "Pricing",
      text: "Pricing that scales",
    })
    const posted = JSON.parse(state.stdout.join("")).note
    expect(posted.author.owner).toBe(pairing.owner)
    expect(posted.body).toBe("Should this card keep its shadow?")
  })

  test("note leaves omitted optional fields out of the request", async () => {
    const state = await setup()
    await state.start("claude")
    const page = await state.openPage()
    await state.run("note", [page.id, "--intent", "fix", "--body", "Plain", "--at", "h1"])
    expect(state.exits).toEqual([ExitCode.ok])
    const body = state.requests[0]?.body as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(
      ["at", "body", "identities", "intent", "owner", "page"].sort(),
    )
    state.clear()
    await state.run("note", [
      page.id,
      "--intent",
      "fix",
      "--body",
      "Role",
      "--at",
      "h1",
      "--name",
      "N",
    ])
    const named = state.requests[0]?.body as Record<string, unknown>
    expect(Object.keys(named)).toContain("name")
    expect(Object.keys(named)).not.toContain("role")
    expect(Object.keys(named)).not.toContain("text")
  })

  test("done --reply sends the exact reply text and the service stores it", async () => {
    const state = await setup()
    await state.start()
    const page = await state.openPage()
    const round = state.send(page.id)
    const note = round.notes[0]
    if (!note) throw new Error("Missing note")
    const reply = '  Moved the padding to 12px — "tight" ✓  '

    await state.run("done", [note.id, "--reply", reply])
    expect(state.exits).toEqual([ExitCode.ok])
    expect(state.requests[0]?.body).toMatchObject({ note: note.id, reply })
    expect(state.inbox.round(round.id)?.notes[0]?.resolution).toEqual({
      status: "answered",
      reply,
      at: "2026-10-09T18:00:00.000Z",
    })
  })
})

describe("flag validation", () => {
  const validArgs = (pageId: string): Array<[string, string[]]> => [
    ["hook start", ["--pid", "9001", "--label", "session-9001", "--source", "startup"]],
    ["hook prompt", ["--pid", "9001"]],
    ["hook stop", ["--pid", "9001"]],
    ["hook wait", ["--pid", "9001", "--timeout-seconds", "0"]],
    ["hook end", ["--pid", "9001", "--label", "session-9001", "--reason", "logout"]],
    ["note", [pageId, "--intent", "fix", "--body", "Body", "--at", "h1"]],
  ]
  const argsOf = (name: string, args: string[]) => {
    const [root = "", child] = name.split(" ")
    return { root, args: child ? [child, ...args] : args }
  }
  const without = (args: string[], flag: string) => {
    const kept: string[] = []
    for (let index = 0; index < args.length; index++) {
      if (args[index] === `--${flag}`) index++
      else kept.push(args[index] ?? "")
    }
    return kept
  }
  const withValue = (args: string[], flag: string, value: string) =>
    args.map((arg, index) => (args[index - 1] === `--${flag}` ? value : arg))

  async function fresh() {
    const state = await setup()
    await state.start()
    const page = await state.openPage()
    return { state, page }
  }

  test("each command succeeds with all-valid args, and fails with usage naming the one flag left out", async () => {
    for (const [name] of validArgs("page")) {
      const baseline = await fresh()
      const [, args = []] = validArgs(baseline.page.id).find(([entry]) => entry === name) ?? []
      const { root, args: full } = argsOf(name, args)
      await baseline.state.run(root, full)
      expect({ name, exits: baseline.state.exits }).toEqual({ name, exits: [ExitCode.ok] })

      const required = CLI_SURFACE[name as keyof typeof CLI_SURFACE].flags.filter(
        (flag) => flag.required,
      )
      for (const flag of required) {
        const { state, page } = await fresh()
        const [, valid = []] = validArgs(page.id).find(([entry]) => entry === name) ?? []
        const target = argsOf(name, without(valid, flag.name))
        await state.run(target.root, target.args)
        expect({ name, flag: flag.name, exits: state.exits }).toEqual({
          name,
          flag: flag.name,
          exits: [ExitCode.usage],
        })
        expect(state.stderr.join("")).toContain(`--${flag.name}`)
        expect(state.connections).toEqual([])
      }
    }
  })

  test("an invalid intent, source or reason fails with usage naming the flag, with otherwise-valid args", async () => {
    for (const [name, flag] of [
      ["note", "intent"],
      ["hook start", "source"],
      ["hook end", "reason"],
    ] as const) {
      const { state, page } = await fresh()
      const [, valid = []] = validArgs(page.id).find(([entry]) => entry === name) ?? []
      const target = argsOf(name, withValue(valid, flag, "not-a-value"))
      await state.run(target.root, target.args)
      expect({ name, exits: state.exits }).toEqual({ name, exits: [ExitCode.usage] })
      expect(state.stderr.join("")).toContain(`--${flag}`)
      expect(state.connections).toEqual([])
    }
  })

  test("every allowed intent, source and reason is accepted and reaches the service as given", async () => {
    const cases = [
      ...Intent.options.map((value) => ["note", "intent", value] as const),
      ...HookSource.options.map((value) => ["hook start", "source", value] as const),
      ...HookEndReason.options.map((value) => ["hook end", "reason", value] as const),
    ]
    for (const [name, flag, value] of cases) {
      const { state, page } = await fresh()
      const [, valid = []] = validArgs(page.id).find(([entry]) => entry === name) ?? []
      const target = argsOf(name, withValue(valid, flag, value))
      await state.run(target.root, target.args)
      expect({ name, value, exits: state.exits }).toEqual({ name, value, exits: [ExitCode.ok] })
      expect({ ...(state.requests[0]?.body as Record<string, unknown>) }[flag]).toBe(value)
    }
  })

  test.each(["-1", "-5", "1.5", "1e3", "0x10", "9007199254740993", "abc", ""])(
    "pid and timeout %j are refused with usage before connecting",
    async (value) => {
      for (const [name, flag] of [
        ["hook prompt", "pid"],
        ["hook wait", "pid"],
        ["hook wait", "timeout-seconds"],
      ] as const) {
        for (const form of ["separate", "equals"] as const) {
          const { state, page } = await fresh()
          const [, valid = []] = validArgs(page.id).find(([entry]) => entry === name) ?? []
          const base = without(valid, flag)
          const given = form === "separate" ? [`--${flag}`, value] : [`--${flag}=${value}`]
          const target = argsOf(name, [...base, ...given])
          await state.run(target.root, target.args)
          expect({ name, flag, form, exits: state.exits }).toEqual({
            name,
            flag,
            form,
            exits: [ExitCode.usage],
          })
          expect(state.connections).toEqual([])
        }
      }
    },
  )

  test.each([
    ["hook start", "pid"],
    ["hook start", "label"],
    ["hook end", "label"],
    ["note", "intent"],
    ["note", "body"],
    ["note", "at"],
  ] as const)("%s with an explicit empty --%s is refused with usage", async (name, flag) => {
    const { state, page } = await fresh()
    const [, valid = []] = validArgs(page.id).find(([entry]) => entry === name) ?? []
    const target = argsOf(name, withValue(valid, flag, ""))
    await state.run(target.root, target.args)
    expect(state.exits).toEqual([ExitCode.usage])
    expect(state.connections).toEqual([])
  })
})

describe("hook commands for another process", () => {
  test("prompt, stop and end act on the owner of the given --pid, not the CLI's own, and start the service", async () => {
    const state = await setup()
    const own = await state.start("claude", 9001)
    const other = await state.start("claude", 9002)
    const stateOf = (owner: typeof own.owner) => state.owners.state(owner).status

    await state.run("hook", ["prompt", "--pid", "9002"])
    expect(state.exits).toEqual([ExitCode.ok])
    expect([stateOf(own.owner), stateOf(other.owner)]).toEqual(["live", "busy"])
    expect(state.connections).toEqual([{ start: true }])
    expect(state.requests[0]).toMatchObject({
      path: "/hook/prompt",
      body: { pid: 9002, startedAt: "linux:1:9002" },
    })
    state.clear()

    await state.run("hook", ["stop", "--pid", "9002"])
    expect([stateOf(own.owner), stateOf(other.owner)]).toEqual(["live", "live"])
    expect(state.connections).toEqual([{ start: true }])
    expect(state.requests[0]).toMatchObject({ path: "/hook/stop", body: { pid: 9002 } })
    state.clear()

    await state.run("hook", [
      "end",
      "--pid",
      "9002",
      "--label",
      "session-9002",
      "--reason",
      "logout",
    ])
    expect(state.exits).toEqual([ExitCode.ok])
    expect([stateOf(own.owner), stateOf(other.owner)]).toEqual(["live", "gone"])
    expect(state.connections).toEqual([{ start: true }])
    expect(state.requests[0]).toMatchObject({
      path: "/hook/end",
      body: { pid: 9002, startedAt: "linux:1:9002", label: "session-9002", reason: "logout" },
    })
  })
})

describe("open targets", () => {
  test.each([false, true])("hands the page to a connected laptop with json=%s", async (json) => {
    const state = await setup()
    const received: LaptopOpen[] = []
    const listener = await listenForPages({
      socketPath: join(state.home, "laptop-mac-0000abcd.sock"),
      accept(message) {
        received.push(message)
        return true
      },
    })
    try {
      await state.run("open", ["http://localhost:5173", ...(json ? ["--json"] : [])])
      const served = JSON.parse(
        state.responses.find((response) => response.path === "/open")?.body ?? "",
      )
      const opened = OpenResult.parse(served)
      expect(state.exits).toEqual([ExitCode.ok])
      expect(state.stderr).toEqual([])
      expect(received).toEqual([{ machineId: state.machineId, url: opened.url }])
      expect(state.requests[1]).toMatchObject({
        path: "/status",
        body: { owner: null, identities: [{ pid: 9001, startedAt: "linux:1:9001" }] },
      })
      expect(state.stdout).toHaveLength(1)
      if (json) expect(JSON.parse(state.stdout[0] ?? "")).toEqual(served)
      else {
        expect(state.stdout).toEqual([
          `${opened.url}\n${opened.landingUrl}\nOpened in the browser on mac.\n`,
        ])
      }
    } finally {
      await listener.close()
    }
  })

  test("--json prints exactly the open result the service returned when no laptop is connected", async () => {
    const state = await setup()
    await state.run("open", ["http://localhost:5173", "--json"])
    const served = JSON.parse(
      state.responses.find((response) => response.path === "/open")?.body ?? "",
    )
    expect(state.exits).toEqual([ExitCode.ok])
    expect(state.stdout).toHaveLength(1)
    expect(JSON.parse(state.stdout[0] ?? "")).toEqual(served)
  })

  test("names every laptop that accepted the page, joined with a comma and a space", async () => {
    const state = await setup()
    await state.run("open", ["http://localhost:5173", "--json"])
    const opened = OpenResult.parse(JSON.parse(state.stdout.join("")))
    state.clear()
    const received: LaptopOpen[][] = [[], []]
    const listeners = await Promise.all(
      ["alpha", "beta"].map((name, index) =>
        listenForPages({
          socketPath: join(state.home, `laptop-${name}-0000abcd.sock`),
          accept(message) {
            received[index]?.push(message)
            return true
          },
        }),
      ),
    )
    try {
      await state.run("open", ["http://localhost:5173"])
      expect(state.exits).toEqual([ExitCode.ok])
      expect(received).toEqual([
        [{ machineId: state.machineId, url: opened.url }],
        [{ machineId: state.machineId, url: opened.url }],
      ])
      expect(state.stdout).toEqual([
        `${opened.url}\n${opened.landingUrl}\nOpened in the browser on alpha, beta.\n`,
      ])
    } finally {
      for (const listener of listeners) await listener.close()
    }
  })

  test("hands the page to the accepting laptop when another refuses and a third is stale", async () => {
    const state = await setup()
    const offered: LaptopOpen[] = []
    const received: LaptopOpen[] = []
    const refusing = join(state.home, "laptop-alpha-0000abcd.sock")
    const accepting = join(state.home, "laptop-mac-0000abcd.sock")
    const stale = join(state.home, "laptop-zulu-0000abcd.sock")
    await leaveStaleSocket(stale)
    const listeners = [
      await listenForPages({
        socketPath: refusing,
        accept(message) {
          offered.push(message)
          return false
        },
      }),
      await listenForPages({
        socketPath: accepting,
        accept(message) {
          received.push(message)
          return true
        },
      }),
    ]
    try {
      await state.run("open", ["http://localhost:5173"])
      const opened = OpenResult.parse(servedOpen(state))
      const message = { machineId: state.machineId, url: opened.url }
      expect(state.exits).toEqual([ExitCode.ok])
      expect(state.stderr).toEqual([])
      expect(received).toEqual([message])
      expect(offered).toEqual([message])
      expect(state.stdout).toEqual([
        `${opened.url}\n${opened.landingUrl}\nOpened in the browser on mac.\n`,
      ])
      await expect(stat(stale)).rejects.toMatchObject({ code: "ENOENT" })
      expect((await stat(refusing)).isSocket()).toBe(true)
      expect((await stat(accepting)).isSocket()).toBe(true)
    } finally {
      for (const listener of listeners) await listener.close()
    }
  })

  test("each open announces its own url to the connected laptop", async () => {
    const directory = await tempDir()
    const file = join(directory, "a file.html")
    await writeFile(file, "<h1>Hello</h1>")
    const state = await setup()
    const received: LaptopOpen[] = []
    const listener = await listenForPages({
      socketPath: join(state.home, "laptop-mac-0000abcd.sock"),
      accept(message) {
        received.push(message)
        return true
      },
    })
    try {
      const served: OpenResult[] = []
      for (const target of [file, "http://localhost:5173/view?q=1", directory]) {
        await state.run("open", [target])
        expect(state.exits).toEqual([ExitCode.ok])
        const opened = OpenResult.parse(servedOpen(state))
        served.push(opened)
        expect(state.stdout).toEqual([
          `${opened.url}\n${opened.landingUrl}\nOpened in the browser on mac.\n`,
        ])
        state.clear()
      }
      expect(new Set(served.map((opened) => opened.url)).size).toBe(3)
      expect(new URL(served[0]?.url ?? "").pathname).toBe("/a%20file.html")
      expect(received).toEqual(
        served.map((opened) => ({ machineId: state.machineId, url: opened.url })),
      )
    } finally {
      await listener.close()
    }
  })

  const fallbacks: Record<
    string,
    (state: State) => Promise<{ verify(): Promise<void>; close(): Promise<void> }>
  > = {
    "a laptop refuses the page": async (state) => {
      const socketPath = join(state.home, "laptop-mac-0000abcd.sock")
      const offered: LaptopOpen[] = []
      const listener = await listenForPages({
        socketPath,
        accept(message) {
          offered.push(message)
          return false
        },
      })
      return {
        async verify() {
          expect(offered).toHaveLength(1)
          expect((await stat(socketPath)).isSocket()).toBe(true)
        },
        close: () => listener.close(),
      }
    },
    "a laptop socket is stale": async (state) => {
      const socketPath = join(state.home, "laptop-mac-0000abcd.sock")
      await leaveStaleSocket(socketPath)
      return {
        async verify() {
          await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" })
        },
        close: async () => {},
      }
    },
    "the status call loses its connection": async (state) => {
      state.failStatus("disconnected")
      return { verify: async () => {}, close: async () => {} }
    },
    "the status call is refused": async (state) => {
      state.failStatus("refused")
      return { verify: async () => {}, close: async () => {} }
    },
    "the status reply is invalid": async (state) => {
      state.failStatus("invalid")
      return { verify: async () => {}, close: async () => {} }
    },
  }

  test.each(Object.keys(fallbacks).flatMap((name) => [false, true].map((json) => [name, json])))(
    "when %s, open succeeds with its own urls and the connection hint, json=%s",
    async (name, json) => {
      const state = await setup()
      const arranged = await fallbacks[name as string]?.(state)
      if (!arranged) throw new Error(`Unknown branch ${name}`)
      try {
        await state.run("open", ["http://localhost:5173", ...(json ? ["--json"] : [])])
        const served = servedOpen(state)
        const opened = OpenResult.parse(served)
        expect(state.exits).toEqual([ExitCode.ok])
        expect(state.stderr).toEqual([])
        expect(state.stdout).toHaveLength(1)
        if (json) expect(JSON.parse(state.stdout[0] ?? "")).toEqual(served)
        else {
          expect(state.stdout).toEqual([`${opened.url}\n${opened.landingUrl}\n${connectHint()}\n`])
        }
        await arranged.verify()
      } finally {
        await arranged.close()
      }
    },
  )

  test("the status request carries the owner given with --owner", async () => {
    const state = await setup()
    const pairing = await state.start("claude")
    await state.run("open", ["http://localhost:5173", "--owner", pairing.owner])
    expect(state.exits).toEqual([ExitCode.ok])
    expect(state.requests.map((request) => request.path)).toEqual(["/open", "/status"])
    expect(state.requests[0]?.body).toMatchObject({ owner: pairing.owner })
    expect(state.requests[1]?.body).toEqual({
      owner: pairing.owner,
      identities: state.deps.ancestry(),
    })
  })

  test.each([
    "https://localhost:5173",
    "http://[::1]:5173",
    "http://127.0.0.2:3000",
    "http://127.255.255.254:8080/app",
    "http://app.localhost:5173",
    "http://a.b.localhost:5173/x?y=1",
  ])("accepts %s as a primary target", async (target) => {
    const state = await setup()
    await state.run("open", [target, "--json"])
    expect(state.exits).toEqual([ExitCode.ok])
    expect(state.requests[0]?.body).toMatchObject({
      target: { kind: "server", upstream: new URL(target).href },
    })
    const opened = OpenResult.parse(JSON.parse(state.stdout.join("")))
    expect(opened.page.target).toMatchObject({
      kind: "server",
      upstream: new URL(target).origin,
    })
  })

  test("prints the exact page url, landing url and forward hint", async () => {
    const state = await setup()
    await state.run("open", ["http://localhost:5173", "--json"])
    const page = OpenResult.parse(JSON.parse(state.stdout.join(""))).page
    state.clear()

    await state.run("open", ["http://localhost:5173"])
    expect(state.exits).toEqual([ExitCode.ok])
    const token = state.pages.get(page.id)?.token ?? ""
    const fragment = new URLSearchParams({ m: state.machineId, p: page.id, t: token })
    expect(state.stdout).toEqual([
      `${page.origin}/\n${page.origin}${LANDING_PATH}#${fragment}\nBrowser on another machine? Run there: iter8 connect ${hostname()} (or forward the pool yourself: ssh -N -o ExitOnForwardFailure=yes -L 3990:localhost:3990 -L 3991:localhost:3991 -L 3992:localhost:3992 -L 3993:localhost:3993 ${hostname()}).\n`,
    ])
    expect(page.origin).toMatch(/^http:\/\/[a-z][a-z0-9-]*\.localhost:3990$/)
  })
})
