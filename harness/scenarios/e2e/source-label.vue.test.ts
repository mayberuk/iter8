import { test } from "bun:test"
import { proveSourceLabels } from "./source-label"

test(
  "picking each marked element on the vue fixture shows and returns the source confidence the fixture promises",
  () => proveSourceLabels("vue"),
  180_000,
)
