import { chmod, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { HttpUrl, MachineId } from "@iter8/protocol"
import { z } from "zod"

export const LaptopOpen = z.object({ machineId: MachineId, url: HttpUrl })
export type LaptopOpen = z.infer<typeof LaptopOpen>

export function laptopSocketName(laptopName: string, nonce: string): string {
  const name = laptopName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 24)
  return `laptop-${name}-${nonce}.sock`
}

export function acceptablePage(
  message: LaptopOpen,
  expected: { machineId: string; ports: readonly number[] },
): boolean {
  const url = URL.parse(message.url)
  return (
    url !== null &&
    url.protocol === "http:" &&
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.localhost$/.test(url.hostname) &&
    expected.ports.includes(Number(url.port || 80)) &&
    url.username === "" &&
    url.password === "" &&
    message.machineId === expected.machineId
  )
}

export async function listenForPages(options: {
  socketPath: string
  accept: (message: LaptopOpen) => boolean
}): Promise<{ close(): Promise<void> }> {
  const server = Bun.serve({
    unix: options.socketPath,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/open") {
        return new Response(null, { status: 404 })
      }
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response(null, { status: 400 })
      }
      const message = LaptopOpen.safeParse(body)
      if (!message.success) return new Response(null, { status: 400 })
      return new Response(null, { status: options.accept(message.data) ? 204 : 403 })
    },
  })
  try {
    await chmod(options.socketPath, 0o600)
  } catch (error) {
    await server.stop(true)
    await rm(options.socketPath, { force: true })
    throw error
  }
  return {
    async close() {
      await server.stop(true)
      await rm(options.socketPath, { force: true })
    },
  }
}

export async function announceToLaptops(home: string, message: LaptopOpen): Promise<string[]> {
  const reached: string[] = []
  try {
    const body = JSON.stringify(message)
    for (const entry of await readdir(home)) {
      if (!entry.startsWith("laptop-") || !entry.endsWith(".sock")) continue
      const socketPath = join(home, entry)
      try {
        const response = await fetch("http://iter8/open", {
          unix: socketPath,
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(1000),
          redirect: "manual",
        })
        if (response.status === 204) {
          reached.push(entry.slice("laptop-".length, entry.lastIndexOf("-")))
        }
      } catch (error) {
        let code = error instanceof Error && "code" in error ? error.code : undefined
        // Bun's fetch masks Unix errno as FailedToOpenSocket, which cannot justify removing a socket.
        if (code === "FailedToOpenSocket") {
          try {
            const socket = await Bun.connect({ unix: socketPath, socket: { data() {} } })
            socket.end()
          } catch (error) {
            code = error instanceof Error && "code" in error ? error.code : undefined
          }
        }
        if (code === "ECONNREFUSED" || code === "ENOENT") {
          await rm(socketPath, { force: true }).catch(() => {})
        }
      }
    }
  } catch {}
  return reached
}
