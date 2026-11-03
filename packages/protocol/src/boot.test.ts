import { expect, test } from "bun:test"
import fc from "fast-check"
import { OverlayBoot, renderBootScript } from "./boot"
import { OVERLAY_SCRIPT_PATH } from "./overlay-api"

const base = OverlayBoot.parse({
  protocolVersion: 1,
  pageId: "larkspur",
  machineId: "devhost-7f3a",
  machineName: "devhost",
  token: "q5Jx2lK9vT0wYbN3cR8mZ4hD1sF6gA7e",
  apiBase: "/__iter8",
  sourceBundleUrl: "/__iter8/assets/source.js",
})

const hostile = fc.constantFrom("</script>", "</SCRIPT ", "</ScRiPt\t", "<!--", "<script>", " ")
const anyString = fc.oneof(
  fc.string({ unit: "binary" }),
  hostile,
  fc.tuple(fc.string(), hostile, fc.string()).map((parts) => parts.join("")),
)

function bootJson(script: string): unknown {
  const call = script.split("\n")[1] ?? ""
  return JSON.parse(call.slice("mount(".length, -")".length))
}

test("the boot script imports mount from the overlay bundle", () => {
  const script = renderBootScript(base)
  expect(script.split("\n")[0]).toBe(`import { mount } from "${OVERLAY_SCRIPT_PATH}"`)
  expect(bootJson(script)).toEqual(base)
})

test("no value in any boot field can close the script, and every value survives", () => {
  fc.assert(
    fc.property(fc.constantFrom(...Object.keys(OverlayBoot.shape)), anyString, (field, value) => {
      const boot = { ...base, [field]: value } as OverlayBoot
      const script = renderBootScript(boot)
      expect(script.toLowerCase()).not.toContain("</script")
      expect(bootJson(script)).toEqual(boot)
    }),
  )
})
