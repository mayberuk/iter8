import { readFileSync, writeSync } from "node:fs"

/** Run with `[process.execPath, FAKE_TAILSCALE_ENTRY, ...tailscale argv]`. */
export const FAKE_TAILSCALE_ENTRY = import.meta.path

function main(args: string[]): number {
  if (args.join(" ") !== "status --json") {
    writeSync(2, `fake tailscale: unsupported arguments: ${args.join(" ")}\n`)
    return 2
  }
  const status = process.env.FAKE_TAILSCALE_STATUS
  if (status === undefined || status === "") {
    writeSync(2, "failed to connect to local tailscaled\n")
    return 1
  }
  writeSync(1, readFileSync(status, "utf8"))
  return 0
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
