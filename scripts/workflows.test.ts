import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rmdir, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

async function readWorkflow(name: string) {
  const path = new URL(`../.github/workflows/${name}.yml`, import.meta.url)
  return workflowSchema.parse(Bun.YAML.parse(await Bun.file(path).text()))
}

test("CI installs frozen dependencies and builds before checking", async () => {
  const workflow = await readWorkflow("ci")
  expect(workflow.on).toEqual({ push: null, pull_request: null })
  const runs = workflow.jobs.check?.steps.map(({ run }) => run)
  if (!runs) throw new Error("CI check job is missing")
  const install = runs.indexOf("bun install --frozen-lockfile")
  const build = runs.indexOf("bun run build")
  const check = runs.indexOf("bun run check")
  expect(install).toBeGreaterThanOrEqual(0)
  expect(build).toBeGreaterThan(install)
  expect(check).toBeGreaterThan(build)
  expect(runs).toContain("bun run setup:browsers --with-deps")
})

test("release runs only for v* tags and waits for checks and macOS verification", async () => {
  const workflow = await readWorkflow("release")
  expect(workflow.on).toEqual({ push: { tags: ["v*"] } })
  expect(workflow.jobs.build?.needs).toBe("check")
  expect(workflow.jobs.macos?.needs).toBe("build")
  expect(workflow.jobs.publish?.needs).toEqual(["build", "macos"])
  expect(workflow.jobs.macos?.["runs-on"]).toBe("macos-latest")
  expect(workflow.jobs.check?.steps).toEqual((await readWorkflow("ci")).jobs.check?.steps)
})

test("publish uploads exactly RELEASE_ASSETS using the workflow token", async () => {
  const workflow = await readWorkflow("release")
  const publish = workflow.jobs.publish
  if (!publish) throw new Error("Release publish job is missing")
  const command = publish.steps
    .flatMap(({ run }) => run?.split("\n") ?? [])
    .find((line) => line.startsWith("gh release create "))
  if (!command) throw new Error("Release creation command is missing")
  const tokens = command.trim().split(/\s+/)
  expect(tokens.slice(0, 5)).toEqual(["gh", "release", "create", '"$TAG"', "--verify-tag"])
  expect(tokens.slice(5)).toEqual([...RELEASE_ASSETS])
  expect(publish.permissions).toEqual({ contents: "write" })
  expect(publish.env?.GH_TOKEN).toBe(`\${{ secrets.GITHUB_TOKEN }}`)
  expect(publish.env?.GH_REPO).toBe("mayberuk/iter8")
  expect(
    publish.steps.find(({ uses }) => uses?.startsWith("actions/download-artifact@"))?.with,
  ).toEqual({ name: "verified-release", path: "dist/release" })
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

const TOKEN_EXPRESSION = `\${{ secrets.CC_PLUGINS_TOKEN }}`
const WORKFLOW_TOKEN_EXPRESSION = `\${{ github.token }}`

async function pinPlugin() {
  const job = (await readWorkflow("release")).jobs["pin-plugin"]
  if (!job) throw new Error("Release pin-plugin job is missing")
  const [gate, ...gated] = job.steps
  if (!gate) throw new Error("pin-plugin has no steps")
  return { job, gate, gated }
}

async function runGate(token: string) {
  const { gate } = await pinPlugin()
  const dir = await mkdtemp(join(tmpdir(), "iter8-gate-"))
  const output = join(dir, "output")
  try {
    await Bun.write(output, "")
    const child = Bun.spawn(["bash", "-e", "-c", gate.run ?? ""], {
      env: { PATH: process.env.PATH ?? "", TOKEN: token, GITHUB_OUTPUT: output },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return { stdout, exitCode, output: await readFile(output, "utf8") }
  } finally {
    await unlink(output)
    await rmdir(dir)
  }
}

async function runDecide(tag: string, pinned: string) {
  const { gated } = await pinPlugin()
  const decide = gated.find(({ id }) => id === "decide")
  if (!decide) throw new Error("pin-plugin has no decide step")
  const dir = await mkdtemp(join(tmpdir(), "iter8-decide-"))
  const pluginDir = join(dir, "plugins", "iter8")
  const releaseJson = join(pluginDir, "release.json")
  const output = join(dir, "output")
  try {
    await mkdir(pluginDir, { recursive: true })
    await Bun.write(releaseJson, JSON.stringify({ version: pinned }))
    await Bun.write(output, "")
    const child = Bun.spawn(["bash", "-e", "-c", decide.run ?? ""], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", GITHUB_REF_NAME: tag, GITHUB_OUTPUT: output },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return { stdout, exitCode, output: await readFile(output, "utf8") }
  } finally {
    await unlink(output)
    await unlink(releaseJson)
    await rmdir(pluginDir)
    await rmdir(join(dir, "plugins"))
    await rmdir(dir)
  }
}

test("pin-plugin runs after publish on ubuntu", async () => {
  const { job } = await pinPlugin()
  expect(job.needs).toBe("publish")
  expect(job["runs-on"]).toBe("ubuntu-latest")
})

test("pin-plugin reads the token only through secrets, as step env or the checkout input", async () => {
  const { job, gate, gated } = await pinPlugin()
  const raw = await Bun.file(new URL("../.github/workflows/release.yml", import.meta.url)).text()
  const withoutSecrets = raw.replaceAll(TOKEN_EXPRESSION, "")
  expect(withoutSecrets.match(/CC_PLUGINS_TOKEN/g)?.length).toBe(1)
  expect(withoutSecrets).toContain("::notice::CC_PLUGINS_TOKEN is not set;")
  expect(gate.env).toEqual({ TOKEN: TOKEN_EXPRESSION })
  expect(gated.find(({ uses }) => uses?.startsWith("actions/checkout@"))?.with).toEqual({
    repository: "mayberuk/cc-plugins",
    token: TOKEN_EXPRESSION,
    path: "cc-plugins",
  })
  expect(gated.find(({ name }) => name === "Open the pin pull request")?.env).toEqual({
    GH_TOKEN: TOKEN_EXPRESSION,
  })
  expect(gated.find(({ name }) => name === "Pin release checksums")?.env).toEqual({
    GH_TOKEN: WORKFLOW_TOKEN_EXPRESSION,
  })
  for (const step of gated) {
    if (step.name === "Open the pin pull request" || step.uses?.startsWith("actions/checkout@"))
      continue
    expect(step.env?.GH_TOKEN ?? "", step.name).not.toBe(TOKEN_EXPRESSION)
  }
  for (const step of job.steps) expect(step.run ?? "").not.toContain("secrets.")
})

test("every pin-plugin step after the gate is conditional on it", async () => {
  const { gate, gated } = await pinPlugin()
  expect(gate.id).toBe("gate")
  expect(gated.length).toBeGreaterThan(0)
  for (const step of gated) expect(step.if).toStartWith("steps.gate.outputs.enabled == 'true'")
})

test("pin-plugin pins and opens the pull request only when decide says to", async () => {
  const { gated } = await pinPlugin()
  const decide = gated.find(({ id }) => id === "decide")
  expect(decide?.["working-directory"]).toBe("cc-plugins")
  expect(gated.indexOf(decide as (typeof gated)[number])).toBeGreaterThan(
    gated.findIndex(({ uses }) => uses?.startsWith("actions/checkout@")),
  )
  const afterDecide = gated.slice(gated.indexOf(decide as (typeof gated)[number]) + 1)
  expect(afterDecide.length).toBe(2)
  for (const step of afterDecide) {
    expect(step.if).toBe(
      "steps.gate.outputs.enabled == 'true' && steps.decide.outputs.pin == 'true'",
    )
  }
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

test("pin-plugin gate enables on a token and skips with a notice without one", async () => {
  const withToken = await runGate("token-value")
  expect(withToken.exitCode).toBe(0)
  expect(withToken.output).toBe("enabled=true\n")
  expect(withToken.stdout).not.toContain("::notice::")

  const withoutToken = await runGate("")
  expect(withoutToken.exitCode).toBe(0)
  expect(withoutToken.output).toBe("enabled=false\n")
  expect(withoutToken.stdout).toBe(
    "::notice::CC_PLUGINS_TOKEN is not set; skipping the cc-plugins pin bump\n",
  )
})

test("pin-plugin pins and bumps cc-plugins with the tag version, then opens an auto-merge PR", async () => {
  const { gated } = await pinPlugin()
  const pin = gated.find(({ name }) => name === "Pin release checksums")
  const open = gated.find(({ name }) => name === "Open the pin pull request")
  expect(pin?.["working-directory"]).toBe("cc-plugins")
  expect(open?.["working-directory"]).toBe("cc-plugins")
  const lines = [pin, open].flatMap((step) => (step?.run ?? "").split("\n").filter(Boolean))
  const at = (prefix: string) => {
    const index = lines.findIndex((line) => line.startsWith(prefix))
    expect(index, prefix).toBeGreaterThanOrEqual(0)
    return index
  }
  expect(lines[0]).toBe(`VERSION=\${GITHUB_REF_NAME#v}`)
  const order = [
    at('git switch -c "iter8-pin-$VERSION"'),
    at('plugins/iter8/scripts/pin-release.sh "$VERSION"'),
    at('scripts/release.sh iter8 patch "Pin iter8 $VERSION."'),
    at('git config user.name "github-actions[bot]"'),
    at("git add --all"),
    at("git commit"),
    at("git push -u origin HEAD"),
    at("gh pr create"),
    at("gh pr merge"),
  ]
  expect(order).toEqual([...order].sort((a, b) => a - b))
  expect(pin?.run).toContain("pin-release.sh")
  expect(pin?.run).not.toContain("gh pr")
  expect(open?.run).not.toContain("pin-release.sh")
  expect(lines[at("gh pr create")]).toBe(
    'gh pr create --repo mayberuk/cc-plugins --title "Pin iter8 $VERSION" --body "Pins the iter8 plugin to release v$VERSION."',
  )
  expect(lines[at("gh pr merge")]).toBe(
    'gh pr merge --repo mayberuk/cc-plugins --auto --squash || echo "::notice::auto-merge is not enabled on cc-plugins; merge the PR by hand"',
  )
})
