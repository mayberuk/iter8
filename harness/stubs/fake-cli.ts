import { appendFileSync, existsSync, readFileSync, writeFileSync, writeSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  ENV,
  ExitCode,
  formatPointer,
  LANDING_PATH,
  OpenResult,
  PageToken,
  PortRange,
  PROTOCOL_VERSION,
  RoundPointer,
  ServiceStatus,
} from "@iter8/protocol"
import { z } from "zod"

/** Run with `[process.execPath, FAKE_CLI_ENTRY, ...args]`. */
export const FAKE_CLI_ENTRY = import.meta.path
export const FAKE_CLI_TOKEN = PageToken.parse("fakeCliPageToken_0123456789abcdefXYZ")
export const FAKE_CLI_VERSION = "0.0.0-fake"

/** One line of `FAKE_CLI_LOG`; `env` holds only `ITER8_*` and `CLAUDE_CODE_SESSION_ID`. */
export const FakeCliCall = z.object({
  argv: z.array(z.string()),
  cwd: z.string(),
  env: z.record(z.string(), z.string()),
  pid: z.number().int().positive(),
  ppid: z.number().int().nonnegative(),
})
export type FakeCliCall = z.infer<typeof FakeCliCall>

/** The content `FAKE_CLI_POINTERS` and the `FAKE_CLI_WAKE` file carry. */
export const FakePointers = z.array(RoundPointer)

export async function readFakeCliCalls(log: string): Promise<FakeCliCall[]> {
  const file = Bun.file(log)
  if (!(await file.exists())) return []
  return (await file.text())
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => FakeCliCall.parse(JSON.parse(line)))
}

const MACHINE_ID = "fake-machine"
const WAKE_POLL_MS = 25

function write(fd: 1 | 2, text: string): void {
  writeSync(fd, text.endsWith("\n") ? text : `${text}\n`)
}

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === "") {
    write(2, `fake iter8: ${name} is not set`)
    process.exit(ExitCode.usage)
  }
  return value
}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}

function poolPorts(): number[] {
  const [first, last] = PortRange.parse(required(ENV.pool)).split("-").map(Number)
  if (first === undefined || last === undefined) return []
  return Array.from({ length: last - first + 1 }, (_, index) => first + index)
}

function pointerLines(raw: string | undefined): string[] {
  if (raw === undefined || raw === "") return []
  return FakePointers.parse(JSON.parse(raw)).map(formatPointer)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function record(args: string[]): void {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        (entry[0].startsWith("ITER8_") || entry[0] === "CLAUDE_CODE_SESSION_ID"),
    ),
  )
  const call: FakeCliCall = {
    argv: args,
    cwd: process.cwd(),
    env,
    pid: process.pid,
    ppid: process.ppid,
  }
  appendFileSync(required("FAKE_CLI_LOG"), `${JSON.stringify(call)}\n`)
}

function serveMarker(): string {
  return join(required(ENV.home), "fake-serve.json")
}

function status(): ServiceStatus {
  const marker = serveMarker()
  const servePid = existsSync(marker)
    ? z.object({ pid: z.number() }).parse(JSON.parse(readFileSync(marker, "utf8"))).pid
    : null
  return ServiceStatus.parse({
    state: servePid === null ? "starting" : "ready",
    version: FAKE_CLI_VERSION,
    build: "fake",
    protocolVersion: PROTOCOL_VERSION,
    schemaVersion: 1,
    machineId: MACHINE_ID,
    machineName: "fake",
    pid: servePid ?? process.pid,
    home: required(ENV.home),
    pool: poolPorts(),
    overlay: process.env[ENV.overlayDir] === undefined ? "missing" : "present",
    owner: null,
  })
}

function open(target: string): OpenResult {
  const url = new URL(required("FAKE_CLI_OPEN_URL"))
  const pageId = url.hostname.split(".")[0] ?? ""
  const fragment = new URLSearchParams({ m: MACHINE_ID, p: pageId, t: FAKE_CLI_TOKEN })
  return OpenResult.parse({
    page: {
      id: pageId,
      origin: url.origin,
      target: /^https?:\/\//.test(target)
        ? { kind: "server", upstream: target, extraUpstreams: [] }
        : { kind: "folder", root: resolve(target) },
      pairing: null,
    },
    url: url.href,
    landingUrl: `${url.origin}${LANDING_PATH}#${fragment}`,
    poolPorts: poolPorts(),
  })
}

function serve(): Promise<number> {
  writeFileSync(serveMarker(), JSON.stringify({ pid: process.pid }))
  write(2, `fake iter8 serving as ${process.pid}`)
  return new Promise((done) => {
    const keepAlive = setInterval(() => {}, 1 << 30)
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => {
        clearInterval(keepAlive)
        done(ExitCode.ok)
      })
    }
  })
}

async function hookWait(args: string[]): Promise<number> {
  const pid = Number(flag(args, "pid"))
  const deadline = performance.now() + Number(flag(args, "timeout-seconds")) * 1000
  const wake = required("FAKE_CLI_WAKE")
  for (;;) {
    if (existsSync(wake)) {
      try {
        const lines = pointerLines(readFileSync(wake, "utf8"))
        for (const line of lines) write(2, line)
        return ExitCode.wake
      } catch {
        // A file caught mid-write parses on a later poll.
      }
    }
    if (performance.now() >= deadline || !alive(pid)) return ExitCode.ok
    await Bun.sleep(WAKE_POLL_MS)
  }
}

async function main(args: string[]): Promise<number> {
  record(args)
  const [command, sub] = args
  const json = args.includes("--json")

  if (command === "--version") {
    write(1, `iter8 ${FAKE_CLI_VERSION}`)
    return ExitCode.ok
  }
  if (command === "serve") return serve()
  if (command === "status") {
    const report = status()
    write(1, json ? JSON.stringify(report) : report.state)
    return ExitCode.ok
  }
  if (command === "open" && sub !== undefined && !sub.startsWith("--")) {
    const result = open(sub)
    write(1, json ? JSON.stringify(result) : result.url)
    return ExitCode.ok
  }
  if (command === "hook" && (sub === "start" || sub === "prompt")) {
    for (const line of pointerLines(process.env.FAKE_CLI_POINTERS)) write(1, line)
    return ExitCode.ok
  }
  if (command === "hook" && (sub === "stop" || sub === "end")) return ExitCode.ok
  if (command === "hook" && sub === "wait") return hookWait(args)

  write(2, `fake iter8: unsupported command: ${args.join(" ")}`)
  return ExitCode.usage
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
