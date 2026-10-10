import { test } from "bun:test"
import { proveSourceLabels } from "./source-label"

test(
  "picking each marked element on the next-webpack fixture shows and returns the source confidence the fixture promises",
  () => proveSourceLabels("next-webpack"),
  180_000,
)
