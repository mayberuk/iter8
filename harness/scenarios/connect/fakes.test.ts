import { expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import net from "node:net"
import { join } from "node:path"
import { throwawayHome } from "../../rig/home"
import { poolRange } from "../../rig/ports"
import { reapWithParent } from "../../rig/reap"
import { waitFor } from "../../rig/wait"
import { FAKE_SSH_ENTRY } from "./fake-ssh"
import { FAKE_TAILSCALE_ENTRY } from "./fake-tailscale"

const HOST = "devbox"
const SERVICE_ADDRESS = "127.0.0.1"
const SECOND_LOOPBACK = "127.0.0.2"
const READY_MS = 10_000
const EXIT_MS = 10_000

function bindFailure(): string | null {
  try {
    Bun.listen({ hostname: SECOND_LOOPBACK, port: 0, socket: { data() {} } }).stop(true)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const unbindable = bindFailure()
if (unbindable !== null) {
  console.info(
    `skipping the ${SECOND_LOOPBACK} forward: it cannot be bound (${unbindable}); it needs Linux's whole 127/8 loopback`,
  )
}

type Fake = {
  child: Bun.Subprocess<"ignore", "pipe", "pipe">
  stdout: Promise<string>
  stderr: Promise<string>
  stop(): Promise<void>
}

function spawnFake(entry: string, args: string[], vars: Record<string, string> = {}): Fake {
  const child = Bun.spawn([process.execPath, entry, ...args], {
    env: { ...process.env, ...vars },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  reapWithParent(child)
  return {
    child,
    stdout: new Response(child.stdout).text(),
    stderr: new Response(child.stderr).text(),
    async stop() {
      child.kill("SIGTERM")
      await child.exited
    },
  }
}

const ssh = (args: string[], vars?: Record<string, string>) => spawnFake(FAKE_SSH_ENTRY, args, vars)

async function teardown(steps: (() => Promise<unknown>)[]): Promise<void> {
  const failures: unknown[] = []
  for (const step of steps.reverse()) {
    try {
      await step()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "teardown failed")
}

async function ports(size: number): Promise<number[]> {
  const [first, last] = (await poolRange(size)).split("-").map(Number)
  if (first === undefined || last === undefined) throw new Error("poolRange returned no range")
  return Array.from({ length: last - first + 1 }, (_, index) => first + index)
}

function startTarget() {
  const received: string[] = []
  const listener = Bun.listen({
    hostname: SERVICE_ADDRESS,
    port: 0,
    socket: {
      data(socket, chunk) {
        received.push(chunk.toString())
        socket.write("pong")
      },
    },
  })
  return { port: listener.port, received, stop: async () => listener.stop(true) }
}

function exchange(hostname: string, port: number, send: string, expectedLength: number) {
  return new Promise<string>((resolve, reject) => {
    let received = ""
    Bun.connect({
      hostname,
      port,
      socket: {
        open(socket) {
          socket.write(send)
        },
        data(socket, chunk) {
          received += chunk.toString()
          if (received.length >= expectedLength) {
            socket.end()
            resolve(received)
          }
        },
        error(_socket, error) {
          reject(error)
        },
        close() {
          resolve(received)
        },
      },
    }).catch(reject)
  })
}

async function accepts(hostname: string, port: number): Promise<true | null> {
  try {
    const socket = await Bun.connect({ hostname, port, socket: { data() {} } })
    socket.end()
    return true
  } catch {
    return null
  }
}

async function forwardReady(fake: Fake, hostname: string, port: number): Promise<void> {
  await waitFor(
    `the forward on ${hostname}:${port} to accept connections`,
    async () => {
      if (fake.child.exitCode !== null) {
        throw new Error(`fake ssh exited (${fake.child.exitCode}): ${await fake.stderr}`)
      }
      return accepts(hostname, port)
    },
    { timeoutMs: READY_MS },
  )
}

const exited = (fake: Fake) =>
  waitFor("fake ssh to exit", async () => fake.child.exitCode ?? fake.child.signalCode, {
    timeoutMs: EXIT_MS,
  })

const PAYLOAD_BYTES = 8 * 1024 * 1024
const SLOW_READ_PAUSE_MS = 2
const TRANSFER_MS = 20_000

function collectSlowly(socket: net.Socket, size: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let length = 0
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk)
      length += chunk.length
      if (length >= size) return resolve(Buffer.concat(chunks))
      socket.pause()
      setTimeout(() => socket.resume(), SLOW_READ_PAUSE_MS)
    })
    socket.once("error", reject)
    socket.once("close", () => reject(new Error(`closed after ${length} of ${size} bytes`)))
  })
}

function listening(server: net.Server, listenOptions: net.ListenOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(listenOptions, resolve)
  })
}

function connected(connectOptions: net.NetConnectOpts): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(connectOptions, () => resolve(socket))
    socket.once("error", reject)
  })
}

async function pushBothWays(
  client: net.Socket,
  accepted: Promise<net.Socket>,
): Promise<{ sent: Buffer[]; received: Buffer[] }> {
  const toTarget = randomBytes(PAYLOAD_BYTES)
  const toClient = randomBytes(PAYLOAD_BYTES)
  const atClient = collectSlowly(client, PAYLOAD_BYTES)
  const target = await accepted
  const atTarget = collectSlowly(target, PAYLOAD_BYTES)
  client.write(toTarget)
  target.write(toClient)
  return { sent: [toTarget, toClient], received: await Promise.all([atTarget, atClient]) }
}

for (const forwardAddress of [undefined, SECOND_LOOPBACK]) {
  const listensOn = forwardAddress ?? SERVICE_ADDRESS
  test.skipIf(forwardAddress === SECOND_LOOPBACK && unbindable !== null)(
    `an -L forward on ${listensOn} carries bytes both ways, for each forward asked`,
    async () => {
      const steps: (() => Promise<unknown>)[] = []
      try {
        const target = startTarget()
        steps.push(target.stop)
        const [first, second] = await ports(2)
        const bind = forwardAddress === undefined ? "" : `${forwardAddress}:`
        const fake = ssh([
          "-N",
          "-o",
          "BatchMode=yes",
          "-L",
          `${bind}${first}:${SERVICE_ADDRESS}:${target.port}`,
          "-L",
          `${bind}${second}:${SERVICE_ADDRESS}:${target.port}`,
          "--",
          HOST,
        ])
        steps.push(() => fake.stop())

        for (const port of [first, second]) {
          await forwardReady(fake, listensOn, port ?? 0)
          expect(await exchange(listensOn, port ?? 0, `ping-${port}`, 4)).toBe("pong")
          expect(target.received).toContain(`ping-${port}`)
        }
      } finally {
        await teardown(steps)
      }
    },
    30_000,
  )
}

test("each -L forward reaches its own upstream, on the port and host it names", async () => {
  const steps: (() => Promise<unknown>)[] = []
  try {
    const secondHost = unbindable === null ? SECOND_LOOPBACK : SERVICE_ADDRESS
    const upstreams = [SERVICE_ADDRESS, secondHost].map((hostname, index) => {
      const listener = Bun.listen({
        hostname,
        port: 0,
        socket: {
          data(socket) {
            socket.write(`upstream-${index}`)
          },
        },
      })
      steps.push(async () => listener.stop(true))
      return listener
    })
    const [first, second] = await ports(2)
    const [one, two] = upstreams
    const fake = ssh([
      "-N",
      "-L",
      `${first}:${SERVICE_ADDRESS}:${one?.port}`,
      "-L",
      `${second}:${secondHost}:${two?.port}`,
      "--",
      HOST,
    ])
    steps.push(() => fake.stop())
    await forwardReady(fake, SERVICE_ADDRESS, first ?? 0)
    await forwardReady(fake, SERVICE_ADDRESS, second ?? 0)

    expect(await exchange(SERVICE_ADDRESS, first ?? 0, "who", 10)).toBe("upstream-0")
    expect(await exchange(SERVICE_ADDRESS, second ?? 0, "who", 10)).toBe("upstream-1")
  } finally {
    await teardown(steps)
  }
}, 30_000)

test("an -R forward carries a unix-socket HTTP request from the remote path to the local one", async () => {
  const steps: (() => Promise<unknown>)[] = []
  try {
    const home = await throwawayHome()
    steps.push(home.dispose)
    const localPath = join(home.path, "local.sock")
    const remotePath = join(home.path, "remote.sock")
    const bodies: string[] = []
    const server = Bun.serve({
      unix: localPath,
      async fetch(request) {
        bodies.push(`${request.method} ${new URL(request.url).pathname} ${await request.text()}`)
        return new Response("opened")
      },
    })
    steps.push(async () => server.stop(true))

    const fake = ssh(["-N", "-R", `${remotePath}:${localPath}`, "--", HOST])
    steps.push(() => fake.stop())
    await waitFor("the remote socket to exist", async () => existsSync(remotePath) || null, {
      timeoutMs: READY_MS,
    })

    const response = await fetch("http://remote/open", {
      method: "POST",
      body: "hello",
      unix: remotePath,
    })
    expect(await response.text()).toBe("opened")
    expect(bodies).toEqual(["POST /open hello"])
  } finally {
    await teardown(steps)
  }
}, 30_000)

test(
  "an -L forward delivers a large binary payload intact both ways to slow readers",
  async () => {
    const steps: (() => Promise<unknown>)[] = []
    try {
      const accepted = Promise.withResolvers<net.Socket>()
      const connections: net.Socket[] = []
      const target = net.createServer((socket) => {
        connections.push(socket)
        accepted.resolve(socket)
      })
      steps.push(async () => {
        target.close()
        for (const socket of connections) socket.destroy()
      })
      await listening(target, { host: SERVICE_ADDRESS, port: 0 })
      const targetPort = (target.address() as net.AddressInfo).port
      const probed = startTarget()
      steps.push(probed.stop)
      const [port, probePort] = await ports(2)
      const fake = ssh([
        "-N",
        "-L",
        `${port}:${SERVICE_ADDRESS}:${targetPort}`,
        "-L",
        `${probePort}:${SERVICE_ADDRESS}:${probed.port}`,
        "--",
        HOST,
      ])
      steps.push(() => fake.stop())
      // Both listeners bind in one synchronous loop, so the probed one accepting means the other is bound.
      await forwardReady(fake, SERVICE_ADDRESS, probePort ?? 0)

      const client = await connected({ host: SERVICE_ADDRESS, port: port ?? 0 })
      steps.push(async () => client.destroy())
      const { sent, received } = await pushBothWays(client, accepted.promise)
      expect(received[0]?.equals(sent[0] ?? Buffer.alloc(0))).toBe(true)
      expect(received[1]?.equals(sent[1] ?? Buffer.alloc(0))).toBe(true)
    } finally {
      await teardown(steps)
    }
  },
  TRANSFER_MS,
)

test(
  "an -R forward delivers a large binary payload intact both ways to slow readers",
  async () => {
    const steps: (() => Promise<unknown>)[] = []
    try {
      const home = await throwawayHome()
      steps.push(home.dispose)
      const localPath = join(home.path, "local.sock")
      const remotePath = join(home.path, "remote.sock")
      const accepted = Promise.withResolvers<net.Socket>()
      const connections: net.Socket[] = []
      const target = net.createServer((socket) => {
        connections.push(socket)
        accepted.resolve(socket)
      })
      steps.push(async () => {
        target.close()
        for (const socket of connections) socket.destroy()
      })
      await listening(target, { path: localPath })
      const fake = ssh(["-N", "-R", `${remotePath}:${localPath}`, "--", HOST])
      steps.push(() => fake.stop())
      await waitFor("the remote socket to exist", async () => existsSync(remotePath) || null, {
        timeoutMs: READY_MS,
      })

      const client = await connected({ path: remotePath })
      steps.push(async () => client.destroy())
      const { sent, received } = await pushBothWays(client, accepted.promise)
      expect(received[0]?.equals(sent[0] ?? Buffer.alloc(0))).toBe(true)
      expect(received[1]?.equals(sent[1] ?? Buffer.alloc(0))).toBe(true)
    } finally {
      await teardown(steps)
    }
  },
  TRANSFER_MS,
)

test("SIGTERM removes the remote socket and SIGKILL leaves it, which then refuses a second bind", async () => {
  const steps: (() => Promise<unknown>)[] = []
  try {
    const home = await throwawayHome()
    steps.push(home.dispose)
    const remotePath = join(home.path, "remote.sock")
    const args = ["-N", "-R", `${remotePath}:${join(home.path, "local.sock")}`, "--", HOST]
    const socketExists = async () => existsSync(remotePath) || null

    const terminated = ssh(args)
    steps.push(() => terminated.stop())
    await waitFor("the remote socket to exist", socketExists, { timeoutMs: READY_MS })
    terminated.child.kill("SIGTERM")
    await exited(terminated)
    expect(existsSync(remotePath)).toBe(false)

    const killed = ssh(args)
    steps.push(() => killed.stop())
    await waitFor("the remote socket to exist again", socketExists, { timeoutMs: READY_MS })
    killed.child.kill("SIGKILL")
    await exited(killed)
    expect(existsSync(remotePath)).toBe(true)

    const refused = ssh(args)
    steps.push(() => refused.stop())
    expect(await exited(refused)).toBe(255)
    expect(await refused.stderr).toBe(
      `Warning: remote port forwarding failed for listen path ${remotePath}\n`,
    )
  } finally {
    await teardown(steps)
  }
}, 30_000)

test("FAKE_SSH_REFUSE_STREAMLOCAL refuses -R with OpenSSH's wording and exit 255", async () => {
  const steps: (() => Promise<unknown>)[] = []
  try {
    const home = await throwawayHome()
    steps.push(home.dispose)
    const remotePath = join(home.path, "remote.sock")
    const fake = ssh(["-N", "-R", `${remotePath}:${join(home.path, "local.sock")}`, "--", HOST], {
      FAKE_SSH_REFUSE_STREAMLOCAL: "1",
    })
    steps.push(() => fake.stop())

    expect(await exited(fake)).toBe(255)
    expect(await fake.stderr).toBe(
      `Warning: remote port forwarding failed for listen path ${remotePath}\n`,
    )
    expect(existsSync(remotePath)).toBe(false)
  } finally {
    await teardown(steps)
  }
}, 30_000)

test("a pre-bound -L port prints OpenSSH's three bind-failure lines and exits 255", async () => {
  const steps: (() => Promise<unknown>)[] = []
  try {
    const [port] = await ports(1)
    if (port === undefined) throw new Error("no port")
    const holder = Bun.listen({ hostname: SERVICE_ADDRESS, port, socket: { data() {} } })
    steps.push(async () => holder.stop(true))

    const fake = ssh(["-N", "-L", `${port}:${SERVICE_ADDRESS}:9`, "--", HOST])
    steps.push(() => fake.stop())

    expect(await exited(fake)).toBe(255)
    expect(await fake.stderr).toBe(
      [
        `bind [${SERVICE_ADDRESS}]:${port}: Address already in use`,
        `channel_setup_fwd_listener_tcpip: cannot listen to port: ${port}`,
        "Could not request local forwarding.",
        "",
      ].join("\n"),
    )
  } finally {
    await teardown(steps)
  }
}, 30_000)

test("FAKE_SSH_DOWN appearing ends a running forward with 255 and refuses new invocations", async () => {
  const steps: (() => Promise<unknown>)[] = []
  try {
    const home = await throwawayHome()
    steps.push(home.dispose)
    const down = join(home.path, "down")
    const target = startTarget()
    steps.push(target.stop)
    const [port] = await ports(1)
    if (port === undefined) throw new Error("no port")

    const running = ssh(["-N", "-L", `${port}:${SERVICE_ADDRESS}:${target.port}`, "--", HOST], {
      FAKE_SSH_DOWN: down,
    })
    steps.push(() => running.stop())
    await forwardReady(running, SERVICE_ADDRESS, port)
    expect(running.child.exitCode).toBeNull()

    await Bun.write(down, "")
    expect(await exited(running)).toBe(255)

    const refused = ssh(["-o", "BatchMode=yes", "--", HOST, "true"], { FAKE_SSH_DOWN: down })
    steps.push(() => refused.stop())
    expect(await exited(refused)).toBe(255)
    expect(await refused.stderr).toBe(
      `ssh: connect to host ${HOST} port 22: Network is unreachable\n`,
    )
  } finally {
    await teardown(steps)
  }
}, 30_000)

test("-G prints the host it was given and a user", async () => {
  const fake = ssh(["-G", "--", HOST])
  expect(await exited(fake)).toBe(0)
  expect(await fake.stdout).toBe(`hostname ${HOST}\nuser test\n`)
})

test("a remote iter8 command runs the configured binary with the remote env and passes its exit code", async () => {
  const steps: (() => Promise<unknown>)[] = []
  try {
    const home = await throwawayHome()
    steps.push(home.dispose)
    const standIn = join(home.path, "iter8-stand-in.ts")
    await Bun.write(
      standIn,
      [
        "console.log(JSON.stringify({ argv: process.argv.slice(2), home: process.env.ITER8_HOME, pool: process.env.ITER8_POOL }))",
        'console.error("stand-in diagnostics")',
        "process.exit(5)",
      ].join("\n"),
    )
    const log = join(home.path, "ssh.log")
    const args = ["-o", "BatchMode=yes", "--", HOST, "iter8", "status", "--json"]
    const fake = ssh(args, {
      FAKE_SSH_ITER8: JSON.stringify([process.execPath, standIn]),
      FAKE_SSH_REMOTE_ENV: JSON.stringify({ ITER8_HOME: "/remote/home", ITER8_POOL: "7000-7009" }),
      FAKE_SSH_LOG: log,
    })
    steps.push(() => fake.stop())

    expect(await exited(fake)).toBe(5)
    expect(JSON.parse(await fake.stdout)).toEqual({
      argv: ["status", "--json"],
      home: "/remote/home",
      pool: "7000-7009",
    })
    expect(await fake.stderr).toBe("stand-in diagnostics\n")
    expect(
      (await Bun.file(log).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([{ argv: args, pid: fake.child.pid }])
  } finally {
    await teardown(steps)
  }
}, 30_000)

test("fake tailscale prints the file FAKE_TAILSCALE_STATUS names, and fails when it is unset", async () => {
  const steps: (() => Promise<unknown>)[] = []
  try {
    const home = await throwawayHome()
    steps.push(home.dispose)
    const status = join(home.path, "status.json")
    const body = JSON.stringify({ BackendState: "Running", Peer: {} })
    await Bun.write(status, body)

    const printed = spawnFake(FAKE_TAILSCALE_ENTRY, ["status", "--json"], {
      FAKE_TAILSCALE_STATUS: status,
    })
    steps.push(() => printed.stop())
    expect(await exited(printed)).toBe(0)
    expect(await printed.stdout).toBe(body)

    const unset = spawnFake(FAKE_TAILSCALE_ENTRY, ["status", "--json"], {
      FAKE_TAILSCALE_STATUS: "",
    })
    steps.push(() => unset.stop())
    expect(await exited(unset)).toBe(1)
    expect(await unset.stderr).toBe("failed to connect to local tailscaled\n")
  } finally {
    await teardown(steps)
  }
}, 30_000)
