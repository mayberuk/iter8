import { expect, test } from "bun:test"
import { launchChromium, newPage } from "../../rig/browser"
import { nextPort } from "../../rig/ports"

test("localhost hostnames isolate origins and provide secure browser APIs without flags", async () => {
  const port = await nextPort()
  const hosts: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request, server) {
      const host = request.headers.get("host") ?? ""
      hosts.push(host)
      const url = new URL(request.url)
      if (host !== `alpha.localhost:${port}` && host !== `beta.localhost:${port}`) {
        return new Response("Unknown page", { status: 404 })
      }
      if (url.pathname === "/echo" && server.upgrade(request, { data: undefined })) return
      if (url.pathname === "/cookie") return new Response(request.headers.get("cookie") ?? "")
      if (url.pathname === "/worker.js") {
        return new Response(
          'self.addEventListener("activate", event => event.waitUntil(self.clients.claim()))',
          {
            headers: { "content-type": "text/javascript" },
          },
        )
      }
      const script = host.startsWith("alpha.")
        ? 'document.cookie = "iter8-alpha=isolated; Path=/; SameSite=Lax"; localStorage.setItem("iter8-alpha", "isolated")'
        : ""
      return new Response(`<!doctype html><title>${host}</title><script>${script}</script>`, {
        headers: { "content-type": "text/html" },
      })
    },
    websocket: {
      message(socket, message) {
        socket.send(message)
      },
    },
  })
  let version = "not launched"
  try {
    const browser = await launchChromium()
    version = browser.version()
    try {
      const { page, errors, close } = await newPage(browser)
      try {
        await page.goto(`http://alpha.localhost:${port}/`)
        expect(hosts).toContain(`alpha.localhost:${port}`)
        expect(await page.evaluate(() => window.isSecureContext)).toBe(true)
        expect(await page.evaluate(() => crypto.randomUUID())).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        )
        expect(await page.evaluate(() => typeof navigator.serviceWorker)).toBe("object")
        expect(
          await page.evaluate(() => fetch("/cookie").then((response) => response.text())),
        ).toBe("iter8-alpha=isolated")
        expect(await page.evaluate(() => localStorage.getItem("iter8-alpha"))).toBe("isolated")
        await page.evaluate(async () => {
          await navigator.serviceWorker.register("/worker.js")
          await navigator.serviceWorker.ready
        })
        expect(
          await page.evaluate(() =>
            navigator.serviceWorker.getRegistrations().then((items) => items.length),
          ),
        ).toBe(1)
        expect(
          await page.evaluate(
            () =>
              new Promise<string>((resolve, reject) => {
                const socket = new WebSocket(`ws://${location.host}/echo`)
                socket.onopen = () => socket.send("iter8 echo")
                socket.onerror = () => reject(new Error("Same-origin WebSocket failed"))
                socket.onmessage = (event) => {
                  socket.close()
                  resolve(String(event.data))
                }
              }),
          ),
        ).toBe("iter8 echo")
        await page.goto(`http://beta.localhost:${port}/`)
        expect(hosts).toContain(`beta.localhost:${port}`)
        expect(
          await page.evaluate(() => fetch("/cookie").then((response) => response.text())),
        ).toBe("")
        expect(await page.evaluate(() => localStorage.getItem("iter8-alpha"))).toBeNull()
        expect(
          await page.evaluate(() =>
            navigator.serviceWorker.getRegistrations().then((items) => items.length),
          ),
        ).toBe(0)
        expect(errors).toEqual([])
      } finally {
        await close()
      }
    } finally {
      await browser.close()
    }
  } catch (cause) {
    throw new Error(`*.localhost spike failed in Chromium ${version}`, { cause })
  } finally {
    await server.stop(true)
  }
}, 30000)
