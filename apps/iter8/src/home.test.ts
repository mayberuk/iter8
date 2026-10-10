import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { CONFIG_FILE, DEFAULT_POOL, ENV, ServiceConfig } from "@iter8/protocol"
import { poolPorts, readServiceConfig, resolvePaths } from "./home"

const directories: string[] = []

afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

async function temporaryHome() {
  const directory = await mkdtemp(join(tmpdir(), "iter8-"))
  directories.push(directory)
  return resolvePaths({ [ENV.home]: join(directory, "state") })
}

function expandRange(range: string) {
  const [first, last] = range.split("-").map(Number)
  return Array.from({ length: Number(last) - Number(first) + 1 }, (_, i) => Number(first) + i)
}

test("state paths all live under ITER8_HOME", () => {
  const home = join(tmpdir(), "iter8-paths")
  expect(resolvePaths({ [ENV.home]: home })).toEqual({
    home,
    db: join(home, "iter8.db"),
    controlSocket: join(home, "control.sock"),
    lock: join(home, "service.lock"),
    log: join(home, "service.log"),
    config: join(home, CONFIG_FILE),
  })
})

test("an unset ITER8_HOME uses the user's home directory", () => {
  expect(resolvePaths({}).home).toBe(join(homedir(), ".iter8"))
})

test("an empty ITER8_HOME is treated as unset", () => {
  expect(resolvePaths({ [ENV.home]: "" })).toEqual(resolvePaths({}))
  expect(resolvePaths({ [ENV.home]: "" }).home).toBe(join(homedir(), ".iter8"))
})

for (const platform of ["linux", "darwin", "win32"] as const) {
  test(`missing config on ${platform} writes the default pool with private permissions`, async () => {
    const paths = await temporaryHome()
    const expectedPool = platform === "darwin" ? DEFAULT_POOL.darwin : DEFAULT_POOL.linux
    const config = await readServiceConfig(paths, platform)
    expect(config).toEqual({ pool: expectedPool })
    expect(JSON.parse(await readFile(paths.config, "utf8"))).toEqual({ pool: expectedPool })
    expect((await stat(paths.config)).mode & 0o777).toBe(0o600)
    expect((await stat(paths.home)).mode & 0o777).toBe(0o700)
    expect(poolPorts({}, config)).toEqual(expandRange(expectedPool))
  })
}

test("an existing config is parsed without rewriting it", async () => {
  const paths = await temporaryHome()
  await mkdir(paths.home)
  const original = '{ "pool": "4100-4102", "unused": true }'
  await writeFile(paths.config, original)
  expect(await readServiceConfig(paths, "darwin")).toEqual({ pool: "4100-4102" })
  expect(await readFile(paths.config, "utf8")).toBe(original)
})

for (const invalid of ["{", "null", "{}", '{"pool":42}', '{"pool":"4102-4100"}']) {
  test(`invalid config ${invalid} fails with its filename and stays intact`, async () => {
    const paths = await temporaryHome()
    await mkdir(paths.home)
    await writeFile(paths.config, invalid)
    await expect(readServiceConfig(paths, "linux")).rejects.toThrow(paths.config)
    expect(await readFile(paths.config, "utf8")).toBe(invalid)
  })
}

test("ITER8_POOL overrides the config and includes both endpoints", () => {
  const config = ServiceConfig.parse({ pool: DEFAULT_POOL.linux })
  const override = "5200-5203"
  expect(poolPorts({ [ENV.pool]: override }, config)).toEqual(expandRange(override))
  expect(poolPorts({ [ENV.pool]: undefined }, config)).toEqual(expandRange(DEFAULT_POOL.linux))
})

for (const range of ["1-1", "65535-65535", "1-3"]) {
  test(`pool ${range} accepts valid port boundaries and singleton ranges`, () => {
    expect(poolPorts({ [ENV.pool]: range }, { pool: DEFAULT_POOL.darwin })).toEqual(
      expandRange(range),
    )
  })
}

for (const range of ["", "3990", "3990:3993", "0-1", "2-1", "1-65536", "1-2-3", " 1-2"]) {
  test(`invalid override ${JSON.stringify(range)} fails naming ITER8_POOL`, () => {
    expect(() => poolPorts({ [ENV.pool]: range }, { pool: DEFAULT_POOL.linux })).toThrow(ENV.pool)
  })
}
