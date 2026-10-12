import { realpath, stat } from "node:fs/promises"
import { isIP } from "node:net"
import { hostname } from "node:os"
import { basename, dirname, resolve } from "node:path"
import { CLI_SURFACE, ExitCode, HttpUrl, OpenResult, ServiceStatus } from "@iter8/protocol"
import { defineCommand } from "citty"
import { announceToLaptops } from "../../connect/page-channel"
import {
  type CliDeps,
  type ControlClient,
  caller,
  commandArgs,
  connect,
  printResult,
  repeatedFlag,
  request,
  runCli,
} from "../client"

function localUrl(input: string): string {
  const url = new URL(HttpUrl.parse(input))
  const host = url.hostname.toLowerCase()
  if (
    !(
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "[::1]" ||
      (isIP(host) === 4 && host.startsWith("127."))
    ) ||
    url.username ||
    url.password
  ) {
    throw new Error("Target must be an http(s) URL on a loopback host", { cause: ExitCode.usage })
  }
  return url.href
}

type OpenTarget = Parameters<ControlClient["open"]["$post"]>[0]["json"]["target"]

/** Opens the page and hands its URL to every connected laptop, returning the names reached. */
export async function openPage(
  deps: CliDeps,
  values: Parameters<typeof caller>[1],
  target: OpenTarget,
  upstreams: string[],
  cwd: string,
): Promise<{ opened: OpenResult; laptops: string[] }> {
  const body = { ...caller(deps, values), target, upstreams, cwd }
  const client = await connect(deps)
  const opened = OpenResult.parse(
    await (await request(() => client.open.$post({ json: body }))).json(),
  )
  let laptops: string[] = []
  try {
    const status = ServiceStatus.parse(
      await (await request(() => client.status.$post({ json: caller(deps, values) }))).json(),
    )
    const reached = await announceToLaptops(status.home, {
      machineId: status.machineId,
      url: opened.url,
    })
    laptops = reached.sort()
  } catch {}
  return { opened, laptops }
}

export const open = (deps: CliDeps) =>
  defineCommand({
    meta: { name: "open", description: CLI_SURFACE.open.summary },
    args: commandArgs("open"),
    run: ({ rawArgs }) =>
      runCli(deps, "open", rawArgs, async ({ values, positionals }) => {
        const input = positionals[0] ?? ""
        const path = resolve(deps.cwd, input)
        let info: Awaited<ReturnType<typeof stat>> | null = null
        try {
          info = await stat(path)
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              (error.code === "ENOENT" || error.code === "ENOTDIR")
            )
          )
            throw error
        }
        const target = info
          ? {
              kind: "folder" as const,
              root: await realpath(info.isDirectory() ? path : dirname(path)),
              file: info.isDirectory() ? null : basename(path),
            }
          : { kind: "server" as const, upstream: localUrl(input) }
        const { opened, laptops } = await openPage(
          deps,
          values,
          target,
          repeatedFlag(values, "upstream").map(localUrl),
          deps.cwd,
        )
        printResult(deps, "open", opened, values.json === true, () => {
          const forwards = opened.poolPorts.map((port) => `-L ${port}:localhost:${port}`).join(" ")
          const hint = laptops.length
            ? `Opened in the browser on ${laptops.join(", ")}.`
            : `Browser on another machine? Run there: iter8 connect ${hostname()} (or forward the pool yourself: ssh -N -o ExitOnForwardFailure=yes ${forwards} ${hostname()}).`
          return `${opened.url}\n${opened.landingUrl}\n${hint}\n`
        })
      }),
  })
