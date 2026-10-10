import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { CONFIG_FILE, DEFAULT_POOL, ENV, PortRange, ServiceConfig } from "@iter8/protocol"

export type Iter8Paths = {
  home: string
  db: string
  controlSocket: string
  lock: string
  log: string
  config: string
}

export function resolvePaths(env: Record<string, string | undefined>): Iter8Paths {
  const home = env[ENV.home] || join(homedir(), ".iter8")
  return {
    home,
    db: join(home, "iter8.db"),
    controlSocket: join(home, "control.sock"),
    lock: join(home, "service.lock"),
    log: join(home, "service.log"),
    config: join(home, CONFIG_FILE),
  }
}

export async function readServiceConfig(
  paths: Iter8Paths,
  platform: NodeJS.Platform,
): Promise<ServiceConfig> {
  let text: string
  try {
    text = await readFile(paths.config, "utf8")
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    const config = ServiceConfig.parse({
      pool: platform === "darwin" ? DEFAULT_POOL.darwin : DEFAULT_POOL.linux,
    })
    await mkdir(paths.home, { recursive: true, mode: 0o700 })
    await writeFile(paths.config, `${JSON.stringify(config)}\n`, { mode: 0o600 })
    return config
  }
  try {
    return ServiceConfig.parse(JSON.parse(text))
  } catch (cause) {
    throw new Error(`Invalid service config in ${paths.config}`, { cause })
  }
}

export function poolPorts(
  env: Record<string, string | undefined>,
  config: ServiceConfig,
): number[] {
  const override = env[ENV.pool]
  const parsed = PortRange.safeParse(override === undefined ? config.pool : override)
  if (!parsed.success) {
    throw new Error(`Invalid port range in ${override === undefined ? "config.pool" : ENV.pool}`, {
      cause: parsed.error,
    })
  }
  const [first, last] = parsed.data.split("-")
  const start = Number(first)
  return Array.from({ length: Number(last) - start + 1 }, (_, index) => start + index)
}
