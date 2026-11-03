import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { z } from "zod"
import { RELEASE_ASSETS } from "./release"

const stepSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  if: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  "working-directory": z.string().optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
})
const workflowSchema = z.object({
  on: z.record(z.string(), z.unknown()),
  permissions: z.record(z.string(), z.string()),
  concurrency: z.object({ group: z.string(), "cancel-in-progress": z.boolean() }),
  jobs: z.record(
    z.string(),
    z.object({
      "runs-on": z.string(),
      needs: z.union([z.string(), z.array(z.string())]).optional(),
      permissions: z.record(z.string(), z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
      steps: z.array(stepSchema),
    }),
  ),
})

const workflowUrl = (name: string) => new URL(`../.github/workflows/${name}.yml`, import.meta.url)

async function readWorkflow(name: string) {
  return workflowSchema.parse(Bun.YAML.parse(await Bun.file(workflowUrl(name)).text()))
}

const findStep = (steps: z.infer<typeof stepSchema>[], name: string) => {
  const step = steps.find((candidate) => candidate.name === name)
  if (!step) throw new Error(`step "${name}" is missing`)
  return step
}

async function inScratch<T>(fn: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "iter8-workflow-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

type Call = string[]

// Each fake records `[its own name, ...args]` NUL-delimited, one call ended by \x01, so
// multi-line arguments such as a PR body survive.
async function writeFake(dir: string, path: string) {
  const file = join(dir, path)
  await mkdir(dirname(file), { recursive: true })
  await Bun.write(
    file,
    `#!/bin/sh\nprintf '%s\\0' "$(basename "$0")" "$@" >> "$LOG"\nprintf '\\001' >> "$LOG"\n`,
  )
  await chmod(file, 0o755)
}

async function runStep(
  dir: string,
  step: z.infer<typeof stepSchema>,
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number; calls: Call[]; output: string }> {
  const log = join(dir, "log")
  const output = join(dir, "output")
  await Bun.write(log, "")
  await Bun.write(output, "")
  const child = Bun.spawn(["bash", "-e", "-c", step.run ?? ""], {
    cwd: step["working-directory"] ? join(dir, step["working-directory"]) : dir,
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
      LOG: log,
      GITHUB_OUTPUT: output,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const calls = (await readFile(log, "utf8"))
    .split("\x01")
    .filter(Boolean)
    .map((record) => record.split("\0").slice(0, -1))
  return { stdout, stderr, exitCode, calls, output: await readFile(output, "utf8") }
}

test("CI runs on main pushes and pull requests, cancelling superseded runs", async () => {
  const workflow = await readWorkflow("ci")
  expect(workflow.on).toEqual({ push: { branches: ["main"] }, pull_request: null })
  expect(workflow.concurrency).toEqual({
    group: `ci-\${{ github.ref }}`,
    "cancel-in-progress": true,
  })
})

test("CI installs frozen dependencies and builds before checking with one test worker per core", async () => {
  const workflow = await readWorkflow("ci")
  const runs = workflow.jobs.check?.steps.map(({ run }) => run)
  if (!runs) throw new Error("CI check job is missing")
  const install = runs.indexOf("bun install --frozen-lockfile")
  const build = runs.indexOf("bun run build")
  const check = runs.indexOf("ITER8_TEST_WORKERS=$(nproc) bun run check")
  expect(install).toBeGreaterThanOrEqual(0)
  expect(build).toBeGreaterThan(install)
  expect(check).toBeGreaterThan(build)
  expect(runs).toContain("bun run setup:browsers --with-deps")
})

test("CI restores the Bun install cache and the Playwright browsers, keyed on the lockfile, before installing", async () => {
  const steps = (await readWorkflow("ci")).jobs.check?.steps ?? []
  const cacheIndex = steps.findIndex(({ uses }) => uses?.startsWith("actions/cache@"))
  expect(cacheIndex).toBeGreaterThanOrEqual(0)
  expect(cacheIndex).toBeLessThan(
    steps.findIndex(({ run }) => run === "bun install --frozen-lockfile"),
  )
  const inputs = steps[cacheIndex]?.with
  expect(String(inputs?.path)).toContain("~/.cache/ms-playwright")
  expect(String(inputs?.path)).toContain("~/.bun/install/cache")
  expect(String(inputs?.key)).toContain("hashFiles('bun.lock')")
})

test("release runs only for v* tags, never cancels, and waits for checks and macOS verification", async () => {
  const workflow = await readWorkflow("release")
  expect(workflow.on).toEqual({ push: { tags: ["v*"] } })
  expect(workflow.concurrency).toEqual({
    group: `release-\${{ github.ref }}`,
    "cancel-in-progress": false,
  })
  expect(workflow.jobs.build?.needs).toBe("check")
  expect(workflow.jobs.macos?.needs).toBe("build")
  expect(workflow.jobs.publish?.needs).toEqual(["build", "macos"])
  expect(workflow.jobs.macos?.["runs-on"]).toBe("macos-latest")
  expect(workflow.jobs.check?.steps).toEqual((await readWorkflow("ci")).jobs.check?.steps)
})

test("both workflows default to read-only contents; only publish and pin-plugin widen it", async () => {
  expect((await readWorkflow("ci")).permissions).toEqual({ contents: "read" })
  const release = await readWorkflow("release")
  expect(release.permissions).toEqual({ contents: "read" })
  const widened = Object.entries(release.jobs)
    .filter(([, job]) => job.permissions)
    .map(([name]) => name)
  expect(widened.sort()).toEqual(["pin-plugin", "publish"])
  for (const job of Object.values((await readWorkflow("ci")).jobs)) {
    expect(job.permissions).toBeUndefined()
  }
})

test("publish attests exactly RELEASE_ASSETS after verifying checksums and before releasing", async () => {
  const publish = (await readWorkflow("release")).jobs.publish
  if (!publish) throw new Error("Release publish job is missing")
  expect(publish.permissions).toEqual({
    contents: "write",
    "id-token": "write",
    attestations: "write",
  })
  const index = (match: (step: z.infer<typeof stepSchema>) => boolean) =>
    publish.steps.findIndex(match)
  const download = index(({ uses }) => uses?.startsWith("actions/download-artifact@") ?? false)
  const verify = index(({ run }) => run === "sha256sum --check SHA256SUMS")
  const attest = index(({ uses }) => uses?.startsWith("actions/attest-build-provenance@") ?? false)
  const release = index(({ run }) => run?.includes("gh release create") ?? false)
  expect(download).toBeGreaterThanOrEqual(0)
  expect(verify).toBeGreaterThan(download)
  expect(attest).toBeGreaterThan(verify)
  expect(release).toBeGreaterThan(attest)
  const subjects = String(publish.steps[attest]?.with?.["subject-path"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  expect(subjects.sort()).toEqual(RELEASE_ASSETS.map((name) => `dist/release/${name}`).sort())
})

test("publish uploads exactly RELEASE_ASSETS using the workflow token, flagging prereleases", async () => {
  const publish = (await readWorkflow("release")).jobs.publish
  if (!publish) throw new Error("Release publish job is missing")
  expect(publish.env?.GH_TOKEN).toBe(`\${{ secrets.GITHUB_TOKEN }}`)
  expect(publish.env?.GH_REPO).toBe("mayberuk/iter8")
  expect(
    publish.steps.find(({ uses }) => uses?.startsWith("actions/download-artifact@"))?.with,
  ).toEqual({ name: "verified-release", path: "dist/release" })

  const step = findStep(publish.steps, "Publish release")
  expect(step["working-directory"]).toBe("dist/release")
  const cases: [string, string[]][] = [
    ["v1.2.3", []],
    ["v1.2.3-rc.1", ["--prerelease"]],
    ["v0.4.0-beta", ["--prerelease"]],
  ]
  for (const [tag, flags] of cases) {
    await inScratch(async (dir) => {
      await writeFake(dir, "bin/gh")
      await mkdir(join(dir, "dist/release"), { recursive: true })
      const result = await runStep(dir, step, { TAG: tag })
      expect(result.exitCode, tag).toBe(0)
      expect(result.calls, tag).toEqual([
        ["gh", "release", "create", tag, "--verify-tag", ...flags, ...RELEASE_ASSETS],
      ])
    })
  }
})

test("build job compiles the release and macos verifies and re-uploads exactly RELEASE_ASSETS", async () => {
  const workflow = await readWorkflow("release")
  const upload = (job: string, artifact: string) =>
    workflow.jobs[job]?.steps.find(
      ({ uses, with: inputs }) =>
        uses?.startsWith("actions/upload-artifact@") && inputs?.name === artifact,
    )
  const assetPaths = (step: z.infer<typeof stepSchema> | undefined) =>
    String(step?.with?.path ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .sort()
  const expected = RELEASE_ASSETS.map((name) => `dist/release/${name}`).sort()

  expect(workflow.jobs.build?.steps.map(({ run }) => run)).toContain(
    'bun run release -- --tag "$TAG" --out dist/release',
  )
  expect(assetPaths(upload("build", "compiled-release"))).toEqual(expected)
  expect(
    workflow.jobs.macos?.steps.find(({ uses }) => uses?.startsWith("actions/download-artifact@"))
      ?.with,
  ).toEqual({ name: "compiled-release", path: "dist/release" })
  expect(assetPaths(upload("macos", "verified-release"))).toEqual(expected)
})

for (const name of ["ci", "release"]) {
  test(`every ${name} job pins Bun 1.4.2`, async () => {
    const workflow = await readWorkflow(name)
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      if (jobName === "pin-plugin") continue
      const bunSteps = job.steps.filter(({ uses }) => uses?.startsWith("oven-sh/setup-bun@"))
      expect(bunSteps.length, jobName).toBe(1)
      expect(bunSteps[0]?.with?.["bun-version"], jobName).toBe("1.4.2")
    }
  })
}

test("every action is pinned to a full commit SHA with its version in a trailing comment", async () => {
  const shaByAction = new Map<string, string>()
  let pinned = 0
  for (const name of ["ci", "release"]) {
    const text = await Bun.file(workflowUrl(name)).text()
    const lines = text.split("\n").filter((line) => /^\s*(-\s+)?uses:/.test(line))
    const parsedUses = Object.values((await readWorkflow(name)).jobs)
      .flatMap((job) => job.steps)
      .filter(({ uses }) => uses).length
    expect(lines.length, name).toBe(parsedUses)
    for (const line of lines) {
      const match = line.match(/uses:\s*([\w.-]+\/[\w.-]+)@([0-9a-f]{40}) # v\d+\.\d+\.\d+$/)
      expect(match, line).not.toBeNull()
      const [, action, sha] = match ?? []
      expect(shaByAction.get(action ?? "") ?? sha, `${action} differs between workflows`).toBe(sha)
      shaByAction.set(action ?? "", sha ?? "")
      pinned += 1
    }
  }
  expect(pinned).toBeGreaterThan(0)
})

test("dependabot checks github-actions and bun weekly at the repo root", async () => {
  const config = z
    .object({
      version: z.literal(2),
      updates: z.array(
        z.object({
          "package-ecosystem": z.string(),
          directory: z.string(),
          schedule: z.object({ interval: z.string() }),
        }),
      ),
    })
    .parse(
      Bun.YAML.parse(await Bun.file(new URL("../.github/dependabot.yml", import.meta.url)).text()),
    )
  expect(config.updates.map((update) => update["package-ecosystem"]).sort()).toEqual([
    "bun",
    "github-actions",
  ])
  for (const update of config.updates) {
    expect(update.directory).toBe("/")
    expect(update.schedule.interval).toBe("weekly")
  }
})

async function pinPlugin() {
  const job = (await readWorkflow("release")).jobs["pin-plugin"]
  if (!job) throw new Error("Release pin-plugin job is missing")
  const [checkout, decide, pin, open] = job.steps
  if (!(checkout && decide && pin && open) || job.steps.length !== 4) {
    throw new Error("pin-plugin should be checkout, decide, pin, open")
  }
  return { job, checkout, decide, pin, open }
}

async function runDecide(tag: string, pinned: string) {
  const { decide } = await pinPlugin()
  return inScratch(async (dir) => {
    await mkdir(join(dir, "plugins/iter8"), { recursive: true })
    await Bun.write(join(dir, "plugins/iter8/release.json"), JSON.stringify({ version: pinned }))
    return runStep(dir, decide, { GITHUB_REF_NAME: tag })
  })
}

test("pin-plugin runs after publish on ubuntu with only the access it needs", async () => {
  const { job } = await pinPlugin()
  expect(job.needs).toBe("publish")
  expect(job["runs-on"]).toBe("ubuntu-latest")
  expect(job.permissions).toEqual({ contents: "write", "pull-requests": "write" })
})

test("pin-plugin stays inside this repo and uses no secret other than the workflow token", async () => {
  const raw = await Bun.file(workflowUrl("release")).text()
  expect(raw).not.toContain("CC_PLUGINS_TOKEN")
  const { job, checkout } = await pinPlugin()
  expect(job.env).toEqual({ GH_TOKEN: `\${{ github.token }}` })
  expect(JSON.stringify(job)).not.toContain("secrets.")
  expect(checkout.with).toEqual({ ref: `\${{ github.event.repository.default_branch }}` })
  expect(checkout.uses).toStartWith("actions/checkout@")
})

test("pin-plugin pins and opens the pull request only when decide says to", async () => {
  const { decide, pin, open } = await pinPlugin()
  expect(decide.id).toBe("decide")
  expect(decide.if).toBeUndefined()
  for (const step of [pin, open]) expect(step.if).toBe("steps.decide.outputs.pin == 'true'")
})

test("pin-plugin skips a prerelease tag with a notice", async () => {
  for (const tag of ["v1.0.0-rc.1", "v0.4.0-beta"]) {
    const result = await runDecide(tag, "0.1.0")
    expect(result.exitCode, tag).toBe(0)
    expect(result.output, tag).toBe("pin=false\n")
    expect(result.stdout, tag).toContain("::notice::")
    expect(result.stdout, tag).toContain("prerelease")
  }
})

test("pin-plugin skips a version that is not strictly newer than the pinned one", async () => {
  const skipped: [string, string][] = [
    ["v0.1.0", "0.1.0"],
    ["v0.1.9", "0.1.10"],
    ["v0.9.0", "0.10.0"],
    ["v1.2.3", "2.0.0"],
    ["v0.3.0", "0.3.1"],
  ]
  for (const [tag, pinned] of skipped) {
    const result = await runDecide(tag, pinned)
    expect(result.exitCode, `${tag} vs ${pinned}`).toBe(0)
    expect(result.output, `${tag} vs ${pinned}`).toBe("pin=false\n")
    expect(result.stdout, `${tag} vs ${pinned}`).toContain("::notice::")
    expect(result.stdout, `${tag} vs ${pinned}`).toContain("not newer")
  }
})

test("pin-plugin proceeds for a stable tag that is newer, comparing numerically per field", async () => {
  const proceed: [string, string][] = [
    ["v0.1.10", "0.1.9"],
    ["v0.10.0", "0.9.0"],
    ["v1.0.0", "0.99.99"],
    ["v0.3.1", "0.3.0"],
  ]
  for (const [tag, pinned] of proceed) {
    const result = await runDecide(tag, pinned)
    expect(result.exitCode, `${tag} vs ${pinned}`).toBe(0)
    expect(result.output, `${tag} vs ${pinned}`).toBe("pin=true\n")
    expect(result.stdout, `${tag} vs ${pinned}`).not.toContain("::notice::")
  }
})

test("pin-plugin branches, runs the pin script with the tag version and bumps the plugin patch version in the manifest and the marketplace", async () => {
  const { pin } = await pinPlugin()
  await inScratch(async (dir) => {
    await writeFake(dir, "bin/git")
    await writeFake(dir, "plugins/iter8/scripts/pin-release.sh")
    const manifest = join(dir, "plugins/iter8/.claude-plugin/plugin.json")
    await mkdir(dirname(manifest), { recursive: true })
    await Bun.write(manifest, JSON.stringify({ name: "iter8", version: "0.3.9" }))
    const marketplace = join(dir, ".claude-plugin/marketplace.json")
    await mkdir(dirname(marketplace), { recursive: true })
    await Bun.write(
      marketplace,
      JSON.stringify({
        name: "iter8",
        plugins: [
          { name: "other", version: "5.0.0" },
          { name: "iter8", version: "0.3.9" },
        ],
      }),
    )

    const result = await runStep(dir, pin, { GITHUB_REF_NAME: "v0.4.0" })
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.calls).toEqual([
      ["git", "switch", "-c", "iter8-pin-0.4.0"],
      ["pin-release.sh", "0.4.0"],
    ])
    expect(JSON.parse(await readFile(manifest, "utf8"))).toEqual({
      name: "iter8",
      version: "0.3.10",
    })
    expect(JSON.parse(await readFile(marketplace, "utf8"))).toEqual({
      name: "iter8",
      plugins: [
        { name: "other", version: "5.0.0" },
        { name: "iter8", version: "0.3.10" },
      ],
    })
  })
})

test("pin-plugin commits the plugin folder and opens a pull request that asks for CI approval and never enables auto-merge", async () => {
  const { open } = await pinPlugin()
  await inScratch(async (dir) => {
    await writeFake(dir, "bin/git")
    await writeFake(dir, "bin/gh")
    const result = await runStep(dir, open, { GITHUB_REF_NAME: "v0.4.0", BASE: "main" })
    expect(result.exitCode, result.stderr).toBe(0)

    const gh = result.calls.filter(([tool]) => tool === "gh")
    expect(gh.length).toBe(1)
    const [, ...args] = gh[0] ?? []
    expect(args.slice(0, 6)).toEqual([
      "pr",
      "create",
      "--base",
      "main",
      "--title",
      "Pin iter8 0.4.0",
    ])
    expect(args[6]).toBe("--body")
    expect(args[7]).toContain("v0.4.0")
    expect(args[7]).toContain("Approve workflows to run")
    expect(args).not.toContain("merge")
    expect(args).not.toContain("--auto")

    const git = result.calls.filter(([tool]) => tool === "git").map(([, ...rest]) => rest)
    expect(git).toEqual([
      ["config", "user.name", "github-actions[bot]"],
      ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"],
      ["add", "plugins/iter8", ".claude-plugin/marketplace.json"],
      ["commit", "-m", "Pin iter8 0.4.0"],
      ["push", "-u", "origin", "HEAD"],
    ])
    const order = result.calls.map(([tool]) => tool)
    expect(order.lastIndexOf("git")).toBeLessThan(order.indexOf("gh"))
  })
})
