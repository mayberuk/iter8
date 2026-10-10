import { readFileSync } from "node:fs"
import type { ProcessIdentity } from "@iter8/protocol"

export type ProcessKey = Pick<ProcessIdentity, "pid" | "startedAt">

export function parseLinuxStat(stat: string): { ppid: number; startTicks: string } | null {
  if (!/^[1-9]\d* \(/.test(stat)) return null
  const closingParen = stat.lastIndexOf(")")
  if (closingParen < 0 || !/^\s/.test(stat.slice(closingParen + 1))) return null
  const fields = stat
    .slice(closingParen + 1)
    .trim()
    .split(/\s+/)
  const state = fields[0]
  const parent = fields[1]
  const startTicks = fields[19]
  if (
    fields.length < 20 ||
    !state ||
    !/^[RSDZTWtXxKPI]$/.test(state) ||
    !parent ||
    !/^\d+$/.test(parent) ||
    !startTicks ||
    !/^\d+$/.test(startTicks) ||
    !fields.slice(1).every((field) => /^-?\d+$/.test(field))
  ) {
    return null
  }
  const ppid = Number(parent)
  return Number.isSafeInteger(ppid) ? { ppid, startTicks } : null
}

function readLinuxBootTime(): string | null {
  return /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1] ?? null
}

export function readProcessStart(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    if (process.platform === "linux") {
      const stat = parseLinuxStat(readFileSync(`/proc/${pid}/stat`, "utf8"))
      const bootTime = readLinuxBootTime()
      return stat && bootTime ? `linux:${bootTime}:${stat.startTicks}` : null
    }
    if (process.platform === "darwin") {
      const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
        env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      })
      if (result.exitCode !== 0) return null
      const startedAt = result.stdout.toString().trim()
      return startedAt ? `darwin:${startedAt}` : null
    }
  } catch {
    return null
  }
  return null
}

export function processAncestry(pid: number): ProcessKey[] {
  if (!Number.isSafeInteger(pid) || pid <= 0) return []
  const ancestry: ProcessKey[] = []
  try {
    if (process.platform === "linux") {
      const bootTime = readLinuxBootTime()
      if (!bootTime) return []
      while (pid > 0 && ancestry.length < 64) {
        const stat = parseLinuxStat(readFileSync(`/proc/${pid}/stat`, "utf8"))
        if (!stat) break
        ancestry.push({ pid, startedAt: `linux:${bootTime}:${stat.startTicks}` })
        if (pid === 1) break
        pid = stat.ppid
      }
    } else if (process.platform === "darwin") {
      const result = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,lstart="], {
        env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      })
      if (result.exitCode !== 0) return []
      const processes = new Map<number, { ppid: number; startedAt: string }>()
      for (const line of result.stdout.toString().split("\n")) {
        const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(line.trim())
        if (!match) continue
        const processPid = Number(match[1])
        const ppid = Number(match[2])
        const start = match[3]
        if (!Number.isSafeInteger(processPid) || !Number.isSafeInteger(ppid) || !start) continue
        processes.set(processPid, { ppid, startedAt: `darwin:${start}` })
      }
      while (pid > 0 && ancestry.length < 64) {
        const entry = processes.get(pid)
        if (!entry) break
        ancestry.push({ pid, startedAt: entry.startedAt })
        if (pid === 1) break
        pid = entry.ppid
      }
    }
  } catch {
    return ancestry
  }
  return ancestry
}
