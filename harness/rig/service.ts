import {
  LandingFragment,
  type MachineId,
  OpenResult,
  type OwnerId,
  type PageToken,
  ServiceStatus,
} from "@iter8/protocol"
import type { Page } from "playwright"
import type { AgentSession } from "./agent"
import { type CliEnv, type CliRun, childEnv, cliCommand, runCli } from "./cli"
import { throwawayHome } from "./home"
import { poolRange } from "./ports"
import { waitFor } from "./wait"

const POOL_SIZE = 4
const READY_TIMEOUT_MS = 30_000
const TERM_GRACE_MS = 5_000

export type StartServiceOptions = {
  /** A compiled `iter8` binary to run instead of the source entry. */
  binary?: string
  /** A script run under Bun as the CLI, such as the fake CLI. */
  entry?: string
  overlayDir?: string
  /** Extra variables for `serve` and every CLI run bound to it. */
  env?: Record<string, string>
}

export type RunningService = {
  home: string
  env: CliEnv
  pid: number
  poolPorts: number[]
  machineId: MachineId
  /** The `status --json` report that first said ready. */
  status: ServiceStatus
  cli(args: string[], options?: { cwd?: string }): Promise<CliRun>
  /** Everything `serve` has written to stdout and stderr so far. */
  logs(): string
  /** SIGTERM, then SIGKILL once the grace period passes; resolves when the process has exited. */
  stop(): Promise<void>
}

function rangePorts(range: string): number[] {
  const [first = 0, last = -1] = range.split("-").map(Number)
  return Array.from({ length: last - first + 1 }, (_, index) => first + index)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export async function startService(options: StartServiceOptions = {}): Promise<RunningService> {
  const home = await throwawayHome()
  const command =
    options.binary === undefined && options.entry !== undefined
      ? [process.execPath, options.entry]
      : cliCommand(options.binary)
  const env: CliEnv = {
    command,
    home,
    pool: await poolRange(POOL_SIZE),
    ...(options.overlayDir === undefined ? {} : { overlayDir: options.overlayDir }),
    ...(options.env === undefined ? {} : { vars: options.env }),
  }
  const child = Bun.spawn([...command, "serve"], {
    cwd: home,
    env: childEnv(env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })

  let output = ""
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) output += decoder.decode(chunk, { stream: true })
  }
  const drained = Promise.all([drain(child.stdout), drain(child.stderr)])
  const exited = () => child.exitCode !== null || child.signalCode !== null

  let stopping: Promise<void> | null = null
  const stop = () => {
    stopping ??= (async () => {
      if (exited()) return
      child.kill("SIGTERM")
      const grace = Bun.sleep(TERM_GRACE_MS).then(() => "grace-passed" as const)
      if ((await Promise.race([child.exited, grace])) === "grace-passed") child.kill("SIGKILL")
      await child.exited
    })()
    return stopping
  }

  const cli = (args: string[], cliOptions: { cwd?: string } = {}) =>
    runCli(env, args, { cwd: cliOptions.cwd ?? home })

  let status: ServiceStatus
  try {
    status = await waitFor(
      "the service to report ready through status --json",
      async () => {
        if (exited()) {
          throw new Error(
            `serve exited with code ${child.exitCode ?? child.signalCode} before reporting ready`,
          )
        }
        const run = await cli(["status", "--json"])
        if (run.exitCode !== 0) return null
        const parsed = ServiceStatus.safeParse(parseJson(run.stdout))
        return parsed.success && parsed.data.state === "ready" ? parsed.data : null
      },
      { timeoutMs: READY_TIMEOUT_MS, everyMs: 100 },
    )
  } catch (error) {
    await stop()
    await drained
    throw new Error(`${(error as Error).message}\nserve output:\n${output}`, { cause: error })
  }

  return {
    home,
    env,
    pid: child.pid,
    poolPorts: rangePorts(env.pool),
    machineId: status.machineId,
    status,
    cli,
    logs: () => output,
    stop,
  }
}

/**
 * Runs `open TARGET --json` as the session's child, so the CLI resolves the owner by ancestry, or
 * with `--owner`; then navigates `page` to the opened URL.
 */
export async function openThroughProxy(
  service: RunningService,
  page: Page,
  target: string,
  as: { session: AgentSession } | { owner: OwnerId },
): Promise<{ open: OpenResult; token: PageToken }> {
  const run =
    "session" in as
      ? await as.session.run(["open", target, "--json"])
      : await service.cli(["open", target, "--json", "--owner", as.owner])
  const open = run.json(OpenResult)
  const fragment = new URLSearchParams(new URL(open.landingUrl).hash.slice(1))
  const { t: token } = LandingFragment.parse(Object.fromEntries(fragment))
  await page.goto(open.url)
  return { open, token }
}
