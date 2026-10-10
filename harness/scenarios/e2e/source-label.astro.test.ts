import { test } from "bun:test"
import { proveSourceLabels } from "./source-label"

test(
  "picking each marked element on the astro fixture shows and returns the source confidence the fixture promises",
  () => proveSourceLabels("astro"),
  180_000,
)
