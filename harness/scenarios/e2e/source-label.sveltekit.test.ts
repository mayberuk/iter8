import { test } from "bun:test"
import { proveSourceLabels } from "./source-label"

test(
  "picking each marked element on the sveltekit fixture shows and returns the source confidence the fixture promises",
  () => proveSourceLabels("sveltekit"),
  180_000,
)
