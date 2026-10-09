import { expect, test } from "bun:test"
import { z } from "zod"
import { RELEASE_ASSETS } from "./release"

const stepSchema = z.object({
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
      const bunSteps = job.steps.filter(({ uses }) => uses?.startsWith("oven-sh/setup-bun@"))
      expect(bunSteps.length, jobName).toBe(1)
      expect(bunSteps[0]?.with?.["bun-version"], jobName).toBe("1.4.2")
    }
  })
}
