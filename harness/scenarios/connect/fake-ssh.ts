import { appendFileSync, existsSync, unlinkSync, writeSync } from "node:fs"
import type { Socket } from "bun"

/** Run with `[process.execPath, FAKE_SSH_ENTRY, ...ssh argv]`. */
export const FAKE_SSH_ENTRY = import.meta.path

const DOWN_POLL_MS = 200
const FAILURE = 255
const COMMAND_NOT_FOUND = 127

type Endpoint = { hostname: string; port: number } | { unix: string }
type LocalForward = { bind: string; port: number; target: { hostname: string; port: number } }
type RemoteForward = { remotePath: string; localPath: string }

type Parsed = {
  noCommand: boolean
  describe: boolean
  locals: LocalForward[]
  remotes: RemoteForward[]
  host: string | undefined
  command: string[]
}

function write(fd: 1 | 2, text: string): void {
  writeSync(fd, text.endsWith("\n") ? text : `${text}\n`)
}

function parseLocal(spec: string): LocalForward {
  const parts = spec.split(":")
  const [bind, listen, host, targetPort] = parts.length === 3 ? ["127.0.0.1", ...parts] : parts
  if (parts.length < 3 || parts.length > 4 || !bind || !listen || !host || !targetPort) {
    throw new Error(`bad -L specification: ${spec}`)
  }
  return {
    bind,
    port: Number(listen),
    target: { hostname: host, port: Number(targetPort) },
  }
}

function parseRemote(spec: string): RemoteForward {
  const split = spec.indexOf(":")
  if (split < 1 || split === spec.length - 1) throw new Error(`bad -R specification: ${spec}`)
  return { remotePath: spec.slice(0, split), localPath: spec.slice(split + 1) }
}

function parse(args: string[]): Parsed {
  const parsed: Parsed = {
    noCommand: false,
    describe: false,
    locals: [],
    remotes: [],
    host: undefined,
    command: [],
  }
  let index = 0
  for (; index < args.length && args[index] !== "--"; index++) {
    const arg = args[index]
    if (arg === "-N") parsed.noCommand = true
    else if (arg === "-G") parsed.describe = true
    else if (arg === "-o") index++
    else if (arg === "-L") parsed.locals.push(parseLocal(args[++index] ?? ""))
    else if (arg === "-R") parsed.remotes.push(parseRemote(args[++index] ?? ""))
  }
  parsed.host = args[index + 1]
  parsed.command = args.slice(index + 2)
  return parsed
}

function recordInvocation(args: string[]): void {
  const log = process.env.FAKE_SSH_LOG
  if (log === undefined || log === "") return
  appendFileSync(log, `${JSON.stringify({ argv: args, pid: process.pid })}\n`)
}

const linkIsDown = () => {
  const marker = process.env.FAKE_SSH_DOWN
  return marker !== undefined && marker !== "" && existsSync(marker)
}

type End = { socket: Socket<Link> | null; backlog: Uint8Array[]; ending: boolean }
type Link = { self: End; peer: End }

// Bun sockets do not buffer: a short write leaves the rest for the next drain.
function flush(end: End): void {
  const { socket } = end
  if (socket === null) return
  for (let chunk = end.backlog[0]; chunk !== undefined; chunk = end.backlog[0]) {
    const written = socket.write(chunk)
    if (written < chunk.byteLength) {
      end.backlog[0] = chunk.subarray(Math.max(written, 0))
      return
    }
    end.backlog.shift()
  }
  if (end.ending) socket.end()
}

function pipeForward(listenAt: Endpoint, target: Endpoint): { stop(): void } {
  const open = new Set<Socket<Link>>()
  const finish = (end: End) => {
    end.ending = true
    flush(end)
  }
  const handlers = {
    data(socket: Socket<Link>, chunk: Uint8Array) {
      socket.data.peer.backlog.push(new Uint8Array(chunk))
      flush(socket.data.peer)
    },
    drain(socket: Socket<Link>) {
      flush(socket.data.self)
    },
    close(socket: Socket<Link>) {
      open.delete(socket)
      finish(socket.data.peer)
    },
    error(socket: Socket<Link>) {
      socket.end()
    },
  }
  const clientSocket = {
    ...handlers,
    open(client: Socket<Link>) {
      const clientEnd: End = { socket: client, backlog: [], ending: false }
      const upstreamEnd: End = { socket: null, backlog: [], ending: false }
      client.data = { self: clientEnd, peer: upstreamEnd }
      open.add(client)
      const data = { self: upstreamEnd, peer: clientEnd }
      const socket = {
        ...handlers,
        open(upstream: Socket<Link>) {
          upstreamEnd.socket = upstream
          open.add(upstream)
          flush(upstreamEnd)
        },
        connectError() {
          client.end()
        },
      }
      const connecting =
        "unix" in target
          ? Bun.connect<Link>({ unix: target.unix, data, socket })
          : Bun.connect<Link>({ hostname: target.hostname, port: target.port, data, socket })
      connecting.catch(() => client.end())
    },
  }
  const listener =
    "unix" in listenAt
      ? Bun.listen<Link>({ unix: listenAt.unix, socket: clientSocket })
      : Bun.listen<Link>({ hostname: listenAt.hostname, port: listenAt.port, socket: clientSocket })
  return {
    stop() {
      listener.stop(true)
      for (const socket of open) socket.end()
      open.clear()
    },
  }
}

function removeFile(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

function localBindFailure(forward: LocalForward, error: unknown): void {
  const reason =
    (error as NodeJS.ErrnoException).code === "EADDRINUSE"
      ? "Address already in use"
      : error instanceof Error
        ? error.message
        : String(error)
  write(2, `bind [${forward.bind}]:${forward.port}: ${reason}`)
  write(2, `channel_setup_fwd_listener_tcpip: cannot listen to port: ${forward.port}`)
  write(2, "Could not request local forwarding.")
}

async function holdForwards(parsed: Parsed, host: string): Promise<number> {
  const stoppers: (() => void)[] = []
  const stopAll = () => {
    for (const stop of stoppers) stop()
  }
  const removals: string[] = []

  for (const forward of parsed.locals) {
    try {
      const bound = pipeForward(
        { hostname: forward.bind, port: forward.port },
        { hostname: forward.target.hostname, port: forward.target.port },
      )
      stoppers.push(() => bound.stop())
    } catch (error) {
      localBindFailure(forward, error)
      stopAll()
      return FAILURE
    }
  }

  const refuseStreamlocal = (process.env.FAKE_SSH_REFUSE_STREAMLOCAL ?? "") !== ""
  for (const forward of parsed.remotes) {
    try {
      // sshd's StreamLocalBindUnlink defaults to no, so a stale socket file refuses the bind.
      if (refuseStreamlocal || existsSync(forward.remotePath)) throw new Error("refused")
      const bound = pipeForward({ unix: forward.remotePath }, { unix: forward.localPath })
      stoppers.push(() => bound.stop())
      removals.push(forward.remotePath)
    } catch {
      write(2, `Warning: remote port forwarding failed for listen path ${forward.remotePath}`)
      stopAll()
      for (const path of removals) removeFile(path)
      return FAILURE
    }
  }

  return new Promise<number>((done) => {
    const watch = setInterval(() => {
      if (!linkIsDown()) return
      clearInterval(watch)
      write(2, `Timeout, server ${host} not responding.`)
      stopAll()
      done(FAILURE)
    }, DOWN_POLL_MS)
    process.once("SIGTERM", () => {
      clearInterval(watch)
      stopAll()
      for (const path of removals) removeFile(path)
      done(FAILURE)
    })
  })
}

async function runRemote(command: string[]): Promise<number> {
  const [first, ...rest] = command
  if (first === undefined) return 0
  let argv = command
  if (first === "iter8") {
    const iter8 = process.env.FAKE_SSH_ITER8
    if (iter8 === undefined || iter8 === "") {
      write(2, "fake ssh: FAKE_SSH_ITER8 is not set")
      return FAILURE
    }
    argv = [...(JSON.parse(iter8) as string[]), ...rest]
  }
  const remoteEnv = JSON.parse(process.env.FAKE_SSH_REMOTE_ENV ?? "{}") as Record<string, string>
  try {
    const child = Bun.spawn(argv, {
      env: { ...process.env, ...remoteEnv },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
    return (await child.exited) ?? FAILURE
  } catch {
    write(2, `sh: 1: ${first}: not found`)
    return COMMAND_NOT_FOUND
  }
}

async function main(args: string[]): Promise<number> {
  recordInvocation(args)
  const parsed = parse(args)
  const host = parsed.host
  if (host === undefined) {
    write(2, "usage: ssh [options] -- host [command]")
    return FAILURE
  }
  if (linkIsDown()) {
    write(2, `ssh: connect to host ${host} port 22: Network is unreachable`)
    return FAILURE
  }
  if (parsed.describe) {
    write(1, `hostname ${host}`)
    write(1, "user test")
    return 0
  }
  if (parsed.noCommand) return holdForwards(parsed, host)
  return runRemote(parsed.command)
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
