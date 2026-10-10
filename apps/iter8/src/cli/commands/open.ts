import { realpath, stat } from "node:fs/promises"
import { isIP } from "node:net"
import { hostname } from "node:os"
import { basename, dirname, resolve } from "node:path"
import { CLI_SURFACE, ExitCode, HttpUrl, OpenResult } from "@iter8/protocol"
import { defineCommand } from "citty"
import {
  type CliDeps,
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
        const body = {
          ...caller(deps, values),
          target,
          upstreams: repeatedFlag(values, "upstream").map(localUrl),
          cwd: deps.cwd,
        }
        const client = await connect(deps)
        const result = await (await request(() => client.open.$post({ json: body }))).json()
        printResult(deps, "open", result, values.json === true, (data) => {
          const opened = OpenResult.parse(data)
          const forwards = opened.poolPorts.map((port) => `-L ${port}:localhost:${port}`).join(" ")
          return `${opened.url}\n${opened.landingUrl}\nBrowser on another machine? Forward the pool once: ssh -N -o ExitOnForwardFailure=yes ${forwards} ${hostname()}. If the landing page shows anything but iter8, that port is taken on your laptop.\n`
        })
      }),
  })
