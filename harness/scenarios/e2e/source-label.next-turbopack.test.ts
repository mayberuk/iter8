import { test } from "bun:test"
import { proveSourceLabels } from "./source-label"

test(
  "picking each marked element on the next-turbopack fixture shows and returns the source confidence the fixture promises",
  () => proveSourceLabels("next-turbopack"),
  180_000,
)
